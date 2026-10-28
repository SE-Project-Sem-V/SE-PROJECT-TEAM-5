import { useState } from 'react';
import NewGroupForm from './NewGroupForm.jsx';

export default function GroupList({ rooms, state, token, me, selectedId, unread, onSelect, onCreated, onRetry }) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="groups">
      <div className="groups-head">
        <button type="button" className="btn-small" onClick={() => setCreating((open) => !open)} data-testid="new-group-button">
          {creating ? 'Close' : 'New group'}
        </button>
      </div>

      {creating && (
        <NewGroupForm
          token={token}
          me={me}
          onCancel={() => setCreating(false)}
          onCreated={(room) => {
            setCreating(false);
            onCreated(room);
          }}
        />
      )}

      {state === 'loading' && (
        <p className="note" role="status">
          Loading groups…
        </p>
      )}
      {state === 'error' && (
        <p className="note" role="alert" data-testid="groups-error">
          Could not load groups.{' '}
          <button type="button" className="link" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}
      {state === 'ready' && rooms.length === 0 && !creating && (
        <p className="note" data-testid="no-groups">
          You are not in any groups yet. Create one to start a group chat.
        </p>
      )}

      <ul className="users">
        {rooms.map((room) => {
          const key = `room:${room.id}`;
          return (
            <li key={room.id}>
              <button
                type="button"
                className="user"
                aria-current={key === selectedId}
                onClick={() => onSelect(room)}
                data-testid="group-item"
              >
                <span className="user-text">
                  <span className="user-name">{room.name}</span>
                  <span className="user-status">
                    {room.members.length} member{room.members.length === 1 ? '' : 's'}
                  </span>
                </span>
                {unread[key] > 0 && (
                  <span className="badge" data-testid="unread-badge">
                    {unread[key]}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}