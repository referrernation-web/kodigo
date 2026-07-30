# kodigo

Zero-dependency AI coding agent CLI. Works with any OpenAI-compatible API (OpenRouter, OpenAI, Ollama, etc.). No `npm install` needed — plain Node.js 18+.

## Usage

```bash
node src/index.js                    # interactive mode
node src/index.js -c                 # continue last session
node src/index.js run "fix the bug"  # one-shot mode
node src/index.js --yolo             # auto-approve all tools
node src/index.js --plan             # read-only plan mode
node src/index.js config             # show config
```

Or link it:

```bash
npm link   # then just `kodigo`
```

## Setup

Set your key via env (or paste it when prompted on first run — saved to `~/.kodigo/config.json`):

```bash
KODIGO_API_KEY=sk-or-...
KODIGO_BASE_URL=https://openrouter.ai/api/v1   # default
KODIGO_MODEL=anthropic/claude-sonnet-4.5       # default
```

Per-project overrides: drop a `kodigo.json` in your project root.

Project instructions: `AGENTS.md`, `CLAUDE.md`, or `KODIGO.md` files are auto-loaded as context.

## Interactive commands

| Command | What it does |
|---|---|
| `/help` | show commands |
| `/new` | new session |
| `/sessions`, `/resume <id>` | browse/resume past sessions |
| `/model [name]` | show or switch model |
| `/plan` | toggle read-only plan mode |
| `/compact` | force context compaction |
| `/usage` | token totals |
| `/yolo` | toggle auto-approve |
| `/exit` | quit |

## Tools

`bash` · `read` · `write` · `edit` (exact-match, Claude Code style) · `glob` · `grep` · `webfetch` · `todowrite`

Writes/edits/commands ask permission first (`y` / `n` / `a`lways) with diff previews — unless `--yolo`.

## Test

```bash
node test/mock.test.js
```
