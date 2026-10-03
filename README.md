# Multiplayer

**A shared coding room for your team and your agents.**

One person runs the server with a Git project. Teammates join in their browsers, create rooms, follow every agent’s session, discuss and vote on shared decisions, and spot overlapping changes before merging. Agents currently run on the server computer using its Codex installation and account.

## Run it

Requires **Node.js 22+**, Git, and macOS or Linux (Windows users can use WSL).

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:3000**. Choose **Explore a demo room** to try the complete collaboration flow without model access. Demo agents and file changes are explicitly simulated; room membership, presence, votes, and synchronization are real.

For live agents, sign in using the project’s pinned Codex CLI:

```sh
npx --no-install codex login
```

An existing Codex login is reused. Model usage follows the host’s Codex account and configuration. The repository pins Codex **0.160.0** so an outdated global install does not silently change the protocol. If the project-local CLI is unavailable, the host looks for the runtime bundled with the macOS ChatGPT desktop app, then `codex` on PATH. You can also select a compatible installation with `CODEX_BIN`.

### Host your own project

```sh
HOST_REPO_PATH=/absolute/path/to/your/repo npm run dev
```

The target must be a Git repository with an initial commit and a clean working tree. Commit or stash changes before creating a live room. Agents start from the latest commit; uncommitted changes are not copied.

Add `.multiplayer/` to that repository’s `.gitignore` before hosting. Agent worktrees are created under `.multiplayer/worktrees/<room>/<agent>` on `codex/<room>-<agent>` branches. The app does not automatically commit, merge, push, or delete them.

### Invite teammates on the same network

```sh
HOST=0.0.0.0 HOST_REPO_PATH=/absolute/path/to/your/repo npm run dev
```

Open the app using the server computer’s LAN address (for example `http://192.168.1.10:3000`). Any teammate who can reach the server can create a room using the configured Git project, or join an existing room with its code. Share the LAN address and room code. A `localhost` invite works only on the server computer itself. Keep the server running while the team works.

This MVP is for trusted teams on a local network. Invite codes grant room access. Each member receives a separate session token, and the server enforces ownership for agent controls. A room’s creator is its host and handles command and filesystem approval requests, including for rooms created from another computer. All rooms use the server computer’s project and Codex account. Do not expose this development server directly to the public internet; internet hosting needs HTTPS, account authentication, and stronger process isolation.

### Leave and return to your profile

The browser remembers each room profile. **Leave room** returns to the lobby without discarding membership. Select the saved **Rejoin** card, or enter the same room code, to return with the original member ID and control of your agents. This also works after closing a tab and reopening the same server address in the same browser profile. Active rooms remain independent across tabs.

Existing open sessions are remembered when the updated client loads. Refresh an original session tab once before leaving it. Saved profiles use their original session token; matching another member’s display name does not grant access. A failed connection keeps the saved profile for retry; an expired login or ended room removes that saved credential. Server restarts still end rooms, and clearing site storage, using a different browser profile, or changing the server address can make saved credentials unavailable. Previously discarded tokens cannot be recovered by name; an original tab that still has access can save its membership by loading the updated client.

## Try the demo

1. Open a demo room and invite a teammate, or join from another browser tab.
2. Select **Run team scenario**. Two simulated agents change the same shared event file.
3. Open **Compare changes** to inspect both proposals.
4. Vote on the event format and discuss the choices in that vote’s chat. Counts and messages update in every connected browser.
5. After 60 seconds, voting closes and the agent keeps waiting. The decision owner selects the final answer and explicitly approves it before the session continues.

You can also create your own votes, add agents, send simulated prompts, and inspect the activity feed. Collapse the right sidebar when you want more space for agent sessions, then reopen it to return to decisions and activity.

## Live workflow

- Create a live room and add an agent with a name and task. This creates its own worktree and Codex conversation.
- Send a prompt to start work. Everyone can see public agent messages, commands, status, and changed files. The owner and host can send prompts or stop the agent.
- Agents have a `team_decision` tool for shared API, dependency, architecture, and product choices. Ordinary structured agent questions go to their owner; any teammate can promote a question with multiple choices to a team vote.
- Team votes last **60 seconds**. Each eligible member gets one changeable ballot. The tally informs the decision; it never automatically resumes the agent. Once voting closes, the decision owner selects and explicitly approves the final answer, even when there is a clear winner. The owner is the asking agent’s owner, or the initiator of a manually created vote. The room host cannot override another owner’s decision. Teammates joining after a vote opens participate starting with the next vote.
- Each team vote has its own real-time discussion. All room members, including people who joined after voting opened, can send messages while voting or owner approval is pending. Each discussion keeps its latest 100 messages, with up to 1,000 characters per message. Settled or cancelled discussions are read-only and remain available in the decision history while the server is running.
- Only the asking agent waits. Settled decisions are sent to running agents with `turn/steer` and included in every subsequent prompt. “Decision queued” means an agent has not yet received the latest shared context. Delivery is not a guarantee that the implementation follows the decision.
- Permission approvals never become votes and never time out into permission grants. The room host must explicitly approve or decline.
- File tracking compares each worktree against its starting commit every two seconds, including staged, unstaged, committed, deleted, and untracked files. Changes to the same path trigger a **potential overlap**, not a claim of a semantic or merge conflict.

When ready, review and integrate the agents’ branches using Git. Worktrees remain available after the host stops.

## Commands and configuration

| Command          | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `npm run dev`    | Combined Node host and Vite development server            |
| `npm run check`  | TypeScript checks                                         |
| `npm test`       | Voting, Git, and complete host/protocol integration tests |
| `npm run build`  | Type check and production browser build                   |
| `npm start`      | Serve the production build and host API                   |
| `npm run format` | Format application source and documentation               |

| Environment variable | Default                 | Purpose                                                     |
| -------------------- | ----------------------- | ----------------------------------------------------------- |
| `HOST`               | `127.0.0.1`             | Address to bind; `0.0.0.0` enables LAN access               |
| `PORT`               | `3000`                  | HTTP and WebSocket port                                     |
| `HOST_REPO_PATH`     | This repository         | Git project to host                                         |
| `CODEX_BIN`          | Project-local Codex CLI | Override the executable for another compatible installation |
| `CODEX_MODEL`        | Host’s Codex default    | Optional model override supported by the host’s account     |

## Architecture

- **React + TypeScript + Vite:** responsive room interface, session panels, decisions, and diff views.
- **Express + WebSocket:** authoritative in-memory room state, membership, presence, voting deadlines, per-vote discussion, owner approval, and access checks.
- **Codex app-server over stdio:** one child process per agent, streamed public events, structured input, dynamic team decisions, approval replies, and interruption.
- **Git worktrees:** separate files and branches for each agent with shared visibility in the browser.

`shared/types.ts` defines the public state, `server/room.ts` the voting rules, `server/codex.ts` the protocol transport, and `server/git.ts` file tracking. `server/index.ts` connects these to the HTTP and WebSocket routes. The UI lives in `src/`.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server). Dynamic tools and structured user input are experimental; the CLI version is pinned and should be upgraded with the integration tests.

### Bring your own harness: next phase

Local runners are not implemented in this version. Joining from Windows, macOS, or another device opens a browser client; it does not clone the repository or start a harness on that device. Every live agent currently runs Codex on the server computer in a separate worktree.

The intended next architecture starts with a selected GitHub or GitLab repository and a shared starting commit. Each teammate installs a local runner, clones the project on their own machine, and connects their chosen harness, such as Codex, Claude Code, or Gemini. Credentials and execution stay on that teammate’s machine. The server coordinates membership, public session events, discussions, approved decisions, and potential overlaps. Events need repository and commit identifiers so overlap comparisons refer to the same project and starting point. A browser alone cannot perform the local cloning and harness execution; the runner supplies that connection. Harness adapters and decision delivery acknowledgments are part of that future work.

## MVP boundaries

- Room state, membership tokens, votes, discussion messages, and the displayed activity feed live in memory. Restarting the host ends its rooms. Git worktrees and Codex’s own conversation files remain on disk, but reconnecting old rooms after a restart is not implemented.
- Maximum six agents and twelve members per room. Leaving and rejoining a remembered room preserves membership while the host is running, including across browser tabs and visits.
- No automatic merging, semantic conflict detection, remote container isolation, arbitrary harness adapters, or private credential entry through shared sessions.
- Unsupported external app forms are declined. Plain prose questions are visible in the transcript; only structured questions and `team_decision` calls create decision cards.

Tests use temporary Git repositories and a deterministic Codex protocol fixture, so `npm test` does not spend model credits. A real Codex smoke test is also used during development to verify runtime compatibility.
