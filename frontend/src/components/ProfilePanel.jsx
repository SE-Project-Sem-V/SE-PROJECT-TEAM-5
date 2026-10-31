import { useEffect, useState } from 'react';

export default function ProfilePanel({ profile, state, saving = false, onSave, onReload, onClose }) {
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [statusMessage, setStatusMessage] = useState(profile?.statusMessage ?? '');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.displayName ?? '');
    setStatusMessage(profile?.statusMessage ?? '');
  }, [profile]);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSaved(false);
    if (!/[^\p{White_Space}\uFEFF]/u.test(displayName) || Array.from(displayName).length > 64) {
      setError('Enter a display name of 1 to 64 characters.');
      return;
    }
    if (Array.from(statusMessage).length > 280) {
      setError('Status must be at most 280 characters.');
      return;
    }
    setError(null);
    try {
      await onSave({ displayName, statusMessage });
      setSaved(true);
    } catch {
      setError('Could not save your profile. Your changes are still here. Try again.');
    }
  }

  return (
    <section className="profile-panel" aria-labelledby="profile-heading" data-testid="profile-panel">
      <h2 id="profile-heading">Your profile</h2>
      {state === 'loading' && <p role="status">Loading your profile…</p>}
      {state === 'error' && <p role="alert">Could not load your profile.{' '}
        <button type="button" className="link" onClick={onReload}>Try again</button></p>}
      {state === 'ready' && profile && (
        <form onSubmit={submit} aria-busy={saving}>
          <p className="profile-username">Username: {profile.username}</p>
          <div className="field">
            <label htmlFor="profile-display-name">Display name</label>
            <input id="profile-display-name" value={displayName} disabled={saving}
              onChange={event => { setDisplayName(event.target.value); setSaved(false); }}
              autoComplete="name" aria-describedby="profile-limits" />
          </div>
          <div className="field">
            <label htmlFor="profile-status">Custom status message</label>
            <textarea id="profile-status" value={statusMessage} disabled={saving}
              onChange={event => { setStatusMessage(event.target.value); setSaved(false); }}
              rows={3} aria-describedby="profile-limits" />
          </div>
          <p id="profile-limits" className="profile-help">Display name: 64 characters. Status: 280 characters; leave empty to clear. Online/offline presence is automatic.</p>
          {error && <p role="alert">{error}</p>}
          {saving && <p role="status">Saving profile…</p>}
          {saved && <p role="status">Profile saved.</p>}
          <div className="form-actions">
            <button type="submit" className="btn" disabled={saving}>Save profile</button>
            <button type="button" className="btn-ghost" disabled={saving} onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
      {state !== 'ready' && <button type="button" className="link" onClick={onClose}>Close profile</button>}
    </section>
  );
}
