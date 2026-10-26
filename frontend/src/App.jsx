import { useEffect, useRef, useState } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import UserList from './components/UserList.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import {
  getDirectMessages,
  getOrCreateDirectConversation,
  logout,
} from './api.js';
import { appendUnique } from './messages.js';
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
    if (session) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Storage may be unavailable.
  }
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [peer, setPeer] = useState(null);
  const [messages, setMessages] = useState({});
  const [unread, setUnread] = useState({});
  const [status, setStatus] = useState('connecting');
  const [notice, setNotice] = useState(null);

  const connection = useRef(null);
  const peerRef = useRef(null);
  const prevStatus = useRef('connecting');

  useEffect(() => {
    peerRef.current = peer;
  }, [peer]);

  // Show unread message count in the browser tab title.
  useEffect(() => {
    const total = Object.values(unread).reduce(
      (sum, count) => sum + count,
      0,
    );

    document.title = total > 0
      ? `(${total}) ${APP_TITLE}`
      : APP_TITLE;
  }, [unread]);

  // Connection status notifications.
  useEffect(() => {
    const previous = prevStatus.current;
    prevStatus.current = status;

    if (
      status === 'connected' &&
      (previous === 'reconnecting' || previous === 'disconnected')
    ) {
      setNotice({ kind: 'ok', text: 'You are back online.' });
    } else if (
      status === 'reconnecting' &&
      previous === 'connected'
    ) {
      setNotice({
        kind: 'warn',
        text: 'Connection lost. Trying to reconnect…',
      });
    } else if (status === 'disconnected') {
      setNotice({
        kind: 'warn',
        text: 'The server closed your connection. Log out and log in again.',
      });
    }
  }, [status]);

  useEffect(() => {
    if (!notice) return undefined;

    const timer = setTimeout(() => setNotice(null), 4000);

    return () => clearTimeout(timer);
  }, [notice]);

  // Connect the authenticated user to Socket.IO.
  useEffect(() => {
    if (!session) return undefined;

    const conn = connectSocket(session.token, session.user, {
      onStatus: setStatus,

      onMessage: (message) => {
        const senderId = message.from;

        setMessages((previous) => ({
          ...previous,
          [senderId]: appendUnique(
            previous[senderId] || [],
            message,
          ),
        }));

        if (peerRef.current?.id !== senderId) {
          setUnread((previous) => ({
            ...previous,
            [senderId]: (previous[senderId] || 0) + 1,
          }));
        }
      },
    });

    connection.current = conn;

    return () => {
      conn.disconnect();
      connection.current = null;
    };
  }, [session]);

  function handleAuth(newSession) {
    saveSession(newSession);
    setSession(newSession);
  }

  function handleLogout() {
    // Clear the local session even if server logout fails.
    logout(session.token).catch(() => {});

    saveSession(null);
    setSession(null);
    setPeer(null);
    setMessages({});
    setUnread({});
    setNotice(null);
  }

  // CHATAPP-11: open a conversation and restore saved history.
  async function handleSelect(user) {
    try {
      await getOrCreateDirectConversation(user.id, session.token);

      const history = await getDirectMessages(user.id, session.token);

      // Merge persisted history with live messages received while fetching.
      // Deduplicate by message ID and sort chronologically.
      setMessages((previous) => {
        const combined = [
          ...(Array.isArray(history) ? history : []),
          ...(previous[user.id] || []),
        ];

        const unique = new Map();

        for (const message of combined) {
          if (message?.id) {
            unique.set(message.id, message);
          }
        }

        const restored = [...unique.values()].sort(
          (a, b) =>
            new Date(a.timestamp).getTime() -
            new Date(b.timestamp).getTime(),
        );

        return {
          ...previous,
          [user.id]: restored,
        };
      });

      setPeer(user);
      setUnread((previous) => ({
        ...previous,
        [user.id]: 0,
      }));
      setNotice(null);
    } catch (error) {
      setNotice({
        kind: 'warn',
        text: `Could not open conversation: ${error.message}`,
      });
    }
  }

  function patchMessage(peerId, id, patch) {
    setMessages((previous) => ({
      ...previous,
      [peerId]: (previous[peerId] || []).map((message) =>
        message.id === id
          ? { ...message, ...patch }
          : message,
      ),
    }));
  }

  async function deliver(peerId, tempId, content) {
    try {
      if (!connection.current) {
        throw new Error('Not connected to the messaging server.');
      }

      // tempId is also the clientId used to deduplicate retries.
      const saved = await connection.current.sendMessage(
        peerId,
        content,
        tempId,
      );

      patchMessage(peerId, tempId, {
        ...saved,
        state: 'sent',
        error: undefined,
      });
    } catch (error) {
      patchMessage(peerId, tempId, {
        state: 'failed',
        error: error.message,
      });
    }
  }

  function handleSend(content) {
    if (!peer) return;

    const peerId = peer.id;
    const tempId =
      `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const pending = {
      id: tempId,
      from: session.user.id,
      to: peerId,
      content,
      timestamp: new Date().toISOString(),
      state: 'sending',
    };

    setMessages((previous) => ({
      ...previous,
      [peerId]: [
        ...(previous[peerId] || []),
        pending,
      ],
    }));

    deliver(peerId, tempId, content);
  }

  function handleRetry(message) {
    if (!peer) return;

    patchMessage(peer.id, message.id, {
      state: 'sending',
      error: undefined,
    });

    deliver(peer.id, message.id, message.content);
  }

  if (!session) {
    return <AuthScreen onAuth={handleAuth} />;
  }

  return (
    <div className={`app ${peer ? 'has-peer' : ''}`}>
      <aside className="sidebar">
        <header className="me">
          <div>
            <div className="me-name">
              {session.user.username}
            </div>

            <div
              className={`conn conn-${status}`}
              role="status"
              data-testid="connection-status"
            >
              {STATUS_LABEL[status]}
            </div>
          </div>

          <button
            type="button"
            className="link"
            onClick={handleLogout}
            data-testid="logout-button"
          >
            Log out
          </button>
        </header>

        <UserList
          token={session.token}
          meId={session.user.id}
          selectedId={peer?.id}
          unread={unread}
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
        />
      </main>

      {notice && (
        <div
          className={`toast toast-${notice.kind}`}
          role="status"
          data-testid="toast"
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}