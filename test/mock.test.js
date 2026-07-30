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

// ---- M6: memory + /init ----

test("memory: append + read round-trip", async () => {
  const { appendLearnings, readMemory } = await import("../src/memory.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const n = appendLearnings("- tests run via node test/mock.test.js\n- npm ps1 shim is blocked on this machine\nnot a bullet", tmp);
  assert.strictEqual(n, 2);
  const mem = readMemory(tmp);
  assert.ok(mem.includes("## Learnings"));
  assert.ok(mem.includes("tests run via"));
  appendLearnings("- windows taskkill kills process trees", tmp);
  const mem2 = readMemory(tmp);
  assert.ok(mem2.includes("taskkill"));
  assert.ok(mem2.includes("tests run via"), "earlier learnings lost");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("memory: extractLearnings splits MEMORY vs USER sections", async () => {
  const { extractLearnings, appendLearnings, readMemory, USER_FILE } = await import("../src/memory.js");
  const server = await startMockServer((body) => {
    if (!body.stream) {
      return JSON.stringify({
        choices: [
          {
            message: {
              content: "MEMORY:\n- use npm via cmd, not powershell\n- tests: node test/mock.test.js\nUSER:\n- user is on Windows with blocked ps1 shims\n- prefers Tagalog responses",
            },
          },
        ],
      });
    }
    return sse(textChunks("done"));
  });
  const port = server.address().port;
  const config = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "t", model: "mock" };
  const session = newSession();
  session.messages.push(
    { role: "user", content: "run tests" },
    { role: "assistant", content: "ok" },
    { role: "tool", tool_call_id: "1", content: "passed" }
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const out = await extractLearnings(session, config, tmp);
  assert.ok(out.memory.includes("npm via cmd"), "memory section missing: " + JSON.stringify(out));
  assert.ok(out.user.includes("Windows"), "user section missing");
  appendLearnings(out.memory, tmp);
  appendLearnings(out.user, tmp, USER_FILE);
  assert.ok(readMemory(tmp).includes("mock.test.js"));
  assert.ok(readMemory(tmp, USER_FILE).includes("Tagalog"));
  assert.ok(!readMemory(tmp).includes("Tagalog"), "user fact leaked into MEMORY.md");
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("memory: dedupe skips already-known bullets", async () => {
  const { appendLearnings, readMemory } = await import("../src/memory.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  appendLearnings("- tests run via node test/mock.test.js", tmp);
  const n = appendLearnings("- tests run via node test/mock.test.js\n- a genuinely new fact", tmp);
  assert.strictEqual(n, 1, "duplicate should be filtered, only new fact appended");
  const mem = readMemory(tmp);
  assert.strictEqual((mem.match(/genuinely new/g) || []).length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("/init flow: agent writes AGENTS.md via tools", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const origCwd = process.cwd();
  process.chdir(tmp);
  let requestCount = 0;
  const server = await startMockServer(() => {
    requestCount++;
    if (requestCount === 1) {
      return sse(toolCallChunks("c1", "write", JSON.stringify({ filePath: "AGENTS.md", content: "# Agents\nTest project.\n" })));
    }
    return sse(textChunks("AGENTS.md created"));
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
  await runAgent({
    session,
    userText: "Explore this repo and write AGENTS.md",
    config,
    permissions: { ask: async () => true },
    emit: () => {},
  });
  server.close();
  process.chdir(origCwd);
  assert.ok(fs.existsSync(path.join(tmp, "AGENTS.md")));
  assert.ok(fs.readFileSync(path.join(tmp, "AGENTS.md"), "utf8").includes("Test project"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- M7: slash commands ----

test("frontmatter parser extracts meta and body", async () => {
  const { parseFrontmatter } = await import("../src/commands.js");
  const { meta, body } = parseFrontmatter('---\nname: review\ndescription: "Review code"\n---\nReview $ARGUMENTS carefully\n');
  assert.strictEqual(meta.name, "review");
  assert.strictEqual(meta.description, "Review code");
  assert.ok(body.includes("$ARGUMENTS"));
  const plain = parseFrontmatter("no frontmatter here");
  assert.deepStrictEqual(plain.meta, {});
  assert.strictEqual(plain.body, "no frontmatter here");
});

test("loadCommands reads .kodigo/commands/*.md", async () => {
  const { loadCommands } = await import("../src/commands.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  fs.mkdirSync(path.join(tmp, ".kodigo", "commands"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".kodigo", "commands", "audit.md"), "---\ndescription: security audit\n---\nAudit the code for $ARGUMENTS\n");
  fs.writeFileSync(path.join(tmp, ".kodigo", "commands", "broken.txt"), "not md, ignored");
  const cmds = loadCommands(tmp);
  assert.strictEqual(cmds.size, 1);
  const audit = cmds.get("audit");
  assert.strictEqual(audit.description, "security audit");
  assert.ok(audit.body.includes("$ARGUMENTS"));
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- M8: hooks ----

test("pre-hook non-zero exit denies the tool", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const origCwd = process.cwd();
  process.chdir(tmp);
  const denyCmd = process.platform === "win32" ? "exit 1" : "exit 1";
  let hookRan = false;
  const server = await startMockServer((body) => {
    if (body.messages.some((m) => m.role === "tool")) {
      const toolMsg = body.messages.find((m) => m.role === "tool");
      hookRan = true;
      assert.ok(toolMsg.content.includes("Hook denied"), "hook denial not in transcript: " + toolMsg.content);
      return sse(textChunks("understood, hook blocked it"));
    }
    return sse(toolCallChunks("c1", "write", JSON.stringify({ filePath: "hooked.txt", content: "x" })));
  });
  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 4,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
    hooks: { pre: [{ tool: "write", command: denyCmd }] },
  };
  const session = newSession();
  await runAgent({
    session,
    userText: "write a file",
    config,
    permissions: { ask: async () => true },
    emit: () => {},
  });
  server.close();
  assert.ok(hookRan);
  assert.ok(!fs.existsSync(path.join(tmp, "hooked.txt")), "hook should have blocked the write");
  process.chdir(origCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("post-hook stdout is appended to tool result", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  const origCwd = process.cwd();
  process.chdir(tmp);
  let sawPostOutput = false;
  const server = await startMockServer((body) => {
    const toolMsg = body.messages.find((m) => m.role === "tool");
    if (toolMsg) {
      sawPostOutput = toolMsg.content.includes("post-hook-output-marker");
      return sse(textChunks("done"));
    }
    return sse(toolCallChunks("c1", "write", JSON.stringify({ filePath: "p.txt", content: "x" })));
  });
  const port = server.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 4,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
    hooks: { post: [{ tool: "write", command: "echo post-hook-output-marker" }] },
  };
  const session = newSession();
  await runAgent({
    session,
    userText: "write a file",
    config,
    permissions: { ask: async () => true },
    emit: () => {},
  });
  server.close();
  assert.ok(sawPostOutput, "post-hook output did not reach the model");
  process.chdir(origCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- F1: model fallback chain ----

test("fallback: 429 on primary switches to fallback model and completes", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const rawServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.model === "model-a") {
        primaryCalls++;
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limit" } }));
        return;
      }
      fallbackCalls++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse(textChunks("fallback answered")));
    });
  });
  await new Promise((r) => rawServer.listen(0, "127.0.0.1", r));
  const rawPort = rawServer.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${rawPort}/v1`,
    apiKey: "t",
    model: "model-a",
    fallbackModels: ["model-b"],
    maxSteps: 3,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
  };
  const session = newSession();
  const events = [];
  await runAgent({
    session,
    userText: "hi",
    config,
    permissions: { ask: async () => true },
    emit: (ev) => events.push(ev),
  });
  rawServer.close();
  assert.strictEqual(primaryCalls, 2, "primary tried initial + 1 retry");
  assert.strictEqual(fallbackCalls, 1, "fallback called once");
  assert.strictEqual(session.lastModel, "model-b");
  const fallbackEvent = events.find((e) => e.type === "info" && e.text.includes("falling back to model-b"));
  assert.ok(fallbackEvent, "no fallback event emitted");
  const done = events.find((e) => e.type === "done");
  assert.strictEqual(done?.reason, "complete");
});

test("fallback: exhausted chain surfaces the error", async () => {
  const rawServer = http.createServer((req, res) => {
    res.writeHead(429);
    res.end("{}");
  });
  await new Promise((r) => rawServer.listen(0, "127.0.0.1", r));
  const port = rawServer.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "t",
    model: "model-a",
    fallbackModels: ["model-b"],
    maxSteps: 3,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    yolo: true,
  };
  const session = newSession();
  await assert.rejects(
    () => runAgent({ session, userText: "hi", config, permissions: { ask: async () => true }, emit: () => {} }),
    /429/
  );
  rawServer.close();
});

// ---- F2: /undo + /retry ----

test("popLastTurn removes assistant turn + its user message", async () => {
  const { popLastTurn } = await import("../src/session.js");
  const session = newSession();
  session.messages.push(
    { role: "user", content: "first" },
    { role: "assistant", content: "answer one" },
    { role: "user", content: "second" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t1", content: "data" },
    { role: "assistant", content: "answer two" }
  );
  const removed = popLastTurn(session);
  assert.strictEqual(removed, "second");
  assert.strictEqual(session.messages.length, 2);
  assert.strictEqual(session.messages[1].content, "answer one");
  const removed2 = popLastTurn(session);
  assert.strictEqual(removed2, "first");
  assert.strictEqual(session.messages.length, 0);
  assert.strictEqual(popLastTurn(session), null);
});

// ---- F4: auto-skill creation ----

test("proposeSkill returns valid command markdown, rejects NONE and junk", async () => {
  const { proposeSkill } = await import("../src/skills.js");
  let mode = "skill";
  const server = await startMockServer((body) => {
    if (!body.stream) {
      const content =
        mode === "skill"
          ? '---\nname: fix-lint\ndescription: Fix lint errors and verify\n---\nFix all lint errors in $ARGUMENTS, run the linter, and iterate until clean.\n'
          : mode === "none"
            ? "NONE"
            : "---\nname: Bad Name!!\n---\njunk";
      return JSON.stringify({ choices: [{ message: { content } }] });
    }
    return sse(textChunks("done"));
  });
  const port = server.address().port;
  const config = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "t", model: "mock" };
  const session = newSession();
  session.messages.push(
    { role: "user", content: "fix lint" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: "3 errors" },
    { role: "assistant", content: "fixed" }
  );
  const skill = await proposeSkill(session, config, 0);
  assert.ok(skill, "expected a skill proposal");
  assert.strictEqual(skill.name, "fix-lint");
  assert.ok(skill.content.includes("$ARGUMENTS"));
  mode = "none";
  assert.strictEqual(await proposeSkill(session, config, 0), null);
  mode = "junk";
  assert.strictEqual(await proposeSkill(session, config, 0), null);
  server.close();
});

test("saveSkill writes a loadable command file", async () => {
  const { saveSkill } = await import("../src/skills.js");
  const { loadCommands } = await import("../src/commands.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kodigo-test-"));
  saveSkill("fix-lint", '---\nname: fix-lint\ndescription: Fix lint errors\n---\nFix lint in $ARGUMENTS\n', tmp);
  const cmds = loadCommands(tmp);
  const cmd = cmds.get("fix-lint");
  assert.ok(cmd, "saved skill not loadable");
  assert.strictEqual(cmd.description, "Fix lint errors");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("countToolCallsSince counts only the last turn", async () => {
  const { countToolCallsSince } = await import("../src/skills.js");
  const msgs = [
    { role: "user", content: "old" },
    { role: "assistant", content: null, tool_calls: [{}, {}] },
    { role: "user", content: "new turn" },
    { role: "assistant", content: null, tool_calls: [{}, {}, {}] },
  ];
  assert.strictEqual(countToolCallsSince(msgs, 2), 3);
  assert.strictEqual(countToolCallsSince(msgs, 0), 5);
});

// ---- F5: /recall ----

test("recall searches across session files and summarizes", async () => {
  const { searchSessions, recall } = await import("../src/recall.js");
  const { saveSession, newSession } = await import("../src/session.js");
  const s1 = newSession();
  s1.messages.push({ role: "user", content: "help me set up docker compose for postgres" });
  s1.messages.push({ role: "assistant", content: "here is the docker-compose.yml with postgres:16" });
  const s2 = newSession();
  s2.messages.push({ role: "user", content: "write a haiku about trees" });
  saveSession(s1);
  saveSession(s2);
  try {
    const hits = searchSessions("docker");
    assert.ok(hits.length >= 2, `expected 2 hits, got ${hits.length}`);
    assert.ok(hits.every((h) => /docker/i.test(h.snippet)));
    assert.ok(!searchSessions("trees").some((h) => h.sessionId === s1.id));

    const server = await startMockServer((body) => {
      if (!body.stream) {
        return JSON.stringify({ choices: [{ message: { content: "You set up docker compose with postgres:16 before." } }] });
      }
      return sse(textChunks("x"));
    });
    const port = server.address().port;
    const { summary } = await recall("docker", { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "t", model: "m" });
    server.close();
    assert.ok(summary.includes("postgres"));
  } finally {
    fs.unlinkSync(path.join(os.homedir(), ".kodigo", "sessions", s1.id + ".json"));
    fs.unlinkSync(path.join(os.homedir(), ".kodigo", "sessions", s2.id + ".json"));
  }
});

// ---- F6: Telegram gateway ----

test("gateway: pairing default-deny, approve, then per-chat agent reply", async () => {
  const sent = [];
  const tgCalls = { updates: 0 };
  // Fake Telegram client (in-memory)
  const fakeTg = {
    getMe: async () => ({ username: "kodigo_test_bot" }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => sent.push({ chatId, text }),
  };
  // Mock LLM
  const llm = await startMockServer(() => sse(textChunks("agent reply from telegram turn")));
  const llmPort = llm.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 3,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    telegram: { token: "fake" },
  };
  const { startGateway, approveCommand } = await import("../src/gateway/index.js");
  const { loadStore } = await import("../src/gateway/pairing.js");
  const store = { allowedUsers: [], pending: {} }; // injected, isolated from real store
  const logs = [];
  const gw = await startGateway(config, { telegram: fakeTg, store, onLog: (m) => logs.push(m), once: true });

  // 1. unknown user → pairing code, NOT processed
  await gw.handleMessage({ chat: { id: 100 }, from: { id: 555 }, text: "hello" });
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].text.includes("Pairing code:"), "no pairing code sent: " + sent[0].text);
  const code = sent[0].text.match(/Pairing code: ([A-F0-9]{6})/)[1];
  assert.ok(logs.some((l) => l.includes("555")));

  // 2. still denied before approval
  await gw.handleMessage({ chat: { id: 100 }, from: { id: 555 }, text: "let me in" });
  assert.strictEqual(sent.length, 2);
  assert.ok(sent[1].text.includes("Pairing code:"));

  // 3. approve via store, then message is processed by the agent
  const { approvePairing, saveStore } = await import("../src/gateway/pairing.js");
  const realStore = loadStore();
  realStore.pending[code] = { userId: 555, createdAt: Date.now() };
  const approved = approvePairing(realStore, code);
  assert.strictEqual(approved, 555);
  // clean up real store mutation
  realStore.allowedUsers = realStore.allowedUsers.filter((u) => u !== 555);
  saveStore(realStore);

  // gateway's injected store needs the approval too
  gw.store.allowedUsers.push(555);
  await gw.handleMessage({ chat: { id: 100 }, from: { id: 555 }, text: "what is up" });
  const reply = sent.find((s) => s.text.includes("agent reply from telegram turn"));
  assert.ok(reply, "agent reply not sent to telegram: " + JSON.stringify(sent));

  // 4. /new resets session
  await gw.handleMessage({ chat: { id: 100 }, from: { id: 555 }, text: "/new" });
  assert.ok(sent.some((s) => s.text === "(new session)"));
  llm.close();
});

// ---- F7: cron scheduler + heartbeat ----

test("parseSchedule: intervals and daily", async () => {
  const { parseSchedule, nextRun } = await import("../src/gateway/scheduler.js");
  assert.deepStrictEqual(parseSchedule("every 30m"), { type: "interval", intervalMs: 1800000 });
  assert.deepStrictEqual(parseSchedule("every 2 hours"), { type: "interval", intervalMs: 7200000 });
  assert.deepStrictEqual(parseSchedule("daily 09:30"), { type: "daily", hour: 9, minute: 30 });
  assert.strictEqual(parseSchedule("whenever lol"), null);
  const now = new Date("2026-07-31T10:00:00").getTime();
  const nr = nextRun({ type: "daily", hour: 9, minute: 0 }, now);
  assert.ok(nr > now, "daily 09:00 after 10:00 should be tomorrow");
  assert.strictEqual(new Date(nr).getHours(), 9);
});

test("scheduler tick runs due job and delivers to telegram", async () => {
  const { addJob, loadJobs, saveJobs } = await import("../src/gateway/scheduler.js");
  const { startGateway } = await import("../src/gateway/index.js");
  const sent = [];
  const fakeTg = {
    getMe: async () => ({ username: "bot" }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => sent.push({ chatId, text }),
  };
  const llm = await startMockServer(() => sse(textChunks("scheduled report: all good")));
  const llmPort = llm.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 3,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    telegram: { token: "fake" },
  };
  const store = { allowedUsers: [555], pending: {} };
  const gw = await startGateway(config, { telegram: fakeTg, store, onLog: () => {}, once: true });

  const jobsFile = path.join(os.homedir(), ".kodigo", "scheduler.json");
  const backup = fs.existsSync(jobsFile) ? fs.readFileSync(jobsFile, "utf8") : null;
  try {
    const jobs = [];
    const job = addJob(jobs, { chatId: 100, prompt: "give me the report", schedule: { type: "interval", intervalMs: 60000 } });
    job.nextRunAt = Date.now() - 1000; // make due
    saveJobs(jobs);

    const sched = gw.startScheduler({ tickOnce: true });
    await sched.tick();
    assert.ok(sent.some((s) => s.chatId === 100 && s.text.includes("scheduled report")), "job output not delivered: " + JSON.stringify(sent));
    const after = loadJobs();
    assert.ok(after[0].nextRunAt > Date.now(), "job not rescheduled");
    assert.ok(after[0].lastRunAt, "lastRunAt not set");
  } finally {
    if (backup) fs.writeFileSync(jobsFile, backup);
    else fs.rmSync(jobsFile, { force: true });
    llm.close();
  }
});

test("heartbeat suppresses quiet replies", async () => {
  const { addJob, saveJobs, loadJobs } = await import("../src/gateway/scheduler.js");
  const { startGateway } = await import("../src/gateway/index.js");
  const sent = [];
  const fakeTg = {
    getMe: async () => ({ username: "bot" }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => sent.push({ chatId, text }),
  };
  const llm = await startMockServer(() => sse(textChunks("Nothing new to report.")));
  const llmPort = llm.address().port;
  const config = {
    baseURL: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: "t",
    model: "mock",
    maxSteps: 3,
    autoCompactChars: 1e9,
    bashTimeoutMs: 5000,
    telegram: { token: "fake" },
  };
  const store = { allowedUsers: [555], pending: {} };
  const gw = await startGateway(config, { telegram: fakeTg, store, onLog: () => {}, once: true });
  const jobsFile = path.join(os.homedir(), ".kodigo", "scheduler.json");
  const backup = fs.existsSync(jobsFile) ? fs.readFileSync(jobsFile, "utf8") : null;
  try {
    const jobs = [];
    const job = addJob(jobs, { chatId: 100, prompt: "check in", schedule: { type: "interval", intervalMs: 60000 }, kind: "heartbeat" });
    job.nextRunAt = Date.now() - 1000;
    saveJobs(jobs);
    const sched = gw.startScheduler({ tickOnce: true });
    await sched.tick();
    assert.strictEqual(sent.length, 0, "quiet heartbeat should not message the user");
    assert.ok(loadJobs()[0].lastRunAt, "heartbeat still marked as ran");
  } finally {
    if (backup) fs.writeFileSync(jobsFile, backup);
    else fs.rmSync(jobsFile, { force: true });
    llm.close();
  }
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
