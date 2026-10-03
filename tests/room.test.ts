import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDecision,
  castVote,
  closeVoting,
  createRoom,
  discussDecision,
  makeAgent,
  overlaps,
  settleDecision,
  voteOutcome,
} from '../server/room.js';
import { VOTE_DURATION_MS } from '../shared/types.js';

function setup() {
  const room = createRoom('Test room', 'Host', 'demo', 'repo', 'main');
  room.members.push({ id: 'peer', name: 'Peer', color: 1, online: true });
  const decision = addDecision(room, {
    ownerId: room.hostId,
    question: 'Which event format?',
    options: ['Typed events', 'Full state'],
    scope: 'team',
  });
  return { room, decision };
}
test('a teammate can change their vote without adding a second ballot', () => {
  const { room, decision } = setup();
  castVote(room, decision, room.hostId, 0);
  castVote(room, decision, room.hostId, 1);
  assert.equal(Object.keys(decision.votes).length, 1);
  assert.equal(voteOutcome(decision), 1);
});
test('the result identifies a unique plurality without treating it as approval', () => {
  const { room, decision } = setup();
  assert.equal(voteOutcome(decision), null);
  castVote(room, decision, room.hostId, 0);
  castVote(room, decision, 'peer', 1);
  assert.equal(voteOutcome(decision), null);
  castVote(room, decision, 'peer', 0);
  assert.equal(voteOutcome(decision), 0);
  assert.equal(decision.status, 'open');
  assert.equal(decision.answer, undefined);
});
test('every team vote lasts 60 seconds and waits for owner approval, even with unanimous votes', (t) => {
  t.mock.method(Date, 'now', () => 10_000);
  const { room, decision } = setup();
  assert.equal(VOTE_DURATION_MS, 60_000);
  assert.equal(decision.closesAt! - decision.createdAt, 60_000);
  castVote(room, decision, room.hostId, 0);
  castVote(room, decision, 'peer', 0);
  assert.throws(() => settleDecision(room, decision, 'Typed events'), /voting window/);
  assert.equal(closeVoting(room, decision, decision.closesAt! - 1), false);
  assert.equal(decision.status, 'open');
  assert.equal(closeVoting(room, decision, decision.closesAt), true);
  assert.equal(decision.status, 'owner-needed');
  assert.equal(decision.answer, undefined);
  assert.equal(room.decisionVersion, 0);
  const activityCount = room.activity.length;
  assert.equal(closeVoting(room, decision, decision.closesAt! + 60_000), false);
  assert.equal(room.activity.length, activityCount);
  assert.equal(decision.status, 'owner-needed');
  // The owner can choose another option after considering the discussion.
  settleDecision(room, decision, 'Full state');
  assert.equal(decision.answer, 'Full state');
});
test('ties and empty ballots also move to owner review without an automatic answer', () => {
  for (const tied of [false, true]) {
    const { room, decision } = setup();
    if (tied) {
      castVote(room, decision, room.hostId, 0);
      castVote(room, decision, 'peer', 1);
    }
    assert.equal(closeVoting(room, decision, decision.closesAt), true);
    assert.equal(decision.status, 'owner-needed');
    assert.equal(decision.answer, undefined);
    assert.equal(room.decisionVersion, 0);
  }
});
test('late arrivals, invalid choices and expired votes cannot change the result', () => {
  const { room, decision } = setup();
  assert.throws(() => castVote(room, decision, 'late-arrival', 0), /joined after/);
  assert.throws(() => castVote(room, decision, room.hostId, -1), /valid option/);
  assert.throws(() => castVote(room, decision, room.hostId, 1.5), /valid option/);
  assert.throws(() => castVote(room, decision, room.hostId, 2), /valid option/);
  assert.throws(() => castVote(room, decision, room.hostId, 0, decision.closesAt), /closed/);
});
test('settling a team decision increments shared context exactly once', () => {
  const { room, decision } = setup();
  closeVoting(room, decision, decision.closesAt);
  settleDecision(room, decision, 'Typed events');
  assert.equal(room.decisionVersion, 1);
  assert.equal(decision.status, 'resolved');
  assert.throws(() => settleDecision(room, decision, 'Full state'), /already closed/);
  assert.equal(room.decisionVersion, 1);
  const ownerQuestion = addDecision(room, {
    ownerId: room.hostId,
    question: 'Which local name?',
    options: [],
    scope: 'owner',
  });
  settleDecision(room, ownerQuestion, 'name');
  assert.equal(room.decisionVersion, 1);
});
test('vote discussions accept room members, stay separate and remain open during owner review', (t) => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const { room, decision } = setup();
  const other = addDecision(room, {
    ownerId: 'peer',
    question: 'Which database?',
    options: ['SQLite', 'Postgres'],
    scope: 'team',
  });
  discussDecision(room, decision, room.hostId, '  Typed contracts are easier to verify.  ');
  discussDecision(room, other, room.hostId, 'SQLite keeps the demo simple.');
  assert.equal(decision.messages[0].text, 'Typed contracts are easier to verify.');
  assert.equal(other.messages[0].text, 'SQLite keeps the demo simple.');
  assert.notEqual(decision.messages[0].id, other.messages[0].id);
  assert.throws(() => discussDecision(room, decision, 'outsider', 'Hello'), /Join this room/);
  assert.throws(() => discussDecision(room, decision, room.hostId, 'Again'), /moment to read/);
  // Slow mode is per member, not a lock on the entire conversation.
  discussDecision(room, decision, 'peer', 'Agreed.');
  now += 749;
  assert.throws(() => discussDecision(room, decision, room.hostId, 'Too soon'), /moment to read/);
  now += 1;
  discussDecision(room, decision, room.hostId, 'Adding a concrete example.');
  now = decision.closesAt!;
  closeVoting(room, decision);
  discussDecision(room, decision, 'peer', 'Ready when you are.');
  assert.equal(decision.messages.length, 4);
  assert.equal(other.messages.length, 1);
  settleDecision(room, decision, 'Typed events');
  assert.throws(() => discussDecision(room, decision, 'peer', 'After approval'), /read-only/);
  other.status = 'cancelled';
  assert.throws(() => discussDecision(room, other, 'peer', 'After cancellation'), /read-only/);
});
test('vote discussions validate messages, retain 100 messages and exclude private agent prompts', (t) => {
  t.mock.method(Date, 'now', () => 10_000);
  const { room, decision } = setup();
  for (const body of ['', '   ', 'x'.repeat(1001), null, {}, 4]) {
    assert.throws(() => discussDecision(room, decision, 'peer', body), /between 1 and 1000/);
  }
  decision.messages = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    memberId: 'peer',
    text: `Message ${i}`,
    at: i,
  }));
  discussDecision(room, decision, 'peer', 'x'.repeat(1000));
  assert.equal(decision.messages.length, 100);
  assert.equal(decision.messages[0].id, '1');
  assert.equal(decision.messages.at(-1)!.text.length, 1000);
  const ownerQuestion = addDecision(room, {
    ownerId: room.hostId,
    question: 'Local detail?',
    options: ['A', 'B'],
    scope: 'owner',
  });
  assert.throws(() => discussDecision(room, ownerQuestion, 'peer', 'Hello'), /read-only/);
  assert.equal(closeVoting(room, ownerQuestion, Date.now() + 60_000), false);
});
test('overlap needs different agents, and disappears when one removes its changes', () => {
  const { room } = setup();
  const a = makeAgent(room, room.hostId, 'UI', 'Build UI');
  const b = makeAgent(room, 'peer', 'Server', 'Build server');
  a.files = ['shared.ts', 'ui.ts', 'shared.ts'];
  b.files = ['server.ts'];
  assert.deepEqual(overlaps(room.agents), []);
  b.files.push('shared.ts');
  assert.deepEqual(overlaps(room.agents), [{ path: 'shared.ts', agentIds: [a.id, b.id] }]);
  b.files = [];
  assert.deepEqual(overlaps(room.agents), []);
});
