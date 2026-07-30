import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { runAgent } from "../src/agent.js";
import { executeTool, detectShell } from "../src/tools.js";
import { isDeniedPath, redactSecrets } from "../src/guard.js";
import { newSession } from "../src/session.js";

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

function sse(chunks) {
  return chunks.map((d) => `data: ${JSON.stringify(d)}\n\n`).join("") + "data: [DONE]\n\n";
}

function toolCallChunks(id, name, argsJson) {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id, function: { name, arguments: argsJson } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function textChunks(text) {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("Content-Type", "text/event-stream");
        res.writeHead(200);
        res.end(handler(JSON.parse(body)));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("agent loop: tool call then text, writes file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const origCwd = process.cwd();
  process.chdir(tmp);
  let requestCount = 0;
  const server = await startMockServer((body) => {
    requestCount++;
    if (requestCount === 1) {
      assert.ok(body.tools?.length > 0, "tools should be sent");
      return sse(toolCallChunks("call_1", "write", JSON.stringify({ filePath: "hello.txt", content: "hi there" })));
    }
    const hasToolResult = body.messages.some((m) => m.role === "tool" && m.content.includes("hello.txt"));
    assert.ok(hasToolResult, "second request must include tool result");
    return sse(textChunks("done"));
  });

  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "test",
    model: "mock",
    maxSteps: 5,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
  };
  const session = newSession();
  const permissions = { ask: async () => true };

  await runAgent({ session, userText: "write hello.txt", config, permissions });
  server.close();

  assert.strictEqual(requestCount, 2, "expected 2 API requests");
  assert.ok(fs.existsSync(path.join(tmp, "hello.txt")), "hello.txt should exist");
  assert.strictEqual(fs.readFileSync(path.join(tmp, "hello.txt"), "utf8"), "hi there");
  assert.ok(session.messages.some((m) => m.role === "tool"));
  assert.strictEqual(session.usage.prompt, 10);
  process.chdir(origCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("edit: 0 matches errors", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const f = path.join(tmp, "a.txt");
  fs.writeFileSync(f, "hello world");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("edit", { filePath: f, oldString: "nope", newString: "x" }, ctx);
  assert.ok(res.startsWith("Error: oldString not found"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("edit: multiple matches without replaceAll errors", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const f = path.join(tmp, "a.txt");
  fs.writeFileSync(f, "aaa bbb aaa");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("edit", { filePath: f, oldString: "aaa", newString: "x" }, ctx);
  assert.ok(res.includes("appears 2 times"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("edit: replaceAll works", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const f = path.join(tmp, "a.txt");
  fs.writeFileSync(f, "aaa bbb aaa");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("edit", { filePath: f, oldString: "aaa", newString: "x", replaceAll: true }, ctx);
  assert.ok(res.includes("2 replacements"));
  assert.strictEqual(fs.readFileSync(f, "utf8"), "x bbb x");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("plan mode blocks write", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const ctx = { cwd: tmp, config: {}, planMode: true, todos: [] };
  const res = await executeTool("write", { filePath: "x.txt", content: "y" }, ctx);
  assert.ok(res.includes("disabled in plan mode"));
  assert.ok(!fs.existsSync(path.join(tmp, "x.txt")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("glob finds files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  fs.mkdirSync(path.join(tmp, "sub"));
  fs.writeFileSync(path.join(tmp, "a.js"), "1");
  fs.writeFileSync(path.join(tmp, "sub", "b.js"), "2");
  fs.writeFileSync(path.join(tmp, "c.txt"), "3");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("glob", { pattern: "**/*.js" }, ctx);
  assert.ok(res.includes("a.js") && res.includes("b.js") && !res.includes("c.txt"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("grep finds matches", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  fs.writeFileSync(path.join(tmp, "a.js"), "const foo = 1;\nconst bar = 2;");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("grep", { pattern: "foo" }, ctx);
  assert.ok(res.includes("a.js:1:"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- M1: security + Windows hardening ----

test("deny-list: ~/.kodigo and .env blocked", () => {
  assert.ok(isDeniedPath(path.join(os.homedir(), ".kodigo", "config.json")));
  assert.ok(isDeniedPath(path.join(os.homedir(), ".kodigo", "sessions", "x.json")));
  assert.ok(isDeniedPath(path.join("proj", ".env")));
  assert.ok(isDeniedPath(path.join("proj", ".env.local")));
  assert.ok(isDeniedPath(path.join("proj", "id_rsa.pem")));
  assert.ok(!isDeniedPath(path.join("proj", "src", "index.js")));
});

test("deny-list: read tool refuses sensitive path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  fs.writeFileSync(path.join(tmp, ".env"), "SECRET=1");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("read", { filePath: path.join(tmp, ".env") }, ctx);
  assert.ok(res.includes("denied"), "expected denial, got: " + res);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("deny-list: 'Did you mean' hides sensitive siblings", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  fs.writeFileSync(path.join(tmp, ".env.production"), "SECRET=1");
  fs.writeFileSync(path.join(tmp, "environment.js"), "x");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("read", { filePath: path.join(tmp, "env.js") }, ctx);
  assert.ok(res.includes("File not found"));
  assert.ok(!res.includes(".env.production"), "leaked sensitive filename: " + res);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("redaction: sk-* tokens stripped from tool output", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const f = path.join(tmp, "note.txt");
  fs.writeFileSync(f, "key is sk-testabcdef1234567890 ok");
  const ctx = { cwd: tmp, config: {}, planMode: false, todos: [] };
  const res = await executeTool("read", { filePath: f }, ctx);
  assert.ok(!res.includes("sk-testabcdef1234567890"), "key not redacted: " + res);
  assert.ok(res.includes("[redacted]"));
  assert.strictEqual(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz1234"), "ghp_ab…[redacted]");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("webfetch: SSRF block on localhost and metadata IP", async () => {
  const ctx = { cwd: process.cwd(), config: {}, planMode: false, todos: [] };
  for (const url of ["http://localhost:8080/", "http://127.0.0.1/", "http://169.254.169.254/latest", "ftp://example.com/x"]) {
    const res = await executeTool("webfetch", { url }, ctx);
    assert.ok(res.startsWith("Error:"), "expected block for " + url + ", got: " + res);
  }
});

test("shell detection returns a usable shell", () => {
  const shell = detectShell();
  assert.ok(shell.command && typeof shell.args === "function");
  assert.ok(["git-bash", "powershell", "sh"].includes(shell.name));
});

test("bash runs through detected shell and reports it", async () => {
  const ctx = { cwd: process.cwd(), config: { bashTimeoutMs: 10000 }, planMode: false, todos: [] };
  const res = await executeTool("bash", { command: "echo hello-m1" }, ctx);
  assert.ok(res.includes("hello-m1"), "no output: " + res);
  assert.ok(res.includes("[shell:"), "shell not reported: " + res);
});

test("SSE parser tolerates CRLF line endings", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"crlf-ok"}}]}\r\n\r\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
        "data: [DONE]\r\n\r\n"
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const { streamChat } = await import("../src/llm.js");
  let text = "";
  for await (const ev of streamChat({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "m",
    messages: [],
    tools: [],
  })) {
    if (ev.type === "text") text += ev.text;
  }
  server.close();
  assert.strictEqual(text, "crlf-ok");
});

// ---- M2: cost + budget ----

test("cost tracked from usage with pricing table", async () => {
  const server = await startMockServer(() => sse(textChunks("hi")));
  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "k3-256k",
    maxSteps: 2,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
    pricing: { "k3-256k": { prompt: 1.0, completion: 1.0 } },
  };
  const session = newSession();
  await runAgent({ session, userText: "hi", config, permissions: { ask: async () => true } });
  server.close();
  assert.ok(session.cost > 0, "cost not tracked");
  const expected = (10 + 5) / 1e6;
  assert.ok(Math.abs(session.cost - expected) < 1e-9, `cost ${session.cost} != ${expected}`);
});

test("budget hard stop prevents API call", async () => {
  let requests = 0;
  const server = await startMockServer(() => {
    requests++;
    return sse(textChunks("should not happen"));
  });
  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "k3-256k",
    maxSteps: 5,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
    budget: 0.0001,
    pricing: { "k3-256k": { prompt: 1.0, completion: 1.0 } },
  };
  const session = newSession();
  session.cost = 0.0002; // already over budget
  await runAgent({ session, userText: "hi", config, permissions: { ask: async () => true } });
  server.close();
  assert.strictEqual(requests, 0, "API was called despite budget");
});

// ---- M3: provider auto-discovery ----

test("discovery fetches and sorts models from /models", async () => {
  const server = http.createServer((req, res) => {
    assert.strictEqual(req.url, "/v1/models");
    assert.strictEqual(req.headers.authorization, "Bearer testkey");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }, { id: "mid" }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const { fetchModels } = await import("../src/discover.js");
  const models = await fetchModels({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "testkey" });
  server.close();
  assert.deepStrictEqual(models, ["alpha", "mid", "zeta"]);
});

test("discovery error hints on 401 and 404", async () => {
  const { fetchModels } = await import("../src/discover.js");
  for (const [status, hint] of [[401, "key rejected"], [404, "baseURL may be wrong"]]) {
    const server = http.createServer((req, res) => {
      res.writeHead(status);
      res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    await assert.rejects(
      () => fetchModels({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "k" }),
      new RegExp(hint)
    );
    server.close();
  }
});

test("discovery caches within TTL and refreshes on force", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "m" + calls }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseURL = `http://127.0.0.1:${port}/v1`;
  const { discoverModels } = await import("../src/discover.js");
  const config = { baseURL, apiKey: "k", modelsCache: null };
  const first = await discoverModels(config);
  const second = await discoverModels(config); // cache hit
  const third = await discoverModels(config, { force: true }); // refresh
  server.close();
  assert.deepStrictEqual(first, ["m1"]);
  assert.deepStrictEqual(second, ["m1"]);
  assert.deepStrictEqual(third, ["m2"]);
  assert.strictEqual(calls, 2, `expected 2 HTTP calls, got ${calls}`);
});

// ---- M4: event seam ----

test("agent emits structured events (tool_start/tool_end/usage/done)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const origCwd = process.cwd();
  process.chdir(tmp);
  let requestCount = 0;
  const server = await startMockServer(() => {
    requestCount++;
    if (requestCount === 1) {
      return sse(toolCallChunks("c1", "write", JSON.stringify({ filePath: "ev.txt", content: "e" })));
    }
    return sse(textChunks("finished"));
  });
  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 5,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
  };
  const session = newSession();
  const events = [];
  await runAgent({
    session,
    userText: "go",
    config,
    permissions: { ask: async () => true },
    emit: (ev) => events.push(ev),
  });
  server.close();
  process.chdir(origCwd);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("request_start"), "no request_start: " + types);
  assert.ok(types.includes("tool_start"), "no tool_start");
  assert.ok(types.includes("tool_end"), "no tool_end");
  assert.ok(types.includes("text"), "no text");
  assert.strictEqual(types[types.length - 1], "done");
  const toolStart = events.find((e) => e.type === "tool_start");
  assert.strictEqual(toolStart.name, "write");
  assert.strictEqual(toolStart.input.filePath, "ev.txt");
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd.result.includes("ev.txt"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("custom emit receives no stdout interleaving requirement (json-safe)", async () => {
  const { createJsonRenderer } = await import("../src/ui.js");
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    lines.push(s);
    return true;
  };
  try {
    const emit = createJsonRenderer();
    emit({ type: "request_start" });
    emit({ type: "text", text: "hello" });
    emit({ type: "done", reason: "complete" });
  } finally {
    process.stdout.write = origWrite;
  }
  assert.strictEqual(lines.length, 2, "request_start should be skipped in json mode");
  assert.deepStrictEqual(JSON.parse(lines[0]), { type: "text", text: "hello" });
  assert.deepStrictEqual(JSON.parse(lines[1]), { type: "done", reason: "complete" });
});

test("budget stop emits done with reason", async () => {
  const server = await startMockServer(() => sse(textChunks("x")));
  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 5,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
    budget: 0.01,
    pricing: { default: { prompt: 1, completion: 1 } },
  };
  const session = newSession();
  session.cost = 0.02;
  const events = [];
  await runAgent({
    session,
    userText: "go",
    config,
    permissions: { ask: async () => true },
    emit: (ev) => events.push(ev),
  });
  server.close();
  const done = events.find((e) => e.type === "done");
  assert.strictEqual(done?.reason, "budget");
});

// ---- M5: checkpoints + rewind ----

test("checkpoint + rewind restores exact state in a git repo", async () => {
  const { execFileSync } = await import("node:child_process");
  const { createCheckpoint, rewind, isGitRepo } = await import("../src/checkpoint.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const g = (args) => execFileSync("git", args, { cwd: tmp, stdio: "ignore" });
  g(["init", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(tmp, "a.txt"), "original");
  g(["add", "-A"]);
  g(["commit", "-m", "init"]);
  assert.ok(isGitRepo(tmp));

  fs.writeFileSync(path.join(tmp, "a.txt"), "checkpoint-state");
  fs.writeFileSync(path.join(tmp, "b.txt"), "new-at-checkpoint");
  const cp = createCheckpoint(tmp);
  assert.strictEqual(cp.kind, "git");

  // index must be untouched by checkpointing
  const statusAfterCp = execFileSync("git", ["status", "--porcelain"], { cwd: tmp, encoding: "utf8" });
  assert.ok(statusAfterCp.includes(" b.txt") || statusAfterCp.includes("?? b.txt"), "checkpoint polluted index: " + statusAfterCp);

  // make post-checkpoint changes
  fs.writeFileSync(path.join(tmp, "a.txt"), "post-checkpoint-damage");
  fs.writeFileSync(path.join(tmp, "c.txt"), "created-after");
  fs.unlinkSync(path.join(tmp, "b.txt"));

  rewind(tmp, cp);
  assert.strictEqual(fs.readFileSync(path.join(tmp, "a.txt"), "utf8"), "checkpoint-state");
  assert.strictEqual(fs.readFileSync(path.join(tmp, "b.txt"), "utf8"), "new-at-checkpoint");
  assert.ok(!fs.existsSync(path.join(tmp, "c.txt")), "post-checkpoint file should be gone");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("checkpoint falls back to shadow copy outside git", async () => {
  const { createCheckpoint, rewind } = await import("../src/checkpoint.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  fs.writeFileSync(path.join(tmp, "x.txt"), "v1");
  const cp = createCheckpoint(tmp);
  assert.strictEqual(cp.kind, "shadow");
  fs.writeFileSync(path.join(tmp, "x.txt"), "v2");
  rewind(tmp, cp);
  assert.strictEqual(fs.readFileSync(path.join(tmp, "x.txt"), "utf8"), "v1");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("review flow runs read-only and leaves files untouched", async () => {
  const { currentDiff } = await import("../src/checkpoint.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const origCwd = process.cwd();
  process.chdir(tmp);
  const server = await startMockServer(() => sse(textChunks("LGTM, no findings")));
  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 3,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
  };
  const session = newSession();
  const diff = currentDiff(tmp, null); // non-git dir → graceful message
  assert.ok(diff.includes("not a git repository"));
  const events = [];
  await runAgent({
    session,
    userText: "Review these changes, do NOT modify files.\n\n```diff\n" + diff + "\n```",
    config,
    permissions: { ask: async () => true },
    planMode: true,
    emit: (ev) => events.push(ev),
  });
  server.close();
  process.chdir(origCwd);
  assert.strictEqual(fs.readdirSync(tmp).length, 0, "review created files");
  const done = events.find((e) => e.type === "done");
  assert.strictEqual(done?.reason, "complete");
  fs.rmSync(tmp, { recursive: true, force: true });
});

let failures = 0;
for (const { name, fn } of results) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error("     " + e.message);
  }
}
if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nPASS");
