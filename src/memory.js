import fs from "node:fs";
import path from "node:path";
import { complete } from "./llm.js";

export const MEMORY_FILE = "MEMORY.md";
const HEADER = "# Memory\n\nLearnings kodigo picked up across sessions. Edit freely — this file is injected into every session's context.\n\n## Learnings\n";

export function memoryPath(cwd = process.cwd()) {
  return path.join(cwd, MEMORY_FILE);
}

export function readMemory(cwd = process.cwd()) {
  try {
    return fs.readFileSync(memoryPath(cwd), "utf8");
  } catch {
    return "";
  }
}

export function appendLearnings(bullets, cwd = process.cwd()) {
  const list = bullets
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-") && l.length > 3);
  if (!list.length) return 0;
  const p = memoryPath(cwd);
  if (!fs.existsSync(p)) fs.writeFileSync(p, HEADER + "\n");
  fs.appendFileSync(p, list.join("\n") + "\n");
  return list.length;
}

export async function extractLearnings(session, config) {
  const recent = session.messages.slice(-12);
  if (recent.length < 3) return "";
  const transcript = recent
    .map((m) => {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        return `assistant: ${(m.content || "").slice(0, 300)} [tools: ${m.tool_calls.map((t) => t.function?.name).join(", ")}]`;
      }
      return `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 600) : ""}`;
    })
    .join("\n");
  try {
    const out = await complete({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        {
          role: "user",
          content:
            "From this coding session excerpt, extract durable learnings worth remembering for FUTURE sessions in this project: build/test commands that worked, project conventions, gotchas, environment quirks. Output 0-5 short markdown bullets starting with '- '. If nothing is durable or new, output exactly 'NONE'.\n\n" +
            transcript,
        },
      ],
    });
    const trimmed = out.trim();
    if (!trimmed || trimmed.toUpperCase().startsWith("NONE")) return "";
    return trimmed;
  } catch {
    return "";
  }
}
