import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { runAgent } from "../src/agent.js";
import { executeTool } from "../src/tools.js";
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
