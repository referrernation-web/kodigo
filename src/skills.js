import fs from "node:fs";
import path from "node:path";
import { complete } from "./llm.js";
import { parseFrontmatter, commandsDir } from "./commands.js";

export function countToolCallsSince(messages, fromIndex) {
  let count = 0;
  for (const m of messages.slice(fromIndex)) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) count += m.tool_calls.length;
  }
  return count;
}

export async function proposeSkill(session, config, fromIndex) {
  const turn = session.messages.slice(fromIndex);
  const toolNames = [];
  const transcript = turn
    .map((m) => {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const t of m.tool_calls) toolNames.push(t.function?.name);
        return `assistant: ${(m.content || "").slice(0, 300)} [tools: ${toolNames.slice(-m.tool_calls.length).join(", ")}]`;
      }
      if (m.role === "tool") return `tool result: ${String(m.content).slice(0, 200)}`;
      return `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 500) : ""}`;
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
            "This agent turn used tools: " +
            [...new Set(toolNames)].join(", ") +
            ". Decide if the WORKFLOW is a reusable procedure worth saving as a slash command (like /review or /deploy). " +
            "Only say yes if a future user would plausibly ask for the same procedure by name. " +
            "If yes, output EXACTLY a markdown file: frontmatter (---\\nname: <short-kebab-name>\\ndescription: <one line>\\n---\\n) then the instruction body for the agent, using $ARGUMENTS where user input goes. " +
            "If not reusable, output exactly NONE.\n\nTurn transcript:\n" +
            transcript.slice(0, 8000),
        },
      ],
    });
    const trimmed = out.trim();
    if (!trimmed || trimmed.toUpperCase().startsWith("NONE")) return null;
    const { meta, body } = parseFrontmatter(trimmed);
    if (!meta.name || !/^[a-z0-9][a-z0-9-]*$/.test(meta.name) || !body.trim()) return null;
    return { name: meta.name, description: meta.description || "", content: trimmed };
  } catch {
    return null;
  }
}

export function saveSkill(name, content, cwd = process.cwd()) {
  const dir = commandsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name + ".md");
  fs.writeFileSync(p, content + (content.endsWith("\n") ? "" : "\n"));
  return p;
}
