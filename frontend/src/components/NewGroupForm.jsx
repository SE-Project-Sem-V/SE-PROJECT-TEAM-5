import { useEffect, useState } from 'react';
import { searchUsers } from '../api.js';
import { createRoom } from '../groups.js';

export default function NewGroupForm({ token, me, onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState([]); // [{ id, username }]
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Look up people to add as the user types.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const found = await searchUsers(query.trim(), token);
        if (!cancelled) setResults(found.filter((u) => u.id !== me.id));
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, token, me.id]);

  function toggle(user) {
    setSelected((prev) =>
      prev.some((u) => u.id === user.id)
        ? prev.filter((u) => u.id !== user.id)
        : [...prev, { id: user.id, username: user.username }],
    );
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    if (!name.trim()) return setError('Enter a group name.');
    if (selected.length === 0) return setError('Add at least one member.');
    setBusy(true);
    try {
      onCreated(await createRoom({ name: name.trim(), members: selected, me }, token));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  return (
    <form className="group-form" onSubmit={handleSubmit} noValidate data-testid="new-group-form">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        placeholder="Group name"
        aria-label="Group name"
        data-testid="group-name"
      />

      {selected.length > 0 && (
        <div className="chips" aria-label="Members to add">
          {selected.map((u) => (
            <button
              key={u.id}
              type="button"
              className="chip"
              onClick={() => toggle(u)}
              aria-label={`Remove ${u.username}`}
              data-testid="group-chip"
            >
              {u.username} ×
            </button>
          ))}
        </div>
      )}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        maxLength={64}
        placeholder="Search people to add"
        aria-label="Search people to add"
        data-testid="group-member-search"
      />
      {query.trim() && results.length === 0 && <p className="note">No users match “{query.trim()}”.</p>}
      {results.length > 0 && (
        <ul className="pick-list">
          {results.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                className="pick"
                aria-pressed={selected.some((s) => s.id === u.id)}
                onClick={() => toggle(u)}
                data-testid="group-member-option"
              >
                <span>{u.displayName || u.username}</span>
                <span>{selected.some((s) => s.id === u.id) ? 'Added' : 'Add'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="error" role="alert" data-testid="group-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn" disabled={busy} data-testid="group-create">
          {busy ? 'Creating…' : 'Create group'}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} data-testid="group-cancel">
          Cancel
        </button>
      </div>
    </form>
  );
}