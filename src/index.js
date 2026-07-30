#!/usr/bin/env node
import { ensureDirs, loadConfig } from "./config.js";
import { newSession, latestSession, saveSession } from "./session.js";
import { startRepl } from "./repl.js";
import { runAgent } from "./agent.js";
import { createPermissions } from "./permissions.js";
import { createJsonRenderer, paint } from "./ui.js";

const VERSION = "0.1.0";

const HELP = `
kodigo — AI coding agent in your terminal

Usage:
  kodigo                    interactive mode (new session)
  kodigo -c, --continue     continue the most recent session
  kodigo run "<prompt>"     one-shot mode, then exit
  kodigo -p "<prompt>"      same; also accepts piped stdin
  kodigo config             show resolved configuration
  kodigo --version          print version
  kodigo --help             show this help

Flags:
  --yolo                    auto-approve all tool calls
  --plan                    read-only plan mode
  --model <name>            override the model
  --budget <usd>            hard stop when session cost reaches this
  --json                    emit events as JSON lines (for scripts/CI)

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
    else if (a === "--json") opts.json = true;
    else if (a === "-p") {
      // -p consumes the next arg as the prompt only if it isn't another flag
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) opts.print = argv[++i];
      else opts.print = true;
    }
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else opts._.push(a);
  }
  return opts;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function oneShot(prompt, config, opts) {
  if (!config.apiKey) {
    process.stderr.write(paint("red", "No API key. Set KODIGO_API_KEY or run `kodigo` interactively.\n"));
    process.exit(1);
  }
  const session = newSession();
  const permissions = createPermissions({ yolo: config.yolo });
  const emit = opts.json ? createJsonRenderer() : undefined;
  try {
    await runAgent({
      session,
      userText: prompt,
      config,
      permissions,
      planMode: opts.plan,
      signal: null,
      emit,
    });
    saveSession(session);
  } catch (e) {
    if (opts.json) process.stdout.write(JSON.stringify({ type: "error", message: e.message }) + "\n");
    else process.stderr.write(paint("red", `✗ ${e.message}\n`));
    process.exit(1);
  }
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

  if (cmd === "run" || opts.print !== undefined) {
    let prompt = opts.print !== undefined && opts.print !== true ? String(opts.print) : opts._.slice(1).join(" ").trim();
    const stdin = await readStdin();
    if (stdin) prompt = prompt ? `${prompt}\n\n${stdin}` : stdin;
    if (!prompt) {
      process.stderr.write('Usage: kodigo run "<prompt>" | kodigo -p "<prompt>" | <cmd> | kodigo -p\n');
      process.exit(1);
    }
    await oneShot(prompt, config, opts);
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
