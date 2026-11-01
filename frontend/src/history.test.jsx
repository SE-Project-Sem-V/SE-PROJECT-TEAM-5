import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import App from './App.jsx';
import UserList from './components/UserList.jsx';
import GroupList from './components/GroupList.jsx';
import ChatWindow from './components/ChatWindow.jsx';
import { getDirectMessages, getOrCreateDirectConversation, getMyProfile, logout, searchUsers } from './api.js';
import { fetchRoomMessages, listRooms } from './groups.js';
import { connectSocket } from './socket.js';

vi.mock('./config.js', async original => ({ ...await original(), USE_MOCK: false }));
vi.mock('./api.js', () => ({ getDirectMessages: vi.fn(), getOrCreateDirectConversation: vi.fn(),
  getMyProfile: vi.fn(), updateMyProfile: vi.fn(), logout: vi.fn(), searchUsers: vi.fn(), login: vi.fn(), register: vi.fn() }));
vi.mock('./groups.js', () => ({ listRooms: vi.fn(), fetchRoomMessages: vi.fn() }));
vi.mock('./socket.js', () => ({ connectSocket: vi.fn() }));

const session = { token: 'history-session', user: { id: 'alice', username: 'alice' } };
const peer = { id: 'bob', username: 'bob' };
const room = { id: 'group', name: 'History group', members: [session.user, peer] };
const older = { id: 'older', from: 'bob', to: 'alice', content: 'Earlier saved message', timestamp: '2026-10-01T11:00:00Z' };
const newer = { id: 'newer', from: 'alice', to: 'bob', content: 'Later saved message', timestamp: '2026-10-01T12:00:00Z' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let tree;
let handlers;
let sendMessage;
let storage;
const items = () => tree.root.findAllByProps({ 'data-testid': 'message-item' });
const chat = () => tree.root.findByType(ChatWindow);
async function mount() { await act(async () => { tree = create(createElement(App)); }); }
async function select() { await act(async () => tree.root.findByType(UserList).props.onSelect(peer)); }
async function reconnect() {
  await act(async () => handlers.onStatus('reconnecting'));
  await act(async () => handlers.onStatus('connected'));
}

beforeEach(() => {
  vi.resetAllMocks();
  storage = new Map([['chat-session', JSON.stringify(session)]]);
  vi.stubGlobal('sessionStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) });
  vi.stubGlobal('document', { title: '' });
  getMyProfile.mockResolvedValue(session.user);
  getOrCreateDirectConversation.mockResolvedValue({ id: 'direct' });
  getDirectMessages.mockResolvedValue([older, newer]);
  searchUsers.mockResolvedValue([]);
  listRooms.mockResolvedValue([room]);
  fetchRoomMessages.mockResolvedValue([{ ...older, roomId: room.id }, { ...newer, roomId: room.id }]);
  logout.mockResolvedValue(undefined);
  sendMessage = vi.fn();
  connectSocket.mockImplementation((_token, _user, callbacks) => {
    handlers = callbacks;
    callbacks.onStatus('connected');
    return { disconnect: vi.fn(), sendMessage };
  });
});
afterEach(async () => { if (tree) await act(async () => tree.unmount()); tree = null; vi.unstubAllGlobals(); });

describe('TC-HIST-01 mounted history display', () => {
  it('renders direct history in order after reload and merges reconnect/live overlap once', async () => {
    await mount(); await select();
    expect(items()).toHaveLength(2);
    expect(chat().props.messages.map(message => message.id)).toEqual(['older', 'newer']);
    expect(JSON.stringify(tree.toJSON())).toContain('Earlier saved message');
    expect(JSON.stringify(tree.toJSON())).toContain('Later saved message');
    await act(async () => handlers.onMessage({ ...older, timestamp: new Date(older.timestamp).toISOString() }));
    await reconnect();
    expect(items()).toHaveLength(2);
    expect(getDirectMessages).toHaveBeenCalledWith('bob', session.token);
    await act(async () => tree.unmount()); tree = null;
    await mount(); await select();
    expect(items()).toHaveLength(2);
    expect(chat().props.messages.map(message => message.id)).toEqual(['older', 'newer']);
  });

  it('renders group history and merges the same persisted event on reconnect', async () => {
    await mount();
    await act(async () => tree.root.findByProps({ 'data-testid': 'tab-groups' }).props.onClick());
    await act(async () => tree.root.findByType(GroupList).props.onSelect(room));
    expect(items()).toHaveLength(2);
    expect(fetchRoomMessages).toHaveBeenCalledWith(room.id, session.token);
    await act(async () => handlers.onMessage({ ...older, roomId: room.id }));
    await reconnect();
    expect(chat().props.messages.map(message => message.id)).toEqual(['older', 'newer']);
    expect(items()).toHaveLength(2);
  });

  it.each(['direct', 'group'])('keeps one %s message when history loads before its delayed send ACK', async kind => {
    getDirectMessages.mockResolvedValue([]);
    fetchRoomMessages.mockResolvedValue([]);
    const pending = deferred();
    sendMessage.mockReturnValueOnce(pending.promise);
    await mount();
    if (kind === 'direct') await select();
    else {
      await act(async () => tree.root.findByProps({ 'data-testid': 'tab-groups' }).props.onClick());
      await act(async () => tree.root.findByType(GroupList).props.onSelect(room));
    }
    const saved = kind === 'group' ? { ...newer, roomId: room.id } : newer;
    await act(async () => chat().props.onSend(newer.content));
    getDirectMessages.mockResolvedValue([saved]);
    fetchRoomMessages.mockResolvedValue([saved]);
    await reconnect();
    await act(async () => pending.resolve(saved));
    expect(chat().props.messages.map(message => message.id)).toEqual(['newer']);
    expect(items()).toHaveLength(1);
  });

  it('ignores a pending history response after logout', async () => {
    const pending = deferred();
    getDirectMessages.mockReturnValueOnce(pending.promise);
    await mount(); await select();
    await act(async () => tree.root.findByProps({ 'data-testid': 'logout-button' }).props.onClick());
    await act(async () => pending.resolve([older]));
    expect(tree.root.findAllByType(ChatWindow)).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).not.toContain(older.content);
    expect(storage.has('chat-session')).toBe(false);
  });
});
