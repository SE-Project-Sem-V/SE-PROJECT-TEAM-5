import { useEffect, useRef, useState } from 'react';
import { MAX_MESSAGE_LENGTH } from '../config.js';

const BANNERS = {
  connecting: 'Connecting to the server…',
  reconnecting: 'Connection lost. Reconnecting…',
  disconnected: 'The server closed your connection. Log out and log in again.',
};

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatWindow({ peer, me, messages, status, onSend, onRetry, onBack }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages.length]);

  // First-time guidance (CHAT-NF-005: a new user should not need instructions).
  if (!peer) {
    return (
      <div className="empty" data-testid="empty-state">
        <div>
          <h2>Hi, {me.displayName || me.username}</h2>
          <p>Start a conversation in three steps:</p>
          <ol className="steps">
            <li>Search for a user in the list.</li>
            <li>Click their name to open the chat.</li>
            <li>Type your message and press Enter.</li>
          </ol>
        </div>
      </div>
    );
  }

  const offline = status !== 'connected';
  const left = MAX_MESSAGE_LENGTH - text.length;

  function handleSubmit(event) {
    event.preventDefault();
    const content = text.trim();
    if (!content || offline) return;
    onSend(content);
    setText('');
  }

  return (
    <>
      <header className="chat-head">
        <button type="button" className="back" onClick={onBack} aria-label="Back to users" data-testid="back-button">
          ←
        </button>
        <span>{peer.displayName || peer.username}</span>
      </header>
      {offline && (
        <div className="banner" role="status" data-testid="connection-banner">
          {BANNERS[status]}
        </div>
      )}
      <ul className="messages" aria-live="polite" data-testid="message-list">
        {messages.length === 0 && <li className="note">No messages yet. Say hello.</li>}
        {messages.map((m) => (
          <li
            key={m.id}
            data-testid="message-item"
            className={`msg ${m.from === me.id ? 'mine' : 'theirs'} ${m.state === 'failed' ? 'failed' : ''}`}
          >
            {m.content}
            <span className="meta">
              {m.state === 'sending' && 'Sending…'}
              {m.state === 'failed' && (
                <>
                  Not sent: {m.error}{' '}
                  <button
                    type="button"
                    className="retry"
                    onClick={() => onRetry(m)}
                    disabled={offline}
                    data-testid="retry-button"
                  >
                    Try again
                  </button>
                </>
              )}
              {m.state !== 'sending' && m.state !== 'failed' && formatTime(m.timestamp)}
            </span>
          </li>
        ))}
        <li ref={endRef} aria-hidden="true" />
      </ul>
      <form className="composer" onSubmit={handleSubmit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={offline ? 'Waiting for connection…' : `Message ${peer.displayName || peer.username}`}
          aria-label="Message"
          data-testid="message-input"
          autoFocus
        />
        {left <= MAX_MESSAGE_LENGTH * 0.1 && <span className="count">{left} left</span>}
        <button className="btn" type="submit" disabled={offline || !text.trim()} data-testid="send-button">
          Send
        </button>
      </form>
    </>
  );
}
