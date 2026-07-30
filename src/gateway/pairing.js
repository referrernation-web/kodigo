import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME_DIR, saveConfig } from "../config.js";

const STORE_PATH = path.join(HOME_DIR, "telegram.json");

export function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    s.allowedUsers ??= [];
    s.pending ??= {};
    return s;
  } catch {
    return { allowedUsers: [], pending: {} };
  }
}

export function saveStore(store) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export function issuePairingCode(store, userId) {
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  store.pending[code] = { userId, createdAt: Date.now() };
  saveStore(store);
  return code;
}

export function approvePairing(store, code) {
  const entry = store.pending[code];
  if (!entry) return null;
  if (!store.allowedUsers.includes(entry.userId)) store.allowedUsers.push(entry.userId);
  delete store.pending[code];
  saveStore(store);
  return entry.userId;
}

export function isAllowed(store, userId) {
  // default-deny: empty allowlist blocks everyone (claudeclaw v1.0.26 lesson)
  return store.allowedUsers.includes(userId);
}
