import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDecision,
  castVote,
  createRoom,
  makeAgent,
  overlaps,
  settleDecision,
  voteOutcome,
} from '../server/room.js';

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
test('ties and no votes require the owner, while a unique plurality wins', () => {
  const { room, decision } = setup();
  assert.equal(voteOutcome(decision), null);
  castVote(room, decision, room.hostId, 0);
  castVote(room, decision, 'peer', 1);
  assert.equal(voteOutcome(decision), null);
  castVote(room, decision, 'peer', 0);
  assert.equal(voteOutcome(decision), 0);
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
