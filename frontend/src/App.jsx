import { useEffect, useRef, useState } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import UserList from './components/UserList.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import { getOrCreateDirectConversation, logout } from './api.js';
import { fetchHistory } from './history.js';
import { appendUnique, mergeHistory } from './messages.js';
import { connectSocket } from './socket.js';

const APP_TITLE = 'Team 5 Chat';
const SESSION_KEY = 'chat-session';
const STATUS_LABEL = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable: the user just logs in again after a refresh */
  }
}

// Unique id for each message. The server uses it (clientId) to ignore a retry of a message it already saved.
function newClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [peer, setPeer] = useState(null);
  const [messages, setMessages] = useState({}); // { [peerId]: [message] }
  const [unread, setUnread] = useState({}); // { [peerId]: count }
  const [status, setStatus] = useState('connecting');
  const [presence, setPresence] = useState({}); // { [userId]: true | false }
  const [refreshKey, setRefreshKey] = useState(0);
  const [historyState, setHistoryState] = useState({}); // { [peerId]: 'loading' | 'loaded' | 'error' }
  const [notice, setNotice] = useState(null); // { kind: 'ok' | 'warn', text }
  const connection = useRef(null);
  const peerRef = useRef(null);
  const prevStatus = useRef('connecting');

  useEffect(() => {
    peerRef.current = peer;
  }, [peer]);

  // Show the number of unread messages in the browser tab title.
  useEffect(() => {
    const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
    document.title = total > 0 ? `(${total}) ${APP_TITLE}` : APP_TITLE;
  }, [unread]);

  // Short pop-up when the connection is lost or comes back (SAD 4.5). The banner in the chat stays until it is fixed.
  useEffect(() => {
    const previous = prevStatus.current;
    prevStatus.current = status;
    if (status === 'connected' && (previous === 'reconnecting' || previous === 'disconnected')) {
      setNotice({ kind: 'ok', text: 'You are back online.' });
      // Fill in anything that arrived while the connection was down.
      if (peerRef.current) openConversation(peerRef.current.id);
    } else if (status === 'reconnecting' && previous === 'connected') {
      setNotice({ kind: 'warn', text: 'Connection lost. Trying to reconnect…' });
    } else if (status === 'disconnected') {
      setNotice({ kind: 'warn', text: 'The server closed your connection. Log out and log in again.' });
    }
  }, [status]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!session) return undefined;
    const conn = connectSocket(session.token, session.user, {
      onStatus: setStatus,
      onPresence: ({ userId, online }) => setPresence((prev) => ({ ...prev, [userId]: online })),
      onMessage: (msg) => {
        setMessages((prev) => ({ ...prev, [msg.from]: appendUnique(prev[msg.from] || [], msg) }));
        if (peerRef.current?.id !== msg.from) {
          setUnread((prev) => ({ ...prev, [msg.from]: (prev[msg.from] || 0) + 1 }));
        }
      },
    });
    connection.current = conn;
    return () => {
      conn.disconnect();
      connection.current = null;
    };
  }, [session]);

  // After every (re)connect, drop old presence data and reload the user list so nothing is stale.
  useEffect(() => {
    if (status === 'connected') {
      setPresence({});
      setRefreshKey((key) => key + 1);
    }
  }, [status]);

  function handleAuth(newSession) {
    saveSession(newSession);
    setSession(newSession);
  }

  function handleLogout() {
    // CHAT-F-002: ask the server to invalidate the session. Clear the local session either way.
    logout(session.token).catch(() => {});
    saveSession(null);
    setSession(null);
    setPeer(null);
    setMessages({});
    setUnread({});
    setHistoryState({});
    setNotice(null);
  }

  // The backend only accepts messages for a conversation that exists, so open it first (this is safe to repeat).
  // Then load the saved messages (CHAT-F-011) and merge them with what is already on screen.
  async function openConversation(peerId) {
    setHistoryState((prev) => ({ ...prev, [peerId]: 'loading' }));
    try {
      await getOrCreateDirectConversation(peerId, session.token);
      const history = await fetchHistory(peerId, session.token, session.user.id);
      setMessages((prev) => ({ ...prev, [peerId]: mergeHistory(history, prev[peerId] || []) }));
      setHistoryState((prev) => ({ ...prev, [peerId]: 'loaded' }));
    } catch (err) {
      setHistoryState((prev) => ({ ...prev, [peerId]: 'error' }));
      setNotice({ kind: 'warn', text: err.message });
    }
  }

  function handleSelect(user) {
    setPeer(user);
    setUnread((prev) => ({ ...prev, [user.id]: 0 }));
    const state = historyState[user.id];
    if (!state || state === 'error') openConversation(user.id);
  }

  function patchMessage(peerId, id, patch) {
    setMessages((prev) => ({
      ...prev,
      [peerId]: (prev[peerId] || []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  }

  async function deliver(peerId, tempId, content) {
    try {
      // tempId doubles as clientId so the server can recognise a retry.
      const saved = await connection.current.sendMessage(peerId, content, tempId);
      patchMessage(peerId, tempId, { ...saved, state: 'sent', error: undefined });
    } catch (err) {
      patchMessage(peerId, tempId, { state: 'failed', error: err.message });
    }
  }

  function handleSend(content) {
    const peerId = peer.id;
    const tempId = `tmp-${newClientId()}`;
    const pending = {
      id: tempId,
      from: session.user.id,
      to: peerId,
      content,
      timestamp: new Date().toISOString(),
      state: 'sending',
    };
    setMessages((prev) => ({ ...prev, [peerId]: [...(prev[peerId] || []), pending] }));
    deliver(peerId, tempId, content);
  }

  function handleRetry(message) {
    patchMessage(peer.id, message.id, { state: 'sending', error: undefined });
    deliver(peer.id, message.id, message.content);
  }

  if (!session) return <AuthScreen onAuth={handleAuth} />;

  return (
    <div className={`app ${peer ? 'has-peer' : ''}`}>
      <aside className="sidebar">
        <header className="me">
          <div>
            <div className="me-name">{session.user.displayName || session.user.username}</div>
            <div className={`conn conn-${status}`} role="status" data-testid="connection-status">
              {STATUS_LABEL[status]}
            </div>
          </div>
          <button type="button" className="link" onClick={handleLogout} data-testid="logout-button">
            Log out
          </button>
        </header>
        <UserList
          token={session.token}
          meId={session.user.id}
          selectedId={peer?.id}
          unread={unread}
          presence={presence}
          refreshKey={refreshKey}
          onSelect={handleSelect}
        />
      </aside>
      <main className="main">
        <ChatWindow
          key={peer?.id ?? 'none'}
          peer={peer}
          me={session.user}
          messages={peer ? messages[peer.id] || [] : []}
          status={status}
          onSend={handleSend}
          onRetry={handleRetry}
          onBack={() => setPeer(null)}
          historyState={peer ? historyState[peer.id] : undefined}
          onReloadHistory={() => openConversation(peer.id)}
        />
      </main>
      {notice && (
        <div className={`toast toast-${notice.kind}`} role="status" data-testid="toast">
          {notice.text}
        </div>
      )}
    </div>
  );
}