import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./config.js";
import { complete } from "./llm.js";

export function searchSessions(query, { limit = 10 } = {}) {
  let re;
  try {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  } catch {
    return [];
  }
  const hits = [];
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const f of files) {
    let session;
    try {
      session = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(session.messages)) continue;
    for (const m of session.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = typeof m.content === "string" ? m.content : "";
      if (!text || !re.test(text)) continue;
      const idx = text.search(re);
      const snippet = text.slice(Math.max(0, idx - 80), idx + 220).replace(/\s+/g, " ").trim();
      hits.push({ sessionId: session.id || f, role: m.role, snippet });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export async function recall(query, config) {
  const hits = searchSessions(query);
  if (!hits.length) return { hits, summary: "" };
  const material = hits.map((h) => `[${h.sessionId} · ${h.role}] ${h.snippet}`).join("\n");
  try {
    const summary = await complete({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        {
          role: "user",
          content:
            `These are excerpts from past coding sessions matching "${query}". Summarize what happened / what was learned about this topic across sessions, concisely. Reference session ids when useful.\n\n` +
            material,
        },
      ],
    });
    return { hits, summary };
  } catch {
    return { hits, summary: "" };
  }
}
