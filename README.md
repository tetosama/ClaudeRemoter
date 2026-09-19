# Claude Remoter

Claude Remoter is a web console for Claude Code that runs entirely on your own machine. It reuses the current system user's Claude CLI, `~/.claude/settings.json`, the third-party `ANTHROPIC_BASE_URL`, and the native session history, so phones or browsers on the same LAN can pick up work securely.

## Features

- Browse, create, and continue Claude Code sessions by project directory
- Live Markdown, thinking, tool calls, and results
- Answer `AskUserQuestion` single-select, multi-select, and custom answers
- Handle tool permissions and switch between Default, Accept edits, Plan, Auto, Don't ask, and Full access mid-run
- Fork from any historical message; the original session stays untouched
- Pick configured models from `settings.json` and set the Effort level per session
- Upload images and files without touching the Git working tree
- Single-password sign-in, Origin/CSRF checks, and login rate limiting
- Three-pane desktop layout and drawer layout on phones

## Requirements

- macOS, or a mainstream glibc-based Linux distribution (Debian, Ubuntu, Fedora, and similar)
- Node.js 22 or newer
- A working `claude` command
- Base URL, credentials, and at least one model already configured in `~/.claude/settings.json`

Notes for Linux:

- A `claude` installed via the official install script usually lives in `~/.local/bin`; if it cannot be found at runtime, set the `CLAUDE_PATH` environment variable before setup, or specify an absolute path in `config.json` later.
- Alpine (musl) ships no prebuilt better-sqlite3 binary, so `npm install` needs `python3`, `make`, and `g++` on the machine to compile it.
- Linux does not resolve `<hostname>.local` by default (mDNS/Avahi needs extra configuration); access the server by its LAN IP instead.

Claude Remoter does not copy or display the Base URL or API token. The Agent SDK invokes the current `claude` executable directly, so the web UI and the terminal share the same configuration and session files.

## Install and first-time setup

```bash
npm install
npm run setup
```

`setup` asks in the terminal for an access password of at least 10 characters and generates the following under `~/.claude-remoter/`:

- `auth.json`: the scrypt password hash and a random cookie secret
- `config.json`: the listen address, Claude path, and project root

All secret files are readable only by the current system user. Do not share `auth.json` or `settings.json`.

## Running

Development mode:

```bash
npm run dev
```

Production build and manual start:

```bash
npm run build
npm start
```

The default address is `http://<Mac name>.local:8443`; on Linux use the LAN IP instead, for example `http://192.168.1.10:8443`. The service runs only after you start it manually; no background daemon (LaunchAgent/systemd) is installed.

## Usage

1. After signing in, the app discovers existing projects and sessions from `~/.claude/projects`.
2. The "＋" button opens the server-side directory picker; its scope defaults to the current user's home.
3. After creating a session, you can pick the model, permission mode, and Effort level before sending the first message.
4. Pending permission or question prompts appear as inline cards; after a brief disconnect the browser reconnects and replays events cached by the current process.
5. A service restart marks running turns as "Interrupted", but already persisted Claude sessions can continue.

Do not send messages to the same Claude session from the terminal and the web at the same time. The app reports external transcript updates but cannot prevent another terminal process from writing concurrently.

The sidebar counts follow the resumable top-level sessions returned by the Agent SDK's `listSessions()`. Internal transcripts under `subagents/`, empty JSONL files that contain only an init record, and similar files are not resumable user sessions, so they are not presented as continuable conversations.

### Full access

Full access maps to Claude Code's `bypassPermissions`. It lets Claude run commands and modify files the current system user can access, without per-action confirmation. The UI asks for confirmation before each switch, but it is not a container sandbox.

## Data locations

Application metadata lives in `~/.claude-remoter/remoter.sqlite3`. SQLite only records the project index, Web/SDK session mappings, modes, models, Effort levels, fork relationships, and attachment metadata.

Attachments live in `~/.claude-remoter/uploads/<session-id>/`:

- 25 MiB maximum per file
- 100 MiB maximum total per turn
- PNG, JPEG, GIF, and WebP are sent as image blocks
- Other files are handed to Claude for reading through controlled local paths

The raw conversation still uses Claude Code's JSONL transcript as the source of truth.

## Configuration

`~/.claude-remoter/config.json` supports these fields:

- `host`: defaults to `0.0.0.0`
- `port`: defaults to `8443`
- `claudePath`: absolute path to the local Claude CLI
- `projectRoot`: the root the web directory browser may browse
- `maxActiveSessions`: defaults to `3`

The web model list reads and deduplicates only these fields; it does not call the third-party gateway's model enumeration endpoint:

- `model`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_DEFAULT_OPUS_MODEL`
- `ANTHROPIC_DEFAULT_SONNET_MODEL`
- `CLAUDE_CODE_SUBAGENT_MODEL`

## Verification

```bash
npm run typecheck
npm test
npm run build
```

Playwright starts an isolated instance at `https://127.0.0.1:9443` without touching real models:

```bash
npx playwright install chromium
npm run test:e2e
```

The optional real smoke test makes a few model calls through the current third-party gateway and verifies create, resume, and fork:

```bash
CLAUDE_REMOTER_REAL_SMOKE=1 npm run smoke:real
```

Tests use temporary projects and clean up the sessions they create; the real smoke test does not run by default.

## Security boundaries

- This is a single-user LAN tool and should not be exposed directly to the public internet.
- The sign-in password and Claude API credentials stay on this Mac.
- The sign-in cookie is HttpOnly and SameSite=Strict; both write requests and the WebSocket verify the Origin.
- Logs strip cookies, Authorization, and common credential fields.
- The app runs as the current system user; Full access has that user's own file permissions.
