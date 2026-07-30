import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME_DIR = path.join(os.homedir(), ".kodigo");
export const SESSIONS_DIR = path.join(HOME_DIR, "sessions");
export const CONFIG_PATH = path.join(HOME_DIR, "config.json");

const DEFAULTS = {
  baseURL: "https://openrouter.ai/api/v1",
  model: "anthropic/claude-sonnet-4.5",
  apiKey: "",
  maxSteps: 100,
  autoCompactChars: 120000,
  bashTimeoutMs: 120000,
  yolo: false,
  budget: 0,
  pricing: {
    "k3-256k": { prompt: 0.6, completion: 2.5 },
    "k3": { prompt: 0.6, completion: 2.5 },
    "default": { prompt: 1.0, completion: 3.0 },
  },
};

export function ensureDirs() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}

  let project = {};
  const projPath = path.join(process.cwd(), "kodigo.json");
  try {
    project = JSON.parse(fs.readFileSync(projPath, "utf8"));
  } catch {}

  const cfg = { ...DEFAULTS, ...file, ...project };
  cfg.apiKey =
    process.env.KODIGO_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    cfg.apiKey;
  cfg.baseURL = process.env.KODIGO_BASE_URL || process.env.OPENAI_BASE_URL || cfg.baseURL;
  cfg.model = process.env.KODIGO_MODEL || cfg.model;
  cfg.baseURL = cfg.baseURL.replace(/\/+$/, "");
  return cfg;
}

export function saveConfig(patch) {
  ensureDirs();
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...patch }, null, 2));
}

export function loadProjectContext(cwd = process.cwd()) {
  const names = ["AGENTS.md", "CLAUDE.md", "KODIGO.md"];
  const found = [];
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) {
        try {
          found.push({ path: p, content: fs.readFileSync(p, "utf8").slice(0, 20000) });
        } catch {}
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (fs.existsSync(path.join(dir, ".git"))) break;
    dir = parent;
  }
  return found;
}
