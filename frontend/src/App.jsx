import { useEffect, useRef, useState } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import UserList from './components/UserList.jsx';
import GroupList from './components/GroupList.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import { getOrCreateDirectConversation, logout } from './api.js';
import { fetchRoomMessages, listRooms } from './groups.js';
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

// A group is shown in the chat window like a person. Its id is "room:<id>" so it never clashes with a user id.
function groupPeer(room) {
  return {
    id: `room:${room.id}`,
    roomId: room.id,
    isGroup: true,
    username: room.name,
    displayName: room.name,
    memberCount: room.members.length,
    memberNames: Object.fromEntries(room.members.map((m) => [m.id, m.username])),
  };
}

// Where a message is sent: a user id for a chat, or { roomId } for a group.
function targetFor(peer) {
  return peer.isGroup ? { roomId: peer.roomId } : peer.id;
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [peer, setPeer] = useState(null); // the open chat: a user or a group
  const [messages, setMessages] = useState({}); // { [peer.id]: [message] }
  const [unread, setUnread] = useState({}); // { [peer.id]: count }
  const [status, setStatus] = useState('connecting');
  const [presence, setPresence] = useState({}); // { [userId]: true | false }
  const [refreshKey, setRefreshKey] = useState(0);
  const [historyState, setHistoryState] = useState({}); // { [peer.id]: 'loading' | 'loaded' | 'error' }
  const [tab, setTab] = useState('chats'); // 'chats' | 'groups'
  const [rooms, setRooms] = useState([]);
  const [roomsState, setRoomsState] = useState('idle'); // 'idle' | 'loading' | 'ready' | 'error'
  const [notice, setNotice] = useState(null); // { kind: 'ok' | 'warn', text }
  const connection = useRef(null);
  const peerRef = useRef(null);
  const roomsRef = useRef([]);
  const prevStatus = useRef('connecting');

  useEffect(() => {
    peerRef.current = peer;
  }, [peer]);

  useEffect(() => {
    roomsRef.current = rooms;
  }, [rooms]);

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
      if (peerRef.current) openConversation(peerRef.current);
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
        // One-to-one messages also carry a roomId, so only treat it as a group if we know that room.
        const room = roomsRef.current.find((r) => r.id === String(msg.roomId));
        const key = room ? `room:${room.id}` : msg.from;
        setMessages((prev) => ({ ...prev, [key]: appendUnique(prev[key] || [], msg) }));
        if (peerRef.current?.id !== key) {
          setUnread((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
        }
      },
    });
    connection.current = conn;
    return () => {
      conn.disconnect();
      connection.current = null;
    };
  }, [session]);

  // After every (re)connect, drop old presence data, reload the user list and quietly reload the groups.
  useEffect(() => {
    if (status === 'connected') {
      setPresence({});
      setRefreshKey((key) => key + 1);
      loadRooms(true);
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
    setRooms([]);
    setRoomsState('idle');
    setTab('chats');
    setNotice(null);
  }

  // CHAT-F-008: the groups this user belongs to. "silent" skips the error pop-up (used in the background).
  async function loadRooms(silent = false) {
    setRoomsState('loading');
    try {
      setRooms(await listRooms(session.token));
      setRoomsState('ready');
    } catch (err) {
      setRoomsState('error');
      if (!silent) setNotice({ kind: 'warn', text: err.message });
    }
  }

  // Load the saved messages (CHAT-F-011) and merge them with what is already on screen.
  // For a one-to-one chat the backend needs the conversation to exist first, so open it (safe to repeat).
  async function openConversation(target) {
    const key = target.id;
    setHistoryState((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      let history;
      if (target.isGroup) {
        history = await fetchRoomMessages(target.roomId, session.token);
      } else {
        await getOrCreateDirectConversation(target.id, session.token);
        history = await fetchHistory(target.id, session.token, session.user.id);
      }
      setMessages((prev) => ({ ...prev, [key]: mergeHistory(history, prev[key] || []) }));
      setHistoryState((prev) => ({ ...prev, [key]: 'loaded' }));
    } catch (err) {
      setHistoryState((prev) => ({ ...prev, [key]: 'error' }));
      setNotice({ kind: 'warn', text: err.message });
    }
  }

  function handleSelect(target) {
    setPeer(target);
    setUnread((prev) => ({ ...prev, [target.id]: 0 }));
    const state = historyState[target.id];
    if (!state || state === 'error') openConversation(target);
  }

  function handleGroupCreated(room) {
    setRooms((prev) => [room, ...prev.filter((r) => r.id !== room.id)]);
    setRoomsState('ready');
    handleSelect(groupPeer(room));
  }

  function patchMessage(key, id, patch) {
    setMessages((prev) => ({
      ...prev,
      [key]: (prev[key] || []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }));
  }

  async function deliver(key, tempId, content, target) {
    try {
      // tempId doubles as clientId so the server can recognise a retry.
      const saved = await connection.current.sendMessage(target, content, tempId);
      patchMessage(key, tempId, { ...saved, state: 'sent', error: undefined });
    } catch (err) {
      patchMessage(key, tempId, { state: 'failed', error: err.message });
    }
  }

  function handleSend(content) {
    const key = peer.id;
    const tempId = `tmp-${newClientId()}`;
    const pending = {
      id: tempId,
      from: session.user.id,
      to: peer.isGroup ? undefined : key,
      roomId: peer.isGroup ? peer.roomId : undefined,
      content,
      timestamp: new Date().toISOString(),
      state: 'sending',
    };
    setMessages((prev) => ({ ...prev, [key]: [...(prev[key] || []), pending] }));
    deliver(key, tempId, content, targetFor(peer));
  }

  function handleRetry(message) {
    patchMessage(peer.id, message.id, { state: 'sending', error: undefined });
    deliver(peer.id, message.id, message.content, targetFor(peer));
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

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chats'}
            className={`tab ${tab === 'chats' ? 'on' : ''}`}
            onClick={() => setTab('chats')}
            data-testid="tab-chats"
          >
            Chats
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'groups'}
            className={`tab ${tab === 'groups' ? 'on' : ''}`}
            onClick={() => {
              setTab('groups');
              loadRooms();
            }}
            data-testid="tab-groups"
          >
            Groups
          </button>
        </div>

        {tab === 'chats' ? (
          <UserList
            token={session.token}
            meId={session.user.id}
            selectedId={peer?.id}
            unread={unread}
            presence={presence}
            refreshKey={refreshKey}
            onSelect={handleSelect}
          />
        ) : (
          <GroupList
            rooms={rooms}
            state={roomsState}
            token={session.token}
            me={session.user}
            selectedId={peer?.id}
            unread={unread}
            onSelect={(room) => handleSelect(groupPeer(room))}
            onCreated={handleGroupCreated}
            onRetry={() => loadRooms()}
          />
        )}
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
          onReloadHistory={() => openConversation(peer)}
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