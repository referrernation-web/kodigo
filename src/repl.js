import readline from "node:readline";
import { runAgent } from "./agent.js";
import { createPermissions } from "./permissions.js";
import { newSession, loadSession, listSessions, saveSession, popLastTurn } from "./session.js";
import { saveConfig } from "./config.js";
import { paint } from "./ui.js";

const HELP = `
${paint("bold", "Commands:")}
  /help              show this help
  /new               start a new session
  /undo              remove the last turn
  /retry             re-run the last message
  /sessions          list recent sessions
  /resume <id>       resume a session
  /model [name]      show/switch model (no arg = pick from provider list)
  /models refresh    re-fetch available models from the provider
  /fallback [model]  add/show fallback models (used on 429/5xx)
  /plan              toggle plan mode (read-only)
  /review [base]     read-only review of uncommitted (or vs base) changes
  /rewind            restore the pre-task checkpoint
  /status            session config + context usage
  /init              generate AGENTS.md for this repo
  /memory            show learned memory (MEMORY.md/USER.md/SOUL.md)
  /recall <query>    search past sessions
  /personality <n>   set persona (concise/mentor/pirate/off)
  /compact           force context compaction
  /usage             show token usage
  /yolo              toggle auto-approve of all tools
  /exit              quit
`;

export async function startRepl({ config, session, initialPlanMode = false }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let planMode = initialPlanMode;
  let running = false;
  let currentAbort = null;
  let lastSigint = 0;
  let lastCheckpoint = null;

  const permissions = createPermissions({ yolo: config.yolo, rl });

  process.stdout.write(
    paint("cyan", "◆ kodigo") + paint("gray", ` v0.1.0 — ${config.model} | /help for commands\n`)
  );

  if (!config.apiKey) {
    const key = await new Promise((r) =>
      rl.question(paint("bold", "Paste your API key (OpenRouter/OpenAI-compatible): "), r)
    );
    if (!key.trim()) {
      process.stdout.write(paint("red", "No API key provided. Set KODIGO_API_KEY and retry.\n"));
      process.exit(1);
    }
    config.apiKey = key.trim();
    saveConfig({ apiKey: config.apiKey });
  }

  rl.on("SIGINT", () => {
    const now = Date.now();
    if (running && currentAbort) {
      currentAbort.abort();
      running = false;
      prompt();
      return;
    }
    if (now - lastSigint < 1000) {
      saveSession(session);
      process.stdout.write("\nbye\n");
      process.exit(0);
    }
    lastSigint = now;
    process.stdout.write(paint("gray", "\n(Ctrl+C again to exit)\n"));
    prompt();
  });

  function contextWindowChars(model) {
    const m = /(\d+)k/i.exec(model || "");
    const tokens = m ? parseInt(m[1], 10) * 1000 : 128000;
    return tokens * 4;
  }

  const promptText = () => {
    const winChars = contextWindowChars(config.model);
    const used = JSON.stringify(session.messages).length;
    const pctLeft = Math.max(0, Math.round(100 - (used / winChars) * 100));
    const ctx = paint("gray", `${pctLeft}% ctx`);
    return (planMode ? paint("yellow", "[plan] ") : "") + paint("green", "❯ ") + ctx + " ";
  };
  function prompt() {
    rl.setPrompt(promptText());
    rl.prompt();
  }

  async function handleSlash(input) {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        process.stdout.write(HELP + "\n");
        break;
      case "new":
        saveSession(session);
        session = newSession();
        process.stdout.write(paint("gray", "(new session)\n"));
        break;
      case "sessions": {
        const list = listSessions();
        if (!list.length) process.stdout.write(paint("gray", "(no sessions)\n"));
        for (const s of list) {
          process.stdout.write(`  ${paint("cyan", s.id)}  ${paint("gray", s.preview)}\n`);
        }
        break;
      }
      case "resume": {
        const s = loadSession(arg);
        if (!s) {
          process.stdout.write(paint("red", `Session not found: ${arg}\n`));
        } else {
          saveSession(session);
          session = s;
          process.stdout.write(paint("gray", `(resumed ${arg}, ${s.messages.length} messages)\n`));
        }
        break;
      }
      case "model":
        if (arg) {
          config.model = arg;
          process.stdout.write(paint("gray", `(model set to ${arg})\n`));
        } else {
          try {
            const { discoverModels } = await import("./discover.js");
            const models = await discoverModels(config);
            process.stdout.write(paint("gray", `current: ${config.model}\navailable on ${config.baseURL}:\n`));
            models.forEach((m, i) => process.stdout.write(`  ${paint("cyan", String(i + 1).padStart(3))}  ${m}${m === config.model ? paint("green", "  ←") : ""}\n`));
            const pick = await new Promise((r) => rl.question(paint("bold", "Pick a number (Enter to keep current): "), r));
            const n = parseInt(pick.trim(), 10);
            if (n >= 1 && n <= models.length) {
              config.model = models[n - 1];
              process.stdout.write(paint("gray", `(model set to ${config.model})\n`));
            }
          } catch (e) {
            process.stdout.write(paint("red", `Model discovery failed: ${e.message}\n`));
          }
        }
        break;
      case "models":
        if (arg === "refresh") {
          try {
            const { discoverModels } = await import("./discover.js");
            const models = await discoverModels(config, { force: true });
            process.stdout.write(paint("gray", `(refreshed: ${models.length} models from ${config.baseURL})\n`));
          } catch (e) {
            process.stdout.write(paint("red", `Refresh failed: ${e.message}\n`));
          }
        } else {
          process.stdout.write(paint("gray", "Usage: /models refresh\n"));
        }
        break;
      case "fallback":
        if (arg) {
          config.fallbackModels = config.fallbackModels || [];
          if (arg === "clear") {
            config.fallbackModels = [];
            process.stdout.write(paint("gray", "(fallbacks cleared)\n"));
          } else if (!config.fallbackModels.includes(arg)) {
            config.fallbackModels.push(arg);
            process.stdout.write(paint("gray", `(fallback added: ${arg})\n`));
          }
        } else {
          const list = config.fallbackModels || [];
          process.stdout.write(
            paint("gray", list.length ? `chain: ${config.model} → ${list.join(" → ")}` : "(no fallbacks — /fallback <model> to add)") + "\n"
          );
        }
        break;
      case "plan":
        planMode = !planMode;
        process.stdout.write(paint("gray", `(plan mode ${planMode ? "on" : "off"})\n`));
        break;
      case "compact": {
        const { compactSession } = await import("./agent.js");
        await compactSession(session, config);
        saveSession(session);
        process.stdout.write(paint("gray", "(compacted)\n"));
        break;
      }
      case "status": {
        const { detectShell } = await import("./tools.js");
        const winChars = contextWindowChars(config.model);
        const used = JSON.stringify(session.messages).length;
        const pctLeft = Math.max(0, Math.round(100 - (used / winChars) * 100));
        process.stdout.write(
          [
            `model:    ${config.model}`,
            `baseURL:  ${config.baseURL}`,
            `shell:    ${detectShell().name}`,
            `session:  ${session.id} (${session.messages.length} messages)`,
            `context:  ${pctLeft}% left (${used.toLocaleString()} chars)`,
            `usage:    ${session.usage.prompt} prompt + ${session.usage.completion} completion tokens`,
            `cost:     $${(session.cost || 0).toFixed(4)}${config.budget ? ` / budget $${config.budget}` : ""}`,
            `mode:     ${planMode ? "plan (read-only)" : config.yolo ? "yolo" : "default"}`,
          ].join("\n") + "\n"
        );
        break;
      }
      case "review": {
        const { currentDiff } = await import("./checkpoint.js");
        const diff = currentDiff(process.cwd(), arg || null);
        if (diff.length > 30000) {
          process.stdout.write(paint("yellow", `(diff is ${diff.length} chars — truncated to 30k for review)\n`));
        }
        running = true;
        currentAbort = new AbortController();
        try {
          process.stdout.write("\n");
          await runAgent({
            session,
            userText:
              "Review the following code changes. Do NOT modify any files. Report prioritized findings: bugs, security issues, regressions, and style problems. If clean, say so.\n\n```diff\n" +
              diff.slice(0, 30000) +
              "\n```",
            config,
            permissions,
            planMode: true,
            signal: currentAbort.signal,
          });
          process.stdout.write("\n");
        } catch (e) {
          process.stdout.write(paint("red", `✗ ${e.message}\n`));
        } finally {
          running = false;
          currentAbort = null;
        }
        break;
      }
      case "rewind": {
        if (!lastCheckpoint) {
          process.stdout.write(paint("gray", "(no checkpoint yet — checkpoints are created before each task)\n"));
          break;
        }
        const { rewind } = await import("./checkpoint.js");
        try {
          const msg = rewind(process.cwd(), lastCheckpoint);
          lastCheckpoint = null;
          process.stdout.write(paint("gray", `(rewound: ${msg})\n`));
        } catch (e) {
          process.stdout.write(paint("red", `✗ rewind failed: ${e.message}\n`));
        }
        break;
      }
      case "init": {
        running = true;
        currentAbort = new AbortController();
        try {
          process.stdout.write("\n");
          await runAgent({
            session,
            userText:
              "Explore this repository with read/glob/grep, then write an AGENTS.md at the repo root documenting: project purpose, structure, build/test/dev commands, conventions, and anything a coding agent must know. Keep it concise and accurate. If AGENTS.md already exists, update it instead.",
            config,
            permissions,
            planMode: false,
            signal: currentAbort.signal,
          });
          process.stdout.write("\n");
        } catch (e) {
          process.stdout.write(paint("red", `✗ ${e.message}\n`));
        } finally {
          running = false;
          currentAbort = null;
        }
        break;
      }
      case "memory": {
        const { readMemory, USER_FILE, SOUL_FILE } = await import("./memory.js");
        const mem = readMemory(process.cwd());
        const user = readMemory(process.cwd(), USER_FILE);
        const soul = readMemory(process.cwd(), SOUL_FILE);
        if (!mem && !user && !soul) {
          process.stdout.write(paint("gray", "(no memory yet — learnings appear here as you work)\n"));
        } else {
          if (soul) process.stdout.write(paint("bold", "SOUL.md\n") + soul + "\n");
          if (mem) process.stdout.write(paint("bold", "MEMORY.md\n") + mem + "\n");
          if (user) process.stdout.write(paint("bold", "USER.md\n") + user + "\n");
        }
        break;
      }
      case "personality": {
        const fsMod = await import("node:fs");
        const pathMod = await import("node:path");
        if (!arg) {
          process.stdout.write(paint("gray", "Usage: /personality <name|off> — sets SOUL.md persona\n"));
          break;
        }
        const personas = {
          concise: "You are terse and direct. Minimal words, no fluff, code-first answers.",
          mentor: "You are a patient mentor. Explain the why behind changes, teach as you go.",
          pirate: "You are a pirate. Arr. Otherwise a fully capable coding agent.",
        };
        const p = pathMod.join(process.cwd(), "SOUL.md");
        if (arg === "off") {
          try { fsMod.unlinkSync(p); } catch {}
          process.stdout.write(paint("gray", "(persona cleared)\n"));
        } else {
          const body = personas[arg] || arg; // unknown names treated as literal persona text
          fsMod.writeFileSync(p, `# Persona\n\n${body}\n`);
          process.stdout.write(paint("gray", `(persona set → SOUL.md${personas[arg] ? "" : " (custom)"})\n`));
        }
        break;
      }
      case "recall": {
        if (!arg) {
          process.stdout.write(paint("gray", "Usage: /recall <query> — search past sessions\n"));
          break;
        }
        const { recall } = await import("./recall.js");
        const { hits, summary } = await recall(arg, config);
        if (!hits.length) {
          process.stdout.write(paint("gray", `(no past sessions mention "${arg}")\n`));
          break;
        }
        process.stdout.write(paint("gray", `(${hits.length} excerpt${hits.length > 1 ? "s" : ""} from past sessions)\n`));
        if (summary) process.stdout.write(summary + "\n");
        else for (const h of hits) process.stdout.write(paint("gray", `  [${h.sessionId} · ${h.role}] ${h.snippet}\n`));
        break;
      }
      case "usage":
        process.stdout.write(
          paint("gray", `prompt: ${session.usage.prompt} | completion: ${session.usage.completion} | cost: $${(session.cost || 0).toFixed(4)}\n`)
        );
        break;
      case "yolo":
        config.yolo = !config.yolo;
        process.stdout.write(paint("gray", `(yolo ${config.yolo ? "on" : "off"} — applies to new permissions)\n`));
        break;
      case "exit":
      case "quit":
        saveSession(session);
        process.exit(0);
        break;
      default:
        process.stdout.write(paint("red", `Unknown command: /${cmd}. Try /help.\n`));
    }
  }

  async function runTask(userText) {
    running = true;
    currentAbort = new AbortController();
    const turnStart = session.messages.length;
    try {
      const { createCheckpoint } = await import("./checkpoint.js");
      lastCheckpoint = createCheckpoint(process.cwd());
    } catch {
      lastCheckpoint = null;
    }
    try {
      process.stdout.write("\n");
      await runAgent({
        session,
        userText,
        config,
        permissions,
        planMode,
        signal: currentAbort.signal,
      });
      process.stdout.write("\n");
      try {
        const { extractLearnings, appendLearnings, USER_FILE } = await import("./memory.js");
        const { memory: mem, user } = await extractLearnings(session, config, process.cwd());
        const nM = mem ? appendLearnings(mem, process.cwd()) : 0;
        const nU = user ? appendLearnings(user, process.cwd(), USER_FILE) : 0;
        if (nM || nU) {
          const parts = [];
          if (nM) parts.push(`+${nM} → MEMORY.md`);
          if (nU) parts.push(`+${nU} → USER.md`);
          process.stdout.write(paint("gray", `(memory: ${parts.join(", ")})\n`));
        }
      } catch {}
      try {
        const { countToolCallsSince, proposeSkill, saveSkill } = await import("./skills.js");
        if (countToolCallsSince(session.messages, turnStart) >= 3 && process.stdin.isTTY) {
          const proposal = await proposeSkill(session, config, turnStart);
          if (proposal) {
            const answer = await new Promise((r) =>
              rl.question(
                paint("bold", `That workflow looks reusable. Save as /${proposal.name} (${proposal.description || "custom command"})? [y/N] `),
                r
              )
            );
            if (answer.trim().toLowerCase().startsWith("y")) {
              const p = saveSkill(proposal.name, proposal.content, process.cwd());
              process.stdout.write(paint("gray", `(saved → ${p} — run it with /${proposal.name})\n`));
            }
          }
        }
      } catch {}
    } catch (e) {
      process.stdout.write(paint("red", `✗ ${e.message}\n`));
    } finally {
      running = false;
      currentAbort = null;
    }
  }

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }
    rl.pause();
    if (input === "/undo") {
      const removed = popLastTurn(session);
      process.stdout.write(
        paint("gray", removed ? `(undid last turn: "${removed.slice(0, 60)}${removed.length > 60 ? "…" : ""}")` : "(nothing to undo)") + "\n"
      );
      prompt();
      return;
    }
    if (input === "/retry") {
      const removed = popLastTurn(session);
      if (!removed) {
        process.stdout.write(paint("gray", "(nothing to retry)\n"));
        prompt();
        return;
      }
      process.stdout.write(paint("gray", `(retrying: "${removed.slice(0, 60)}${removed.length > 60 ? "…" : ""}")\n`));
      await runTask(removed);
      prompt();
      return;
    }
    if (input.startsWith("/")) {
      const [cmdName, ...cmdRest] = input.slice(1).split(/\s+/);
      const { loadCommands } = await import("./commands.js");
      const custom = loadCommands(process.cwd()).get(cmdName);
      if (custom) {
        const body = custom.body.replace(/\$ARGUMENTS/g, cmdRest.join(" "));
        await runTask(body);
        prompt();
        return;
      }
      await handleSlash(input);
      prompt();
      return;
    }
    await runTask(input);
    prompt();
  });

  rl.on("close", () => {
    saveSession(session);
    process.exit(0);
  });

  prompt();
}
