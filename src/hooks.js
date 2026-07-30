import { spawn } from "node:child_process";
import { detectShell } from "./tools.js";

function runHook(command, cwd, timeoutMs = 30000) {
  const shell = detectShell();
  return new Promise((resolve) => {
    const child = spawn(shell.command, shell.args(command), { cwd });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ code: -1, out: out + "\n(hook timed out)" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: "Error: " + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out: out.trim() });
    });
  });
}

export function hooksFor(config, phase, toolName) {
  const hooks = config.hooks?.[phase];
  if (!Array.isArray(hooks)) return [];
  return hooks.filter((h) => h && (h.tool === toolName || h.tool === "*"));
}

export async function runHooks(config, phase, toolName, cwd) {
  const results = [];
  for (const h of hooksFor(config, phase, toolName)) {
    const r = await runHook(h.command, cwd);
    results.push({ command: h.command, ...r });
    if (phase === "pre" && r.code !== 0) {
      return { denied: true, message: `Hook denied ${toolName}: ${h.command} exited ${r.code}\n${r.out}`.trim(), results };
    }
  }
  const appended = results.map((r) => r.out).filter(Boolean).join("\n");
  return { denied: false, appended, results };
}
