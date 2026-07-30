import readline from "node:readline";
import { runAgent } from "./agent.js";
import { createPermissions } from "./permissions.js";
import { newSession, loadSession, listSessions, saveSession } from "./session.js";
import { saveConfig } from "./config.js";
import { paint } from "./ui.js";

const HELP = `
${paint("bold", "Commands:")}
  /help              show this help
  /new               start a new session
  /sessions          list recent sessions
  /resume <id>       resume a session
  /model [name]      show/switch model (no arg = pick from provider list)
  /models refresh    re-fetch available models from the provider
  /plan              toggle plan mode (read-only)
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

  const promptText = () => (planMode ? paint("yellow", "[plan] ") : "") + paint("green", "❯ ");
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

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      prompt();
      return;
    }
    rl.pause();
    if (input.startsWith("/")) {
      await handleSlash(input);
      prompt();
      return;
    }
    running = true;
    currentAbort = new AbortController();
    try {
      process.stdout.write("\n");
      await runAgent({
        session,
        userText: input,
        config,
        permissions,
        planMode,
        signal: currentAbort.signal,
      });
      process.stdout.write("\n");
    } catch (e) {
      process.stdout.write(paint("red", `✗ ${e.message}\n`));
    } finally {
      running = false;
      currentAbort = null;
    }
    prompt();
  });

  rl.on("close", () => {
    saveSession(session);
    process.exit(0);
  });

  prompt();
}
