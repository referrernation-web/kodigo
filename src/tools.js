import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { paint } from "./ui.js";

const OUT_CAP = 30000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function cap(s, limit = OUT_CAP) {
  s = String(s);
  return s.length > limit ? s.slice(0, limit) + "\n[output truncated]" : s;
}

function resolvePath(cwd, p) {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the project directory. Use for builds, tests, git, installs.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run" },
          timeout: { type: "number", description: "Timeout in ms (optional)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file with numbered lines. Supports offset/limit for large files.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          offset: { type: "number", description: "1-indexed line to start from" },
          limit: { type: "number", description: "Max lines (default 2000)" },
        },
        required: ["filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write a whole file, creating directories as needed. Prefer edit for existing files.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          content: { type: "string" },
        },
        required: ["filePath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Exact string replacement in a file. oldString must match exactly once unless replaceAll is set.",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["filePath", "oldString", "newString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files by glob pattern (supports **, *, ?).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Base directory (default cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex pattern. Returns file:line matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Base directory or file (default cwd)" },
          include: { type: "string", description: "File glob filter, e.g. *.js" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "webfetch",
      description: "Fetch a URL and return readable text (HTML stripped).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todowrite",
      description: "Update the task list. Use for multi-step work to track progress.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function globToRegex(pattern) {
  let re = "";
  const norm = pattern.replace(/\\/g, "/");
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        re += ".*";
        i++;
        if (norm[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

function isTextFile(full) {
  try {
    const st = fs.statSync(full);
    if (st.size > 1024 * 1024) return false;
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(Math.min(8192, st.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return !buf.includes(0);
  } catch {
    return false;
  }
}

async function runBash(input, ctx) {
  const timeout = input.timeout || ctx.config.bashTimeoutMs || 120000;
  return new Promise((resolve) => {
    const child = spawn(input.command, { shell: true, cwd: ctx.cwd });
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
    }, timeout);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve("Error: " + e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let res = cap(out.trim());
      if (killed) res += `\n(killed: exceeded ${timeout}ms timeout)`;
      if (code && code !== 0) res += `\n(exit code ${code})`;
      resolve(res || "(no output)");
    });
  });
}

function runRead(input, ctx) {
  const p = resolvePath(ctx.cwd, input.filePath);
  if (!fs.existsSync(p)) {
    let suggestion = "";
    try {
      const dir = path.dirname(p);
      const base = path.basename(p).toLowerCase();
      const similar = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().includes(base.slice(0, 4)) || base.includes(f.toLowerCase().slice(0, 4)))
        .slice(0, 5);
      if (similar.length) suggestion = ` Did you mean: ${similar.join(", ")}?`;
    } catch {}
    throw new Error(`File not found: ${p}.${suggestion}`);
  }
  if (fs.statSync(p).isDirectory()) {
    const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 200);
    return entries.map((e) => e.name + (e.isDirectory() ? "/" : "")).join("\n");
  }
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const offset = Math.max(1, input.offset || 1);
  const limit = input.limit || 2000;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let out = slice.map((l, i) => `${offset + i}: ${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
  if (offset - 1 + limit < lines.length) out += `\n(${lines.length - (offset - 1 + limit)} more lines)`;
  return cap(out);
}

function runWrite(input, ctx) {
  const p = resolvePath(ctx.cwd, input.filePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, input.content);
  return `Wrote ${Buffer.byteLength(input.content)} bytes to ${p}`;
}

function runEdit(input, ctx) {
  const p = resolvePath(ctx.cwd, input.filePath);
  if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
  const content = fs.readFileSync(p, "utf8");
  const parts = content.split(input.oldString);
  const count = parts.length - 1;
  if (count === 0) throw new Error("oldString not found in file");
  if (count > 1 && !input.replaceAll)
    throw new Error(`oldString appears ${count} times; provide more context or set replaceAll`);
  const next = parts.join(input.newString);
  fs.writeFileSync(p, next);
  return `Edited ${p} (${input.replaceAll ? count + " replacements" : "1 replacement"})`;
}

function runGlob(input, ctx) {
  const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
  const files = walk(base);
  const re = globToRegex(input.pattern);
  const matches = files
    .filter((f) => re.test(path.relative(base, f).replace(/\\/g, "/")) || re.test(f.replace(/\\/g, "/")))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 200)
    .map((m) => m.f);
  return matches.length ? matches.join("\n") : "(no matches)";
}

function runGrep(input, ctx) {
  const base = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;
  let re;
  try {
    re = new RegExp(input.pattern);
  } catch (e) {
    throw new Error("Invalid regex: " + e.message);
  }
  const includeRe = input.include ? globToRegex(input.include) : null;
  const files = fs.statSync(base).isDirectory() ? walk(base) : [base];
  const results = [];
  for (const f of files) {
    if (includeRe && !includeRe.test(path.basename(f))) continue;
    if (!isTextFile(f)) continue;
    let lines;
    try {
      lines = fs.readFileSync(f, "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        results.push(`${f}:${i + 1}: ${lines[i].slice(0, 500)}`);
        if (results.length >= 100) return cap(results.join("\n") + "\n[cap: 100 matches]");
      }
    }
  }
  return results.length ? results.join("\n") : "(no matches)";
}

async function runWebfetch(input) {
  const res = await fetch(input.url, {
    headers: { "User-Agent": "kodigo/0.1 (+https://localhost)" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${input.url}`);
  const type = res.headers.get("content-type") || "";
  let text = await res.text();
  if (type.includes("html")) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n\n")
      .trim();
  }
  return cap(text, 20000);
}

function runTodowrite(input, ctx) {
  ctx.todos.length = 0;
  for (const t of input.todos) ctx.todos.push({ content: t.content, status: t.status });
  const marks = { completed: paint("green", "✓"), in_progress: paint("cyan", "▸"), pending: paint("gray", "○") };
  const out = ctx.todos.map((t) => `  ${marks[t.status] || "○"} ${t.content}`).join("\n");
  process.stdout.write(out + "\n");
  return "Todos updated";
}

export async function executeTool(name, input, ctx) {
  try {
    if (ctx.planMode && ["bash", "write", "edit"].includes(name)) {
      return "Error: tool disabled in plan mode";
    }
    switch (name) {
      case "bash":
        return await runBash(input, ctx);
      case "read":
        return runRead(input, ctx);
      case "write":
        return runWrite(input, ctx);
      case "edit":
        return runEdit(input, ctx);
      case "glob":
        return runGlob(input, ctx);
      case "grep":
        return runGrep(input, ctx);
      case "webfetch":
        return await runWebfetch(input);
      case "todowrite":
        return runTodowrite(input, ctx);
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (e) {
    return "Error: " + e.message;
  }
}
