import { useEffect, useState } from 'react';
import { searchUsers } from '../api.js';

export default function UserList({ token, meId, selectedId, unread, onSelect }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [state, setState] = useState('loading'); // loading | ready | error

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setState('loading');
      try {
        const result = await searchUsers(query.trim(), token);
        if (!cancelled) {
          setUsers(result.filter((u) => u.id !== meId));
          setState('ready');
        }
      } catch {
        if (!cancelled) setState('error');
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, token, meId]);

  return (
    <>
      <div className="search">
        <input
          type="search"
          placeholder="Search users"
          aria-label="Search users"
          data-testid="user-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            data-testid="user-search-clear"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        )}
      </div>

      {state === 'loading' && (
        <p className="note" role="status">
          Searching…
        </p>
      )}
      {state === 'error' && (
        <p className="note" role="alert">
          Could not load users. Check your connection and try again.
        </p>
      )}
      {state === 'ready' && users.length === 0 && (
        <p className="note" data-testid="no-users">
          {query.trim() ? `No users match “${query.trim()}”.` : 'No other users yet.'}
        </p>
      )}

      <ul className="users">
        {users.map((user) => (
          <li key={user.id}>
            <button
              type="button"
              className="user"
              aria-current={user.id === selectedId}
              data-testid="user-item"
              data-username={user.username}
              onClick={() => onSelect(user)}
            >
              <span className={`dot ${user.online ? 'on' : ''}`} aria-hidden="true" />
              <span className="user-text">
                <span className="user-name">{user.username}</span>
                <span className="user-status">{user.online ? 'Online' : 'Offline'}</span>
              </span>
              {unread[user.id] > 0 && (
                <span className="badge" data-testid="unread-badge">
                  {unread[user.id]}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}