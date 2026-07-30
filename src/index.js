#!/usr/bin/env node
import { ensureDirs, loadConfig } from "./config.js";
import { newSession, latestSession, saveSession } from "./session.js";
import { startRepl } from "./repl.js";
import { runAgent } from "./agent.js";
import { createPermissions } from "./permissions.js";
import { paint } from "./ui.js";

const VERSION = "0.1.0";

const HELP = `
kodigo — AI coding agent in your terminal

Usage:
  kodigo                    interactive mode (new session)
  kodigo -c, --continue     continue the most recent session
  kodigo run "<prompt>"     one-shot mode, then exit
  kodigo config             show resolved configuration
  kodigo --version          print version
  kodigo --help             show this help

Flags:
  --yolo                    auto-approve all tool calls
  --plan                    read-only plan mode
  --model <name>            override the model
  --budget <usd>            hard stop when session cost reaches this

Env:
  KODIGO_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY
  KODIGO_BASE_URL (default https://openrouter.ai/api/v1)
  KODIGO_MODEL
`;

function parseArgs(argv) {
  const opts = { _: [], yolo: false, plan: false, cont: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yolo") opts.yolo = true;
    else if (a === "--plan") opts.plan = true;
    else if (a === "-c" || a === "--continue") opts.cont = true;
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--budget") opts.budget = parseFloat(argv[++i]) || 0;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else opts._.push(a);
  }
  return opts;
}

async function main() {
  ensureDirs();
  const config = loadConfig();
  const opts = parseArgs(process.argv.slice(2));
  if (opts.yolo) config.yolo = true;
  if (opts.model) config.model = opts.model;
  if (opts.budget) config.budget = opts.budget;

  if (opts.help) {
    process.stdout.write(HELP + "\n");
    return;
  }
  if (opts.version) {
    process.stdout.write(VERSION + "\n");
    return;
  }

  const cmd = opts._[0];

  if (cmd === "config") {
    const masked = config.apiKey ? config.apiKey.slice(0, 8) + "…" : "(not set)";
    process.stdout.write(
      JSON.stringify({ ...config, apiKey: masked }, null, 2) + "\n"
    );
    return;
  }

  if (cmd === "run") {
    const prompt = opts._.slice(1).join(" ").trim();
    if (!prompt) {
      process.stderr.write('Usage: kodigo run "<prompt>"\n');
      process.exit(1);
    }
    if (!config.apiKey) {
      process.stderr.write(paint("red", "No API key. Set KODIGO_API_KEY or run `kodigo` interactively.\n"));
      process.exit(1);
    }
    const session = newSession();
    const permissions = createPermissions({ yolo: config.yolo });
    try {
      await runAgent({
        session,
        userText: prompt,
        config,
        permissions,
        planMode: opts.plan,
        signal: null,
      });
      saveSession(session);
    } catch (e) {
      process.stderr.write(paint("red", `✗ ${e.message}\n`));
      process.exit(1);
    }
    return;
  }

  let session;
  if (opts.cont) {
    session = latestSession();
    if (!session) {
      process.stdout.write(paint("gray", "(no previous session, starting fresh)\n"));
      session = newSession();
    }
  } else {
    session = newSession();
  }
  if (opts.plan) {
    process.stdout.write(paint("gray", "(starting in plan mode)\n"));
  }
  await startRepl({ config, session, initialPlanMode: opts.plan });
}

main().catch((e) => {
  process.stderr.write(paint("red", `✗ ${e.message}\n`));
  process.exit(1);
});
