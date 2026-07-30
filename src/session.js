import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDirs, SESSIONS_DIR } from "./config.js";

export function newSession() {
  return {
    version: 1,
    id: Date.now().toString(36) + "-" + crypto.randomBytes(2).toString("hex"),
    createdAt: new Date().toISOString(),
    messages: [],
    usage: { prompt: 0, completion: 0 },
    cost: 0,
  };
}

export function saveSession(s) {
  ensureDirs();
  fs.writeFileSync(path.join(SESSIONS_DIR, s.id + ".json"), JSON.stringify(s, null, 2));
}

export function loadSession(id) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id + ".json"), "utf8"));
    if (!s || !Array.isArray(s.messages)) return null;
    s.version ??= 1;
    s.usage ??= { prompt: 0, completion: 0 };
    s.cost ??= 0;
    return s;
  } catch {
    return null;
  }
}

export function latestSession() {
  const files = listSessionFiles();
  if (!files.length) return null;
  return loadSession(files[0].id);
}

export function listSessions(n = 10) {
  const files = listSessionFiles().slice(0, n);
  return files.map(({ id }) => {
    const s = loadSession(id);
    const firstUser = s?.messages?.find((m) => m.role === "user");
    const preview = (typeof firstUser?.content === "string" ? firstUser.content : "")
      .replace(/\s+/g, " ")
      .slice(0, 60);
    return {
      id,
      mtime: files.find((f) => f.id === id)?.mtime,
      preview: preview || "(empty)",
    };
  });
}

export function popLastTurn(session) {
  while (session.messages.length && session.messages[session.messages.length - 1].role !== "user") {
    session.messages.pop();
  }
  if (!session.messages.length) return null;
  const userMsg = session.messages.pop();
  saveSession(session);
  return typeof userMsg.content === "string" ? userMsg.content : null;
}

function listSessionFiles() {  ensureDirs();
  try {
    return fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        id: f.replace(/\.json$/, ""),
        mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}
