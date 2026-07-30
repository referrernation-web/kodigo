import fs from "node:fs";
import path from "node:path";
import { complete } from "./llm.js";

export const MEMORY_FILE = "MEMORY.md";
export const USER_FILE = "USER.md";
export const SOUL_FILE = "SOUL.md";
const HEADER = "# Memory\n\nLearnings kodigo picked up across sessions. Edit freely — this file is injected into every session's context.\n\n## Learnings\n";
const USER_HEADER = "# User\n\nWhat kodigo knows about the user — environment, preferences, habits. Edit freely.\n\n## Facts\n";

export function memoryPath(cwd = process.cwd()) {
  return path.join(cwd, MEMORY_FILE);
}

export function readMemory(cwd = process.cwd(), file = MEMORY_FILE) {
  try {
    return fs.readFileSync(path.join(cwd, file), "utf8");
  } catch {
    return "";
  }
}

export function appendLearnings(bullets, cwd = process.cwd(), file = MEMORY_FILE) {
  const list = bullets
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-") && l.length > 3);
  if (!list.length) return 0;
  const existing = readMemory(cwd, file);
  const deduped = list.filter((l) => !existing.includes(l.slice(2).trim().slice(0, 30)));
  if (!deduped.length) return 0;
  const p = path.join(cwd, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, (file === USER_FILE ? USER_HEADER : HEADER) + "\n");
  fs.appendFileSync(p, deduped.join("\n") + "\n");
  return deduped.length;
}

export async function extractLearnings(session, config, cwd = process.cwd()) {
  const recent = session.messages.slice(-12);
  if (recent.length < 3) return { memory: "", user: "" };
  const transcript = recent
    .map((m) => {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        return `assistant: ${(m.content || "").slice(0, 300)} [tools: ${m.tool_calls.map((t) => t.function?.name).join(", ")}]`;
      }
      return `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 600) : ""}`;
    })
    .join("\n");
  const existing = readMemory(cwd).slice(0, 4000);
  try {
    const out = await complete({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        {
          role: "user",
          content:
            "From this coding session excerpt, extract durable knowledge for FUTURE sessions, in two sections.\n" +
            "MEMORY: project facts — build/test commands that worked, project conventions, gotchas.\n" +
            "USER: facts about the person — their environment, tools, preferences, habits.\n" +
            "Output format:\nMEMORY:\n- bullet\n- bullet\nUSER:\n- bullet\n" +
            "0-4 bullets per section, skip a section entirely if nothing durable. Do NOT repeat anything already known:\n" +
            existing +
            "\n\nSession excerpt:\n" +
            transcript,
        },
      ],
    });
    const memMatch = /MEMORY:\s*\n([\s\S]*?)(?:\nUSER:|$)/i.exec(out);
    const userMatch = /USER:\s*\n([\s\S]*)$/i.exec(out);
    return {
      memory: memMatch && memMatch[1].includes("-") ? memMatch[1].trim() : "",
      user: userMatch && userMatch[1].includes("-") ? userMatch[1].trim() : "",
    };
  } catch {
    return { memory: "", user: "" };
  }
}
