import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import type { Room, Session } from '../shared/types.js';
import { api, ApiError } from '../src/api.js';
import {
  ACTIVE_SESSION_KEY,
  MEMBERSHIPS_KEY,
  createMembershipStore,
  normalizeRoomCode,
  type StorageLike,
} from '../src/membership.js';

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}
function setup() {
  const persistent = memoryStorage();
  const tab = memoryStorage();
  return { persistent, tab, store: createMembershipStore(persistent, tab) };
}
function membership(name = 'Team room') {
  const room = createRoom(name, 'Teammate', 'live', 'repo', 'main');
  const session: Session = { roomId: room.id, memberId: room.hostId, token: `token-${room.id}` };
  return { room, session };
}

test('malformed storage and incomplete credentials never become a saved or active membership', () => {
  const { persistent, tab, store } = setup();
  for (const raw of [
    '{',
    'null',
    '4',
    '"session"',
    '{}',
    '[]',
    '{"roomId":"room","memberId":"member"}',
  ]) {
    tab.setItem(ACTIVE_SESSION_KEY, raw);
    assert.equal(store.active(), null);
  }
  for (const raw of ['{', 'null', '{}', '4', '[null, false, {}, {"session":{"token":"x"}}]']) {
    persistent.setItem(MEMBERSHIPS_KEY, raw);
    assert.deepEqual(store.list(), []);
  }
  const { room, session } = membership();
  store.enter(session, room);
  const valid = store.list()[0];
  persistent.setItem(
    MEMBERSHIPS_KEY,
    JSON.stringify([
      null,
      valid,
      { ...valid, roomName: '' },
      { ...valid, savedAt: 'yesterday' },
      { ...valid, session: { ...session, token: '' } },
    ]),
  );
  assert.deepEqual(store.list(), [valid]);
  assert.deepEqual(store.active(), session);
});

test('leaving a room preserves credentials across tabs and keeps each room membership separate', () => {
  const { persistent, store } = setup();
  const first = membership('First room');
  const second = membership('Second room');
  assert.equal(store.enter(first.session, first.room), true);
  assert.equal(store.enter(second.session, second.room), true);
  assert.deepEqual(store.active(), second.session);
  store.leave();
  assert.equal(store.active(), null);
  assert.equal(store.list().length, 2);
  const reopened = createMembershipStore(persistent, memoryStorage());
  assert.equal(reopened.active(), null);
  const savedFirst = reopened.list().find((saved) => saved.session.roomId === first.room.id)!;
  assert.deepEqual(savedFirst.session, first.session);
  assert.equal(savedFirst.roomCode, first.room.code);
  assert.equal(savedFirst.memberName, 'Teammate');
  assert.equal(reopened.enter(savedFirst.session, first.room), true);
  assert.deepEqual(reopened.active(), first.session);
  assert.equal(reopened.list().length, 2, 'Reopening must not duplicate the membership');
});

test('remember updates a profile without overwriting another member in the same room', (t) => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  const { store } = setup();
  const { room, session } = membership();
  room.members.push({ id: 'peer', name: 'Peer', color: 1, online: false });
  const peerSession = { roomId: room.id, memberId: 'peer', token: 'peer-token' };
  store.remember(session, room);
  now++;
  store.remember(peerSession, room);
  now++;
  const updated = { ...session, token: 'replacement-token' };
  store.remember(updated, { ...room, name: 'Renamed room' });
  assert.equal(store.list().length, 2);
  assert.deepEqual(store.list()[0].session, updated);
  assert.equal(store.list()[0].roomName, 'Renamed room');
  assert.deepEqual(store.list()[1].session, peerSession);
  assert.equal(store.remember({ ...session, roomId: 'another-room' }, room), false);
  assert.equal(store.remember({ ...session, memberId: 'missing-member' }, room), false);
  assert.equal(store.list().length, 2);
});

test('resuming loads the original session and does not create another identity', async () => {
  const { store } = setup();
  const { room, session } = membership();
  store.enter(session, room);
  store.leave();
  let calls = 0;
  const result = await store.resume(store.list()[0], async (savedSession) => {
    calls++;
    assert.deepEqual(savedSession, session);
    return room;
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { session, room });
  assert.equal(store.list().length, 1);
  assert.equal(room.members.length, 1);
});

test('only explicit invalid-session responses evict the failed saved credential', async () => {
  const { store } = setup();
  const first = membership('First room');
  const second = membership('Second room');
  store.enter(first.session, first.room);
  store.enter(second.session, second.room);
  for (const [membership, status] of [
    [first, 401],
    [second, 404],
  ] as const) {
    const saved = store.list().find((entry) => entry.session.token === membership.session.token)!;
    const error = new ApiError('Credential expired', status);
    await assert.rejects(
      store.resume(saved, async () => {
        throw error;
      }),
      (actual) => actual === error,
    );
    assert.ok(!store.list().some((entry) => entry.session.token === membership.session.token));
    if (status === 401)
      assert.deepEqual(store.active(), second.session, 'Other active room stays intact');
  }
  assert.equal(store.active(), null);
  assert.deepEqual(store.list(), []);
});

test('network failures, service errors and message text cannot erase membership', async () => {
  const { store } = setup();
  const { room, session } = membership();
  store.enter(session, room);
  for (const error of [
    new TypeError('Failed to fetch'),
    new Error('Join a room. This room has ended.'),
    new ApiError('Unavailable', 500),
    new ApiError('Temporarily unavailable', 503),
    new ApiError('Forbidden', 403),
  ]) {
    await assert.rejects(
      store.resume(store.list()[0], async () => {
        throw error;
      }),
      (actual) => actual === error,
    );
    assert.equal(store.list().length, 1);
    assert.deepEqual(store.active(), session);
  }
});

test('resuming a credential for the wrong room or an absent member invalidates only that profile', async () => {
  for (const wrongIdentity of ['room', 'member']) {
    const { store } = setup();
    const { room, session } = membership();
    store.enter(session, room);
    const response: Room =
      wrongIdentity === 'room' ? { ...room, id: 'wrong-room' } : { ...room, members: [] };
    await assert.rejects(
      store.resume(store.list()[0], async () => response),
      (error) => error instanceof ApiError && error.status === 401,
    );
    assert.deepEqual(store.list(), []);
    assert.equal(store.active(), null);
  }
});

test('blocked browser storage fails gracefully without blocking in-memory room navigation', async () => {
  const blocked: StorageLike = {
    getItem() {
      throw new Error('Storage blocked');
    },
    setItem() {
      throw new Error('Storage quota reached');
    },
    removeItem() {
      throw new Error('Storage blocked');
    },
  };
  const store = createMembershipStore(blocked, blocked);
  const { room, session } = membership();
  assert.equal(store.active(), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.enter(session, room), false);
  assert.doesNotThrow(() => store.leave());
  assert.doesNotThrow(() => store.forget(session.token));
});

test('saved profiles stay bounded and room codes normalize pasted invite formatting', (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now++);
  const { store } = setup();
  const first = membership('Oldest');
  store.remember(first.session, first.room);
  for (let i = 0; i < 40; i++) {
    const { room, session } = membership(`Room ${i}`);
    store.remember(session, room);
  }
  assert.equal(store.list().length, 40);
  assert.ok(!store.list().some((saved) => saved.session.token === first.session.token));
  assert.equal(store.list()[0].roomName, 'Room 39');
  assert.equal(normalizeRoomCode('  ab-cd eF  '), 'ABCDEF');
});

test('API errors retain their HTTP status for credential expiry decisions', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: 'No longer a member' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  await assert.rejects(
    api('/api/room', membership().session),
    (error) =>
      error instanceof ApiError && error.status === 401 && error.message === 'No longer a member',
  );
});
