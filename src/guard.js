import os from "node:os";
import path from "node:path";

const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g;

export function redactSecrets(text) {
  return String(text).replace(SECRET_RE, (m) => m.slice(0, 6) + "…[redacted]");
}

const DENY_DIRS = [path.join(os.homedir(), ".kodigo"), path.join(os.homedir(), ".ssh"), path.join(os.homedir(), ".aws")];
const DENY_FILE_RE = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$/i;

export function isDeniedPath(p) {
  const abs = path.resolve(p);
  for (const dir of DENY_DIRS) {
    if (abs === dir || abs.startsWith(dir + path.sep)) return true;
  }
  return DENY_FILE_RE.test(path.basename(abs));
}

export const DENIED_MSG = "Error: access denied (sensitive path)";
