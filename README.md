# kodigo

Zero-dependency AI coding agent CLI — on par with the Claude Code / Codex terminal loop, better on cost transparency, provider setup, and readable memory. Plain Node.js 18+, **no `npm install` needed** — built for locked-down Windows machines where installers fail.

## Usage

```bash
node src/index.js                    # interactive mode
node src/index.js -c                 # continue last session
node src/index.js run "fix the bug"  # one-shot
node src/index.js -p "explain"       # one-shot; also accepts pipes:
tail -200 app.log | node src/index.js -p "find anomalies"
node src/index.js -p "..." --json    # JSON event stream for scripts/CI
node src/index.js --budget 2         # hard stop at $2 session cost
node src/index.js --plan             # read-only plan mode
node src/index.js --yolo             # auto-approve all tools
```

Or add the repo dir to PATH and use `kodigo.cmd` (ps1 shims are blocked by some execution policies, so we ship `.cmd`).

## Setup

Paste your key on first run (saved to `~/.kodigo/config.json`), or set env:

```
KODIGO_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY
KODIGO_BASE_URL     (any OpenAI-compatible endpoint)
KODIGO_MODEL
```

Works with OpenRouter, OpenAI, Kimi, Ollama, anything OpenAI-compatible. **`/model` auto-discovers available models from the provider** — no endpoint spelunking.

Project context: `AGENTS.md`, `CLAUDE.md`, `KODIGO.md`, `MEMORY.md` are auto-loaded. `/init` generates AGENTS.md for you.

## Interactive commands

| Command | What it does |
|---|---|
| `/help` | show commands |
| `/new`, `/sessions`, `/resume <id>` | session management |
| `/model`, `/models refresh` | model picker (auto-discovered) |
| `/plan` | toggle read-only plan mode |
| `/review [base]` | read-only review of uncommitted (or vs base) changes |
| `/rewind` | restore the pre-task checkpoint |
| `/init` | generate AGENTS.md for the repo |
| `/memory` | show learned memory |
| `/status` | session config + context usage |
| `/compact` | force context compaction |
| `/usage` | token + cost totals |
| `/yolo` | toggle auto-approve |
| `/exit` | quit |

Custom commands: drop `.kodigo/commands/deploy.md` (optional frontmatter `name:`/`description:`) → run `/deploy`. `$ARGUMENTS` is substituted.

Hooks: `.kodigo/kodigo.json` → `"hooks": { "pre": [{"tool": "write", "command": "..."}], "post": [...] }`. Pre-hook non-zero exit = tool denied; post-hook stdout reaches the model.

## Features

- **8 tools**: bash (auto-detects Git Bash → PowerShell → cmd), read, write, edit (exact-match), glob, grep, webfetch, todowrite
- **Cost transparency**: per-turn cost, session totals, `--budget` hard cap
- **Checkpoints**: auto snapshot before each task; `/rewind` to undo
- **Memory**: `MEMORY.md` auto-learned, plain markdown, in git — nothing hidden
- **Security**: sensitive-path deny-list, secret redaction in outputs, SSRF protection, per-domain fetch permission, process-tree kill
- **Composable**: stdin pipes, `--json` event stream, exit codes

## Test

```bash
node test/mock.test.js   # 33 tests, fully offline
```
