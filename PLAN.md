# KODIGO — PLAN (v7)

**Vision:** Personal daily driver that is on par with the terminal coding loop of Claude Code / Codex / OpenClaw, and better at the three things they all do poorly: transparent cost, painless provider setup, and readable memory.

**Explicit non-goals:** platform parity (IDE, desktop, web, cloud, routines, agent teams, sandboxing), Ink-style TUI, LSP, 25 messaging channels, voice, canvas.

**Success metric:** the user reaches for kodigo instead of Claude Code. Measured via FRICTION.md during dogfood.

**Line budget:** ~2,300 lines target. Over 3,000 = overbuilding; the "readable in one sitting" wedge is lost.

## Locked decisions

- Git identity: `referrernation-web` / `referrernation@gmail.com`; repo is **public** on GitHub.
- Zero npm dependencies for core. Node 18+ builtins only (npm works via `cmd`, but zero-dep is a feature).
- Shell: auto-detect Git Bash (`C:\Program Files\Git\bin\bash.exe`) → PowerShell → cmd (same as Claude Code on Windows).
- API key: stays in `~/.kodigo/config.json`; protected via deny-list + output redaction. **TODO after M1: rotate the Kimi key** (it currently exists in plaintext session files).
- Memory: plain user-editable `MEMORY.md`, auto-appended learnings, committed to git.
- Subagent budget (when built): same as parent.
- MCP: deferred until after dogfood; spike-gated (npx works via cmd — verified).

## Milestones

### M0 — Git safety net
- Goal: every future agent edit is recoverable.
- Scope: `git init`, `.gitignore`, identity, first commit, tag `v0.1.0`, `winget install GitHub.cli`, `gh auth login`, public repo, push, `kodigo.cmd` shim for PATH (`.ps1` shims are blocked by execution policy).
- Non-goals: CI workflows, branch protection, release automation.
- Done-means: `git log` shows 1 commit; remote exists; `node test/mock.test.js` → PASS on clean clone.

### M1 — Security + Windows hardening
- Goal: close the known exfil paths and Windows failure modes before features multiply them.
- Scope:
  - Deny-list in read/glob/grep: all of `~/.kodigo/`, `.env*`, `.ssh/**`, `.aws/**`, `*.pem`, `*.key`
  - Filter "Did you mean" suggestions against the deny-list
  - Redact `sk-*` style tokens from all tool outputs before they enter the transcript
  - webfetch: permission prompt for previously-unseen domains; block localhost/127.0.0.1/169.254.169.254 (SSRF)
  - Shell auto-detect Git Bash → PowerShell → cmd; report active shell in system prompt and each bash result
  - Process-tree kill on win32: `taskkill /pid <pid> /t /f`
  - SSE parser: normalize `\r\n` → `\n` (CRLF hang fix) + regression test
  - Session schema `version: 1` + tolerant loader
  - `node --check` after edits to `.js` files (poor man's LSP)
- Non-goals: sandboxing, OS-level isolation, OAuth.
- Done-means: test suite grows 7 → 15+ and passes; manual check — agent cannot read config.json or session files.

### M2 — Cost dashboard + budget cap
- Goal: never be surprised by a bill (Claude Code's #1 complaint).
- Scope: configurable per-model pricing table; session cost tracking; running cost shown per turn; `--budget <usd>` flag = hard stop that denies the next API call, saves the session, and reports.
- Non-goals: live balance APIs, billing dashboards.
- Done-means: mock test — `$0.001` budget stops the agent cleanly with a clear message.

### M3 — Provider auto-discovery
- Goal: paste a key, get a working model — no manual endpoint spelunking (we lived this pain).
- Scope: probe `/models` on key save/first run; validate; cache the list; `/model` with no arg → numbered picker; `/models refresh`; wrong-endpoint errors suggest the fix.
- Non-goals: OAuth flows, multi-provider keyring.
- Done-means: fake `/models` server in tests → picker works; bad endpoint → clear error with suggestion.

### M4 — Composable CLI + status (event seam)
- Goal: kodigo composes like a Unix tool and shows context state.
- Scope: **event seam** — `runAgent` emits events instead of writing to stdout directly (renderer in ui.js; caller owns saveSession; single-writer sessions; permission prompts serialized). Then: `kodigo -p "prompt"` non-interactive, stdin pipe, `--json` event-stream output, correct exit codes; `/status` command; context-left % in the REPL prompt.
- Non-goals: full TUI, multi-writer sessions.
- Done-means: `echo hi | kodigo -p "..."` → clean output; old tests pass against event stream.

### M5 — Git checkpoints + review
- Goal: undo any task; review before shipping.
- Scope: auto git checkpoint before each task (`git add -A && git commit` on a checkpoint ref or stash); `/rewind` restores pre-task state; `/review` = read-only review of uncommitted/base-branch diff, never touches working tree.
- Non-goals: full undo UI, interactive rebase.
- Done-means: `/rewind` restores state; `/review` produces findings with zero file changes.

### M6 — /init + transparent memory
- Goal: bootstrap project context; learnings persist across sessions.
- Scope: `/init` analyzes the repo and writes AGENTS.md; `MEMORY.md` auto-append of learnings (build commands, conventions, gotchas) at end of task, user-editable, committed; `/memory` shows/edits it; memory is injected into system prompt.
- Non-goals: vector stores, opaque memory DBs.
- Done-means: a learning from session 1 appears in session 2's context; MEMORY.md is plain markdown in git.

### M7 — Slash commands
- Goal: repeatable workflows as markdown.
- Scope: `.kodigo/commands/*.md` with frontmatter (name, description); loaded as `/name`; template becomes a user message; frontmatter parser hand-rolled and unit-tested.
- Non-goals: plugin marketplace, command args DSL.
- Done-means: a `test.md` command works end-to-end.

### M8 — Hooks
- Goal: shell commands before/after tool use.
- Scope: `.kodigo/kodigo.json` (or config) `hooks: { pre: [{tool, command}], post: [...] }`; pre-hook non-zero exit = deny tool; hook stdout appended to tool result.
- Non-goals: JSON hook protocols, matchers beyond tool name.
- Done-means: a test hook denies a tool and its message reaches the model.

### DOGFOOD gate
- Keep `FRICTION.md` in repo; one line per frustration/switch-back; measure % tasks completed without switching.
- Evidence-gated next: subagents (cheap now — event seam done), custom agents, MCP (spike first), image input, web search.

### Phase E — Assistant mode (post-dogfood, blueprint: claudeclaw/openclaw)
- E1 daemon + heartbeat (Windows Scheduled Task), E2 cron jobs (via `-p`), E3 Telegram bridge (long polling, default-deny pairing — the claudeclaw v1.0.26 lesson), E4 security levels, E5 per-chat sessions.

## Frozen contracts (appendix)

**Tool schemas:** bash, read, write, edit, glob, grep, webfetch, todowrite — do not change parameter shapes without an explicit decision.

**Session JSON:** `{ version: 1, id, createdAt, messages: [...], usage: { prompt, completion }, cost: number }`. Loader must tolerate unknown fields.

**Event types (M4):** `text`, `reasoning`, `tool_start`, `tool_end`, `usage`, `error`, `done`.

**Memory format:** plain markdown bullets in `MEMORY.md` at repo root; section `## Learnings`.

**Config keys:** baseURL, model, apiKey, maxSteps, autoCompactChars, bashTimeoutMs, yolo, pricing, budget, shell, hooks.
