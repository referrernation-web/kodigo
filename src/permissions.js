import readline from "node:readline";
import { paint, printDiff } from "./ui.js";

const AUTO_ALLOW = new Set(["read", "glob", "grep", "webfetch", "todowrite"]);

export function createPermissions({ yolo = false, rl = null } = {}) {
  const alwaysAllowed = new Set();
  let warnedNonTTY = false;

  async function ask(toolName, input) {
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

    const answer = await new Promise((resolve) => {
      if (rl) {
        rl.question(paint("bold", `Allow ${toolName}? [y]es / [n]o / [a]lways: `), resolve);
      } else {
        const tmp = readline.createInterface({ input: process.stdin, output: process.stdout });
        tmp.question(paint("bold", `Allow ${toolName}? [y]es / [n]o / [a]lways: `), (a) => {
          tmp.close();
          resolve(a);
        });
      }
    });

    const a = answer.trim().toLowerCase();
    if (a === "a" || a === "always") {
      alwaysAllowed.add(toolName);
      return true;
    }
    return a === "y" || a === "yes" || a === "";
  }

  return { ask };
}
