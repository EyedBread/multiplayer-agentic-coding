import type { Harness } from './runner.js';

export const decisionToolDescription =
  'Create a real, clickable decision card in the Multiplayer room’s Team decisions sidebar. ' +
  'Use for shared API, dependency, architecture, or product choices, and whenever the user explicitly ' +
  'asks for an interactive choice, poll, A/B/C selector, or mock/demo decision. Demo decisions are supported. ' +
  'Supply one question, a short context, and two to four distinct options without A/B/C prefixes; the card adds those labels. ' +
  'The team votes for 60 seconds, then the decision owner approves the final answer. ' +
  'This tool blocks until that approval; do not invent or assume the result.';

export function decisionPresentationInstructions(harness: Harness) {
  const tool = harness === 'claude' ? 'mcp__multiplayer__team_decision' : 'team_decision';
  return (
    `Interactive decisions in this application MUST use the ${tool} tool. ` +
    'When the user asks for a mock decision, an A/B/C choice, a clickable selector, or a team vote, ' +
    `call ${tool} with a question, context, and 2–4 distinct options, even if it is only a demo. ` +
    'The tool creates the actual card in the Team decisions sidebar and waits for the owner-approved answer. ' +
    'The room does not render Codex-native selectors, visualize directives, or HTML files as decision cards. ' +
    'A prose list alone does not create a decision. Do not create a picker file, use a visualization skill, ' +
    'or claim that a selector is visible instead of calling the tool. ' +
    'For decision-only requests, do not inspect or edit repository files. ' +
    'After calling the tool, use the returned answer and continue. Permission requests still use the harness approval flow.'
  );
}

/** Keep the UI contract present on later turns, including a follow-up such as “try another way”. */
export function decisionAwarePrompt(text: string, harness: Harness) {
  return `${decisionPresentationInstructions(harness)}\n\n${text}`;
}
