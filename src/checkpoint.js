import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const REF = "refs/kodigo/checkpoints/latest";

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

export function isGitRepo(cwd) {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export function createCheckpoint(cwd) {
  if (isGitRepo(cwd)) {
    const indexPath = git(cwd, ["rev-parse", "--git-path", "index"]);
    const backup = indexPath + ".kodigo-bak";
    fs.copyFileSync(indexPath, backup);
    try {
      git(cwd, ["add", "-A"]);
      const tree = git(cwd, ["write-tree"]);
      let sha;
      try {
        const head = git(cwd, ["rev-parse", "HEAD"]);
        sha = git(cwd, ["commit-tree", tree, "-p", head, "-m", "kodigo checkpoint"]);
      } catch {
        sha = git(cwd, ["commit-tree", tree, "-m", "kodigo checkpoint"]);
      }
      git(cwd, ["update-ref", REF, sha]);
      return { kind: "git", ref: REF, sha };
    } finally {
      fs.copyFileSync(backup, indexPath);
      fs.unlinkSync(backup);
    }
  }
  // fallback: shadow copy for non-git directories
  const id = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  const dest = path.join(os.homedir(), ".kodigo", "checkpoints", id, "latest");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  copyTree(cwd, dest);
  return { kind: "shadow", dir: dest };
}

function copyTree(src, dest) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".next"].includes(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export function rewind(cwd, checkpoint) {
  if (!checkpoint) throw new Error("No checkpoint to rewind to");
  if (checkpoint.kind === "git") {
    git(cwd, ["restore", "--source", checkpoint.ref, "--worktree", "--staged", "--", "."]);
    git(cwd, ["clean", "-fd", "--", "."]);
    return "Restored tracked files from checkpoint and removed files created after it";
  }
  copyTree(checkpoint.dir, cwd);
  return "Restored files from shadow checkpoint";
}

export function currentDiff(cwd, base) {
  if (!isGitRepo(cwd)) return "(not a git repository — no diff available)";
  try {
    if (base) return git(cwd, ["diff", `${base}...HEAD`, "--", "."]);
    const uncommitted = git(cwd, ["diff", "HEAD", "--", "."]);
    if (uncommitted) return uncommitted;
    return "(working tree clean — nothing to review)";
  } catch (e) {
    return "(no commits yet — nothing to diff)";
  }
}
