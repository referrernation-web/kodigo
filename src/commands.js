import fs from "node:fs";
import path from "node:path";

export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

export function commandsDir(cwd = process.cwd()) {
  return path.join(cwd, ".kodigo", "commands");
}

export function loadCommands(cwd = process.cwd()) {
  const dir = commandsDir(cwd);
  const out = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), "utf8"));
      const name = meta.name || f.replace(/\.md$/, "");
      out.set(name, { name, description: meta.description || "", body: body.trim() });
    } catch {}
  }
  return out;
}
