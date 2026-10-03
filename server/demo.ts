import type { Room } from '../shared/types.js';
import { activity, addDecision, entry, makeAgent, overlaps } from './room.js';

export function seedDemo(room: Room) {
  room.repoName = 'weekend-planner';
  room.branch = 'main';
  const descriptions = [
    [
      'Interface',
      'Build the shared planning board',
      ['src/components/Board.tsx', 'src/styles/board.css'],
      'I’ve mapped out the board layout. I’m giving each plan a little room to breathe, with live cursors so you can see who’s here.',
    ],
    [
      'Realtime',
      'Connect presence and live updates',
      ['server/presence.ts', 'shared/events.ts'],
      'Presence is connected. Next I’m wiring board updates through the room so everyone sees the same thing at the same time.',
    ],
    [
      'Quality',
      'Cover the collaboration edge cases',
      ['tests/presence.test.ts', 'tests/board.test.ts'],
      'I’m checking reconnects, duplicate events, and what happens when two people move the same card. Small details, big difference.',
    ],
  ] as const;
  descriptions.forEach(([name, task, files, text], index) => {
    const agent = makeAgent(room, room.hostId, name, task);
    agent.status = 'idle';
    agent.branch = `codex/${name.toLowerCase()}`;
    agent.files = [...files];
    entry(agent, 'user', task);
    entry(
      agent,
      'command',
      ['Read src/components/Board.tsx', 'Read server/presence.ts', 'Read tests/board.test.ts'][
        index
      ],
    );
    entry(agent, 'agent', text);
  });
  activity(room, 'Three simulated agents are ready. Try the team scenario.');
}
export function runDemoScenario(room: Room) {
  if (room.agents.some((a) => a.status === 'working' || a.status === 'starting'))
    throw new Error('Let the demo agents finish their current prompts first.');
  if (room.decisions.some((d) => d.scope === 'team' && ['open', 'owner-needed'].includes(d.status)))
    throw new Error('Settle the current team decision before starting another scenario.');
  const [ui, realtime] = room.agents;
  if (!ui || !realtime) throw new Error('This demo needs two agents.');
  ui.files = [...new Set([...ui.files, 'shared/events.ts'])];
  room.overlaps = overlaps(room.agents);
  entry(ui, 'system', 'Potential overlap: Interface and Realtime both changed shared/events.ts.');
  entry(
    realtime,
    'agent',
    'The board and presence code both need an update event. Let’s agree on the shape before we continue.',
  );
  realtime.status = 'waiting';
  activity(room, 'Interface and Realtime both changed shared/events.ts', 'overlap');
  return addDecision(room, {
    agentId: realtime.id,
    ownerId: realtime.ownerId,
    scope: 'team',
    question: 'How should we send board updates?',
    detail: 'Interface and Realtime need a shared event format. This choice affects both agents.',
    options: ['Send small, typed events', 'Send the full board state'],
  });
}
export function demoDiff(file: string, agentName: string) {
  if (file === 'shared/events.ts')
    return `diff --git a/shared/events.ts b/shared/events.ts\n--- a/shared/events.ts\n+++ b/shared/events.ts\n@@ -1,3 +1,7 @@\n // Shared room events\n-export type BoardEvent = { type: string };\n+export type BoardEvent = {\n+  type: '${agentName === 'Interface' ? 'card.moved' : 'board.updated'}';\n+  roomId: string;\n+  ${agentName === 'Interface' ? 'cardId: string;' : 'board: BoardState;'}\n+};\n`;
  return `Demo preview · ${file}\n\n+// Simulated changes from the ${agentName} agent.\n+// Live rooms show actual Git diffs here.\n`;
}
