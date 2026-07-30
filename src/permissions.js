import readline from "node:readline";
import { paint, printDiff } from "./ui.js";

const AUTO_ALLOW = new Set(["read", "glob", "grep", "todowrite"]);

export function createPermissions({ yolo = false, rl = null } = {}) {
  const alwaysAllowed = new Set();
  const allowedDomains = new Set();
  let warnedNonTTY = false;

  async function ask(toolName, input) {
    if (toolName === "webfetch") {
      let domain = "";
      try {
        domain = new URL(input.url).hostname;
      } catch {
        return false;
      }
      if (yolo || allowedDomains.has(domain)) return true;
      if (!process.stdin.isTTY) return true;
      const answer = await askPrompt(`Allow fetching ${domain}? [y]es / [n]o / [a]lways: `);
      if (answer === "a") {
        allowedDomains.add(domain);
        return true;
      }
      return answer === "y";
    }
    if (AUTO_ALLOW.has(toolName)) return true;
    if (yolo || alwaysAllowed.has(toolName)) return true;
    if (!process.stdin.isTTY) {
      if (!warnedNonTTY) {
        warnedNonTTY = true;
        process.stdout.write(paint("gray", "(non-interactive: auto-allowing all tools)\n"));
      }
      return true;
    }

    if (toolName === "bash") {
      process.stdout.write(paint("yellow", `  $ ${input.command}\n`));
    } else if (toolName === "edit") {
      printDiff(input.filePath, input.oldString, input.newString);
    } else if (toolName === "write") {
      const lines = String(input.content).split("\n");
      process.stdout.write(paint("gray", `  ${input.filePath} (${lines.length} lines)\n`));
      for (const l of lines.slice(0, 12)) process.stdout.write(paint("green", `  + ${l}\n`));
      if (lines.length > 12) process.stdout.write(paint("gray", `  + …(${lines.length - 12} more)\n`));
    }

    const a = await askPrompt(paint("bold", `Allow ${toolName}? [y]es / [n]o / [a]lways: `));
    if (a === "a") {
      alwaysAllowed.add(toolName);
      return true;
    }
    return a === "y";
  }

  function askPrompt(message) {
    return new Promise((resolve) => {
      if (rl) {
        rl.question(message, (raw) => resolve(normalizeAnswer(raw)));
      } else {
        const tmp = readline.createInterface({ input: process.stdin, output: process.stdout });
        tmp.question(message, (raw) => {
          tmp.close();
          resolve(normalizeAnswer(raw));
        });
      }
    });
  }

  function normalizeAnswer(raw) {
    const a = String(raw).trim().toLowerCase();
    if (a === "a" || a === "always") return "a";
    if (a === "n" || a === "no") return "n";
    return "y"; // empty / y / yes
  }

  return { ask };
}
