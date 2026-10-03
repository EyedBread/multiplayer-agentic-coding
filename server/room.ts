import { randomBytes, randomUUID } from 'node:crypto';
import type { Agent, Decision, Entry, Room } from '../shared/types.js';

export const uid = () => randomUUID();
export const token = () => randomBytes(32).toString('hex');
export function activity(
  room: Room,
  text: string,
  kind: Room['activity'][number]['kind'] = 'work',
) {
  room.activity.unshift({ id: uid(), text, kind, at: Date.now() });
  room.activity = room.activity.slice(0, 80);
}
export function entry(agent: Agent, kind: Entry['kind'], text: string, id = uid()) {
  const existing = agent.entries.find((e) => e.id === id);
  if (existing) existing.text = text.slice(-24000);
  else agent.entries.push({ id, kind, text: text.slice(-24000), at: Date.now() });
  agent.entries = agent.entries.slice(-100);
}
export function createRoom(
  name: string,
  memberName: string,
  mode: Room['mode'],
  repoName: string,
  branch: string,
) {
  const member = { id: uid(), name: memberName, color: 0, online: false };
  const room: Room = {
    id: uid(),
    code: randomBytes(5).toString('hex').toUpperCase(),
    name,
    mode,
    hostId: member.id,
    repoName,
    branch,
    createdAt: Date.now(),
    members: [member],
    agents: [],
    decisions: [],
    activity: [],
    overlaps: [],
    decisionVersion: 0,
  };
  activity(room, `${memberName} opened the room`, 'join');
  return room;
}
export function overlaps(agents: Agent[]) {
  const paths = new Map<string, string[]>();
  for (const a of agents)
    for (const file of new Set(a.files)) paths.set(file, [...(paths.get(file) ?? []), a.id]);
  return [...paths]
    .filter(([, ids]) => ids.length > 1)
    .map(([path, agentIds]) => ({ path, agentIds }));
}
export function addDecision(
  room: Room,
  input: Pick<Decision, 'ownerId' | 'question' | 'options' | 'scope'> &
    Partial<Pick<Decision, 'agentId' | 'detail'>>,
) {
  const decision: Decision = {
    ...input,
    id: uid(),
    detail: input.detail ?? '',
    votes: {},
    eligible: room.members.map((m) => m.id),
    status: 'open',
    createdAt: Date.now(),
    closesAt: input.scope === 'team' ? Date.now() + 30000 : undefined,
  };
  room.decisions.unshift(decision);
  activity(
    room,
    input.scope === 'team' ? 'A new team decision is on the table' : 'An agent needs a decision',
    'decision',
  );
  return decision;
}
export function castVote(
  room: Room,
  decision: Decision,
  memberId: string,
  option: number,
  now = Date.now(),
) {
  if (decision.scope !== 'team' || decision.status !== 'open' || now >= (decision.closesAt ?? 0))
    throw new Error('Voting has closed. The decision owner can settle it.');
  if (!decision.eligible.includes(memberId))
    throw new Error('You joined after this vote opened. You can vote on the next one.');
  if (!Number.isInteger(option) || option < 0 || option >= decision.options.length)
    throw new Error('Choose a valid option.');
  decision.votes[memberId] = option;
}
export function voteOutcome(decision: Decision) {
  const counts = decision.options.map(
    (_, index) => Object.values(decision.votes).filter((v) => v === index).length,
  );
  const max = Math.max(0, ...counts);
  if (max === 0 || counts.filter((n) => n === max).length !== 1) return null;
  return counts.indexOf(max);
}
export function settleDecision(room: Room, decision: Decision, answer: string) {
  if (!['open', 'owner-needed'].includes(decision.status))
    throw new Error('This decision is already closed.');
  decision.answer = answer;
  decision.status = 'resolved';
  decision.resolvedAt = Date.now();
  if (decision.scope === 'team') room.decisionVersion++;
  activity(room, `Decision settled: ${answer}`, 'decision');
}
export function makeAgent(room: Room, ownerId: string, name: string, task: string): Agent {
  const id = uid();
  const agent: Agent = {
    id,
    ownerId,
    name,
    task,
    color: room.agents.length % 4,
    status: 'starting',
    branch: `codex/${room.id.slice(0, 8)}-${id.slice(0, 8)}`,
    files: [],
    entries: [],
    contextVersion: 0,
  };
  room.agents.push(agent);
  return agent;
}
