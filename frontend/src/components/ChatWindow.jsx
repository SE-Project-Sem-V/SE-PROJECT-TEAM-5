import { Fragment, useEffect, useRef, useState } from 'react';
import { MAX_MESSAGE_LENGTH } from '../config.js';

const BANNERS = {
  connecting: 'Connecting to the server…',
  reconnecting: 'Connection lost. Reconnecting…',
  disconnected: 'The server closed your connection. Log out and log in again.',
};

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function dayLabel(iso) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(iso, today)) return 'Today';
  if (sameDay(iso, yesterday)) return 'Yesterday';
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ChatWindow({
  peer,
  me,
  messages,
  status,
  onSend,
  onRetry,
  onBack,
  historyState,
  onReloadHistory,
}) {
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
            <li>Search for a user in the list, or open the Groups tab.</li>
            <li>Click a name to open the chat.</li>
            <li>Type your message and press Enter.</li>
          </ol>
        </div>
      </div>
    );
  }

  const offline = status !== 'connected';
  const left = MAX_MESSAGE_LENGTH - text.length;
  const peerName = peer.displayName || peer.username;

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
        <button type="button" className="back" onClick={onBack} aria-label="Back to the list" data-testid="back-button">
          ←
        </button>
        <span className="chat-title">
          <span>{peerName}</span>
          {peer.isGroup && (
            <span className="chat-sub" data-testid="group-members">
              {peer.memberCount} member{peer.memberCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </header>
      {offline && (
        <div className="banner" role="status" data-testid="connection-banner">
          {BANNERS[status]}
        </div>
      )}
      <ul className="messages" aria-live="polite" data-testid="message-list">
        {historyState === 'loading' && (
          <li className="note" role="status">
            Loading earlier messages…
          </li>
        )}
        {historyState === 'error' && (
          <li className="note" role="alert" data-testid="history-error">
            Could not load earlier messages.{' '}
            <button type="button" className="link" onClick={onReloadHistory} data-testid="history-retry">
              Try again
            </button>
          </li>
        )}
        {messages.length === 0 && historyState !== 'loading' && historyState !== 'error' && (
          <li className="note">No messages yet. Say hello.</li>
        )}
        {messages.map((m, index) => (
          <Fragment key={m.id}>
            {(index === 0 || !sameDay(messages[index - 1].timestamp, m.timestamp)) && (
              <li className="day" data-testid="day-separator">
                {dayLabel(m.timestamp)}
              </li>
            )}
            <li
              data-testid="message-item"
              className={`msg ${m.from === me.id ? 'mine' : 'theirs'} ${m.state === 'failed' ? 'failed' : ''}`}
            >
              {peer.isGroup && m.from !== me.id && (
                <span className="sender" data-testid="message-sender">
                  {peer.memberNames?.[m.from] ?? 'Member'}
                </span>
              )}
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
          </Fragment>
        ))}
        <li ref={endRef} aria-hidden="true" />
      </ul>
      <form className="composer" onSubmit={handleSubmit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={offline ? 'Waiting for connection…' : `Message ${peerName}`}
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