# Multiplayer

**A shared coding room for your team and your agents.**

One person runs the server with a Git project. Teammates join in their browsers, create rooms, follow every agent’s session, discuss and vote on shared decisions, and spot overlapping changes before merging. Run **Codex or Claude Code on your own computer** through a paired local runner, or use the host’s Codex session.

## Run it

Requires **Node.js 22+** and Git. The server and runner use Node on macOS, Linux, and Windows. On Windows, install Git for Windows for Claude Code, or run the tools in WSL. Automated checks run on macOS and Linux; a physical Windows teammate connection still needs a smoke test.

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

The target must be a Git repository with an initial commit and a clean working tree. Commit or stash changes before creating a live room. Each room pins the current commit. Every host or local agent starts from that same commit; uncommitted changes are not copied. Push the starting commit if teammates need to fetch it from GitHub or GitLab.

Add `.multiplayer/` to that repository’s `.gitignore` before hosting. Agent worktrees are created under `.multiplayer/worktrees/<room>/<agent>` on `codex/<room>-<agent>` branches. The app does not automatically commit, merge, push, or delete them.

### Invite teammates on the same network

```sh
HOST=0.0.0.0 HOST_REPO_PATH=/absolute/path/to/your/repo npm run dev
```

Open the app using the server computer’s LAN address (for example `http://192.168.1.10:3000`). Any teammate who can reach the server can create a room using the configured Git project, or join an existing room with its code. Share the LAN address and room code. A `localhost` invite works only on the server computer itself. Keep the server running while the team works.

This MVP is for trusted teams on a local network. Invite codes grant room access. Each member receives a separate session token, and the server enforces ownership for agent controls. The room creator handles approvals for agents executing on the server. **Local agents accept prompts, stops, and permission approvals only from their owner**, including when the room host is another person. All rooms use the configured project, but local runners use their own machine’s harness credentials. Internet hosting needs HTTPS, account authentication, and stronger process isolation.

### Connect Codex or Claude on your own computer

1. Install this app on each teammate’s machine, then run `npm install` in its checkout. Install Git and Node.js 22+ first.
2. Set up the chosen harness locally. For Codex, run `npx --no-install codex login` in the app checkout. For Claude, sign in with your local Claude Code CLI, or configure `ANTHROPIC_API_KEY` or a supported API provider in the runner terminal. The SDK includes the Claude Code runtime. Provider credentials stay on this machine.
3. Join a **live room** in the browser and choose **Connect runner**. Select Codex or Claude Code and generate a pairing code. Each code belongs to the member who generated it, expires after ten minutes, and can be claimed once.
4. Run the generated command in the **app checkout**, with the room server’s LAN URL and a path to your own project checkout:

```sh
npm run runner -- --server http://192.168.1.10:3000 --pair YOUR_PAIRING_CODE --repo "/path/to/project"
```

For Windows PowerShell, use a Windows path such as `--repo "C:\\projects\\my-project"`. For WSL, use a Linux path. `localhost` only works when the runner and server are on the same computer.

To clone the room’s repository into a **new** folder, replace `--repo` with `--clone`:

```sh
npm run runner -- --server http://192.168.1.10:3000 --pair YOUR_PAIRING_CODE --clone "/path/to/new-checkout"
```

The runner uses your local Git credentials. It checks the repository identity and exact room commit before connecting. It fetches that commit if missing, creates a dedicated worktree for each agent, and preserves existing checkout files. HTTPS and SSH remotes are supported. Projects with no network remote need an existing checkout containing the pinned commit.

5. Keep the terminal open. In **Add agent**, select your online runner. You can start several independent agents on the same runner, subject to the room’s six-agent limit. Pair another runner to use the other harness, even on the same computer.

The runner prints a resume command and stores its own credential in `~/.multiplayer/runners/` (file mode `0600` on Unix). Use the printed `npm run runner -- --resume "…"` command after closing its terminal. `--state-file PATH` selects another state location. A failed clone still saves the credential; resume with `--repo PATH` after repairing the checkout. Use **Disconnect** in the room to revoke a runner’s credential.

If the connection drops, the runner interrupts and closes its harness sessions. The server cancels pending questions and marks the agents offline once it detects the loss. Reconnecting reopens the same worktrees with **fresh harness conversations**, preserves agent ownership, and waits for a new prompt. It does not replay an interrupted task. A silent network failure can take a heartbeat interval to detect. A server restart ends the room and requires pairing again; it does not remove local worktrees.

Claude authentication follows the official SDK’s local authentication support and account eligibility. [Anthropic’s June 16, 2026 usage update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says SDK and third-party app usage still draws from subscription limits while its announced change is paused. API/provider authentication is also supported. This app neither collects nor shares provider login tokens.

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

- Create a live room and add an agent with a name, task, and execution location. This creates its own worktree and Codex or Claude conversation.
- Send a prompt to start work. Everyone can see public agent messages, commands, status, and changed files. Only the owner controls a local agent. Host agents retain owner and room-host controls.
- Agents have a `team_decision` tool for shared API, dependency, architecture, and product choices. Ordinary structured agent questions go to their owner; any teammate can promote a question with multiple choices to a team vote.
- Team votes last **60 seconds**. Each eligible member gets one changeable ballot. The tally informs the decision; it never automatically resumes the agent. Once voting closes, the decision owner selects and explicitly approves the final answer, even when there is a clear winner. The owner is the asking agent’s owner, or the initiator of a manually created vote. The room host cannot override another owner’s decision. Teammates joining after a vote opens participate starting with the next vote.
- Each team vote has its own real-time discussion. All room members, including people who joined after voting opened, can send messages while voting or owner approval is pending. Each discussion keeps its latest 100 messages, with up to 1,000 characters per message. Settled or cancelled discussions are read-only and remain available in the decision history while the server is running.
- Only the asking agent waits. Approved answers return to its blocked tool. Running Codex agents receive shared decisions through `turn/steer`. Claude receives the shared decision history with its next prompt; the UI leaves its context marked as queued until then. Both harnesses receive the full approved history on subsequent prompts. Delivery is not a guarantee that the implementation follows the decision.
- Permission approvals never become votes and never time out into permission grants. The local runner owner, or the room host for a host agent, must explicitly approve or decline. Claude uses the SDK’s default permissions with a callback for owner decisions. Codex uses its workspace-write sandbox and on-request approvals. The runner does not add OS/container isolation beyond the harness itself.
- File tracking compares each worktree against its starting commit every two seconds, including staged, unstaged, committed, deleted, and untracked files. Changes to the same path trigger a **potential overlap**, not a claim of a semantic or merge conflict.

When ready, review and integrate the agents’ branches using Git. Worktrees remain available after the host stops.

## Commands and configuration

| Command                    | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `npm run dev`              | Combined Node host and Vite development server            |
| `npm run runner -- --help` | Connect a local Codex or Claude runner                    |
| `npm run check`            | TypeScript checks                                         |
| `npm test`                 | Voting, Git, and complete host/protocol integration tests |
| `npm run build`            | Type check and production browser build                   |
| `npm start`                | Serve the production build and host API                   |
| `npm run format`           | Format application source and documentation               |

| Environment variable | Default                                   | Purpose                                                     |
| -------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| `HOST`               | `127.0.0.1`                               | Address to bind; `0.0.0.0` enables LAN access               |
| `PORT`               | `3000`                                    | HTTP and WebSocket port                                     |
| `HOST_REPO_PATH`     | This repository                           | Git project to host                                         |
| `CODEX_BIN`          | Project-local Codex CLI                   | Override the executable for another compatible installation |
| `CODEX_MODEL`        | Host’s Codex default                      | Optional model override supported by the host’s account     |
| `CLAUDE_MODEL`       | Local SDK default                         | Optional Claude model override on the runner computer       |
| `ANTHROPIC_API_KEY`  | Local Claude login/provider configuration | Optional API key, set only on the runner computer           |

## Architecture

- **React + TypeScript + Vite:** responsive room interface, session panels, decisions, and diff views.
- **Express + WebSocket:** authoritative in-memory room state, membership, presence, voting deadlines, per-vote discussion, owner approval, and access checks.
- **Codex app-server over stdio:** one child process per agent, streamed public events, structured input, dynamic team decisions, approval replies, and interruption.
- **Claude Agent SDK:** a local Claude Code session with streamed public messages, permission callbacks, structured questions, and an MCP `team_decision` tool. Later prompts resume the local Claude session while the runner remains connected.
- **Local runner over WebSocket:** a separate credential scoped to one room member and harness, shared request/event adapters, project verification, reconnection, and local Git/diff reporting. The runner opens an outbound connection; teammates do not need to expose a port on their own computers.
- **Git worktrees:** separate files and branches for each agent with shared visibility in the browser.

`shared/types.ts` defines public room state and `shared/runner.ts` the harness/runner contract. `server/room.ts` owns voting rules, `server/runners.ts` pairing and remote command routing, and `server/git.ts` file tracking. `runner/index.ts` runs the teammate’s bridge, `runner/workspace.ts` verifies its project/worktrees, and `runner/claude.ts` adapts Claude Code. `server/codex.ts` is shared by host and local Codex agents. The UI lives in `src/`.

Protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server). Dynamic tools and structured user input are experimental; the CLI version is pinned and should be upgraded with the integration tests.

### Harness boundaries

Codex and Claude Code use the same room and decision protocol. Gemini and other adapters are future work. A browser alone cannot clone files or execute a local harness; the teammate starts the runner in a terminal. The host selects a GitHub/GitLab project through `HOST_REPO_PATH`; browsing and selecting repositories through a GitHub login UI is not included.

The agents interact through shared decisions and visible work reports on the server. They do not directly control each other or automatically exchange working-tree patches. The server compares relative file paths against the same repository/commit and can route a diff request back to the machine holding that file. Integration still happens through Git review and merging.

The [system slides](docs/multiplayer-architecture.pptx) explain the room workflow and architecture; a [PDF version](docs/multiplayer-architecture.pdf) is also available.

## MVP boundaries

- Room state, membership tokens, votes, discussion messages, and the displayed activity feed live in memory. Restarting the host ends its rooms. Git worktrees and Codex’s own conversation files remain on disk, but reconnecting old rooms after a restart is not implemented.
- Maximum six agents and twelve members per room. Leaving and rejoining a remembered room preserves membership while the host is running, including across browser tabs and visits.
- No automatic merging, semantic conflict detection, remote container isolation, arbitrary harness adapters, or private credential entry through shared sessions.
- Unsupported external app forms are declined. Plain prose questions are visible in the transcript; only structured questions and `team_decision` calls create decision cards.

Tests use temporary Git repositories, an actual runner/server connection with a deterministic Codex protocol fixture, and an injected Claude SDK query fixture. `npm test` does not spend model credits. Provider connectivity and physical Windows-to-Mac networking need separate smoke tests with the teammate’s own account.
