import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App.jsx';
import ProfilePanel from './components/ProfilePanel.jsx';
import UserList from './components/UserList.jsx';
import { getMyProfile, updateMyProfile, searchUsers, logout } from './api.js';
import { connectSocket } from './socket.js';

vi.mock('./api.js', () => ({ getMyProfile: vi.fn(), updateMyProfile: vi.fn(), searchUsers: vi.fn(), logout: vi.fn(),
  getOrCreateDirectConversation: vi.fn(), login: vi.fn(), register: vi.fn() }));
vi.mock('./socket.js', () => ({ connectSocket: vi.fn() }));
vi.mock('./groups.js', () => ({ listRooms: vi.fn().mockResolvedValue([]), fetchRoomMessages: vi.fn() }));

const session = { token: 'session-a', user: { id: 'alice', username: 'alice' } };
const profile = { ...session.user, displayName: 'Alice saved', statusMessage: 'Available' };
let tree;
let storage;
let disconnect;
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  storage = new Map([['chat-session', JSON.stringify(session)]]);
  vi.stubGlobal('sessionStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) });
  vi.stubGlobal('document', { title: '' });
  disconnect = vi.fn();
  connectSocket.mockReturnValue({ disconnect });
  getMyProfile.mockResolvedValue(profile);
  updateMyProfile.mockImplementation(async patch => ({ ...profile, ...patch }));
  searchUsers.mockResolvedValue([]);
  logout.mockResolvedValue(undefined);
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = null; vi.unstubAllGlobals(); });

async function mount() { await act(async () => { tree = create(createElement(App)); }); }
async function click(id) { await act(async () => tree.root.findByProps({ 'data-testid': id }).props.onClick()); }
async function edit(id, value) { await act(async () => tree.root.findByProps({ id }).props.onChange({ target: { value } })); }
const text = () => JSON.stringify(tree.toJSON());

describe('mounted profile/session behavior', () => {
  it('loads persisted profile data and saves without restarting the socket or replacing the session', async () => {
    await mount();
    expect(getMyProfile).toHaveBeenCalledWith('session-a');
    await click('profile-button');
    expect(tree.root.findByProps({ id: 'profile-display-name' }).props.value).toBe('Alice saved');
    await edit('profile-display-name', 'Updated 🐱');
    await edit('profile-status', 'New status');
    await act(async () => tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(updateMyProfile).toHaveBeenCalledWith({ displayName: 'Updated 🐱', statusMessage: 'New status' }, 'session-a');
    expect(text()).toContain('Profile saved.');
    expect(text()).toContain('Updated 🐱');
    expect(connectSocket).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get('chat-session'))).toEqual(session);
    await click('logout-button');
    expect(text()).not.toContain('Updated 🐱');
    expect(tree.root.findAllByType(ProfilePanel)).toHaveLength(0);
    expect(storage.has('chat-session')).toBe(false);
    expect(disconnect).toHaveBeenCalled();
  });

  it('prevents pending-save close/reopen from overwriting a newer draft and keeps logout available', async () => {
    const pending = deferred();
    updateMyProfile.mockReturnValueOnce(pending.promise);
    await mount(); await click('profile-button');
    await edit('profile-display-name', 'First save');
    act(() => { tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }); });
    const originalEditor = tree.root.findByType(ProfilePanel);
    expect(tree.root.findByProps({ 'data-testid': 'profile-button' }).props.disabled).toBe(true);
    expect(tree.root.findByProps({ 'data-testid': 'logout-button' }).props.disabled).not.toBe(true);
    expect(tree.root.findByProps({ id: 'profile-display-name' }).props.disabled).toBe(true);
    // Attempt the exact close/reopen sequence; neither attempt may unmount the editor.
    await click('profile-button'); await click('profile-button');
    expect(tree.root.findByType(ProfilePanel)).toBe(originalEditor);
    expect(tree.root.findByProps({ id: 'profile-display-name' }).props.value).toBe('First save');
    expect(updateMyProfile).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ ...profile, displayName: 'First save' }));
    expect(tree.root.findByProps({ 'data-testid': 'profile-button' }).props.disabled).toBe(false);
    await edit('profile-display-name', 'New unsaved draft');
    await act(async () => { await tick(); });
    expect(tree.root.findByProps({ id: 'profile-display-name' }).props.value).toBe('New unsaved draft');
    expect(connectSocket).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
    await click('logout-button');
    expect(logout).toHaveBeenCalledWith('session-a');
    expect(tree.root.findAllByType(ProfilePanel)).toHaveLength(0);
  });

  it.each(['load', 'save'])('late profile %s cannot restore a logged-out session or leak into a new login', async operation => {
    const pending = deferred();
    if (operation === 'load') getMyProfile.mockReturnValueOnce(pending.promise);
    else updateMyProfile.mockReturnValueOnce(pending.promise);
    await mount();
    if (operation === 'save') {
      await click('profile-button');
      act(() => { tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }); });
    }
    await click('logout-button');
    const auth = tree.root.findByProps({ 'data-testid': 'auth-username' });
    expect(auth).toBeTruthy();
    // Use the actual App authentication callback, with a distinct session.
    const AuthScreen = (await import('./components/AuthScreen.jsx')).default;
    const next = { token: 'session-b', user: { id: 'bob', username: 'bob' } };
    getMyProfile.mockResolvedValueOnce({ ...next.user, displayName: 'Bob saved', statusMessage: null });
    await act(async () => tree.root.findByType(AuthScreen).props.onAuth(next));
    const nextSave = deferred();
    if (operation === 'save') {
      updateMyProfile.mockReturnValueOnce(nextSave.promise);
      await click('profile-button');
      act(() => { tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }); });
    }
    await act(async () => pending.resolve({ ...profile, displayName: 'OLD PRIVATE PROFILE' }));
    expect(text()).toContain('Bob saved');
    expect(text()).not.toContain('OLD PRIVATE PROFILE');
    expect(JSON.parse(storage.get('chat-session')).token).toBe('session-b');
    expect(connectSocket).toHaveBeenCalledTimes(2);
    if (operation === 'save') {
      expect(tree.root.findByProps({ 'data-testid': 'profile-button' }).props.disabled).toBe(true);
      await act(async () => nextSave.resolve({ ...next.user, displayName: 'Bob saved', statusMessage: null }));
      expect(tree.root.findByProps({ 'data-testid': 'profile-button' }).props.disabled).toBe(false);
    }
  });

  it('reports failed loads with retry and failed saves without losing the draft', async () => {
    getMyProfile.mockRejectedValueOnce(new Error('withheld'));
    await mount();
    await click('profile-button');
    expect(tree.root.findByType(ProfilePanel).findByProps({ role: 'alert' }).children.join('')).toContain('Could not load');
    await act(async () => tree.root.findByType(ProfilePanel).findAllByType('button').find(button => button.children.includes('Try again')).props.onClick());
    await edit('profile-display-name', 'Draft name');
    const pending = deferred();
    updateMyProfile.mockReturnValueOnce(pending.promise);
    act(() => { tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(tree.root.findByType(ProfilePanel).findByType('form').props['aria-busy']).toBe(true);
    expect(text()).toContain('Saving profile');
    await act(async () => pending.reject(new Error('private exception')));
    expect(tree.root.findByProps({ id: 'profile-display-name' }).props.value).toBe('Draft name');
    expect(text()).toContain('Could not save your profile.');
    expect(text()).not.toContain('private exception');
    expect(connectSocket).toHaveBeenCalledTimes(1);
    await act(async () => tree.root.findByType(ProfilePanel).findAllByType('button').find(button => button.children.includes('Cancel')).props.onClick());
    await click('profile-button');
    expect(tree.root.findByProps({ id: 'profile-display-name' }).props.value).toBe('Alice saved');
  });

  it('validates empty/oversized values while permitting full Unicode character limits', async () => {
    await mount(); await click('profile-button');
    for (const name of ['   ', '\u0085', '\t\u0085\u2003\n', '\u0085'.repeat(64), 'x'.repeat(65)]) {
      await edit('profile-display-name', name);
      await act(async () => tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }));
      expect(text()).toContain('1 to 64');
    }
    expect(updateMyProfile).not.toHaveBeenCalled();
    await edit('profile-display-name', '🐱'.repeat(64));
    await edit('profile-status', '🔒'.repeat(281));
    await act(async () => tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(updateMyProfile).not.toHaveBeenCalled();
    await edit('profile-status', '🔒'.repeat(280));
    await act(async () => tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(updateMyProfile).toHaveBeenCalledOnce();
    const validName = '\u0085' + '猫'.repeat(63);
    await edit('profile-display-name', validName);
    await act(async () => tree.root.findByType(ProfilePanel).findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(updateMyProfile).toHaveBeenLastCalledWith({ displayName: validName, statusMessage: '🔒'.repeat(280) }, 'session-a');
  });
});

describe('profile presentation', () => {
  it('provides labelled fields and accessible loading/error feedback', () => {
    for (const [state, role, feedback] of [['loading', 'status', 'Loading your profile'], ['error', 'alert', 'Could not load your profile']]) {
      const html = renderToStaticMarkup(createElement(ProfilePanel, { profile: null, state }));
      expect(html).toContain(`role="${role}"`);
      expect(html).toContain(feedback);
    }
    const html = renderToStaticMarkup(createElement(ProfilePanel, { profile, state: 'ready' }));
    expect(html).toContain('for="profile-display-name"');
    expect(html).toContain('for="profile-status"');
  });
  it('renders another user\'s display name and literal status separately from online presence', async () => {
    searchUsers.mockResolvedValue([{ id: 'bob', username: 'bob', displayName: 'Bob public', statusMessage: '<img src=x onerror=alert(1)>', online: null }]);
    await act(async () => { tree = create(createElement(UserList, { token: 'session-a', meId: 'alice', unread: {}, presence: { bob: true }, onSelect: vi.fn() })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 330)); await tick(); });
    expect(text()).toContain('Bob public');
    expect(text()).toContain('Online');
    expect(tree.root.findAllByType('img')).toHaveLength(0);
    const status = tree.root.findByProps({ className: 'profile-message' });
    expect(status.children).toEqual(['<img src=x onerror=alert(1)>']);
  });
});
