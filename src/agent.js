import { streamChat, complete } from "./llm.js";
import { TOOL_SCHEMAS, executeTool, detectShell } from "./tools.js";
import { loadProjectContext } from "./config.js";
import { saveSession } from "./session.js";
import { createTerminalRenderer, paint } from "./ui.js";

export function systemPrompt(config, planMode, shellName) {
  const parts = [
    `You are Kodigo, a coding agent running in the user's terminal. You help with software engineering tasks: writing code, fixing bugs, refactoring, running commands, and explaining code.`,
    ``,
    `Rules:`,
    `- Prefer edit over write for existing files. You must read a file before editing it.`,
    `- Use todowrite for tasks with 3+ steps; keep it updated as you progress.`,
    `- Verify your work: run tests, builds, or commands when relevant.`,
    `- Be concise and direct. No unnecessary preamble.`,
    `- Never expose or log secrets.`,
  ];
  if (planMode) {
    parts.push(
      ``,
      `PLAN MODE is active: you are read-only. bash, write, and edit are disabled. Explore the codebase with read/glob/grep and produce a concrete plan instead of making changes.`
    );
  }
  parts.push(
    ``,
    `Environment:`,
    `- cwd: ${process.cwd()}`,
    `- platform: ${process.platform}`,
    `- shell: ${shellName} (the bash tool runs commands with this shell)`,
    `- date: ${new Date().toDateString()}`
  );
  for (const ctx of loadProjectContext()) {
    parts.push(``, `## Project instructions (${ctx.path})`, ``, ctx.content);
  }
  return parts.join("\n");
}

export async function compactSession(session, config, emit = () => {}) {
  const msgs = session.messages;
  if (msgs.length <= 4) return;
  const keep = 4;
  let cut = msgs.length - keep;
  while (cut > 0 && msgs[cut].role === "tool") cut--;
  if (cut <= 0) return;
  const earlier = msgs.slice(0, cut);
  const transcript = earlier
    .map((m) => {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        const calls = m.tool_calls.map((t) => t.function?.name).filter(Boolean).join(", ");
        return `assistant: ${typeof m.content === "string" ? m.content.slice(0, 500) : ""} [called tools: ${calls}]`;
      }
      return `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 1000) : "[tool call]"}`;
    })
    .join("\n");
  try {
    const summary = await complete({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        {
          role: "user",
          content:
            "Summarize this coding session concisely for continuation: files touched, decisions made, current state, next steps.\n\n" +
            transcript.slice(0, 30000),
        },
      ],
    });
    session.messages = [
      { role: "user", content: "[Earlier conversation summary]\n" + summary },
      ...msgs.slice(cut),
    ];
    emit({ type: "info", text: `(context compacted: ${earlier.length} messages summarized)` });
  } catch {
    // compaction is best-effort
  }
}

export function pricingFor(config, model) {
  const table = config.pricing || {};
  return table[model] || table["default"] || null;
}

export function turnCost(config, model, usage) {
  const p = pricingFor(config, model);
  if (!p || !usage) return 0;
  return ((usage.prompt_tokens || 0) * (p.prompt || 0) + (usage.completion_tokens || 0) * (p.completion || 0)) / 1e6;
}

export async function runAgent({ session, userText, config, permissions, planMode = false, signal, emit }) {
  if (!emit) emit = createTerminalRenderer();
  const todos = [];
  const shell = detectShell();
  session.messages.push({ role: "user", content: userText });
  const sysMsg = { role: "system", content: systemPrompt(config, planMode, shell.name) };

  try {
    for (let step = 0; step < (config.maxSteps || 100); step++) {
      if (signal?.aborted) break;
      if (config.budget && session.cost >= config.budget) {
        emit({
          type: "info",
          text: `(budget reached: $${session.cost.toFixed(4)} of $${config.budget} — stopping. Raise with --budget <usd>)`,
        });
        saveSession(session);
        emit({ type: "done", reason: "budget" });
        return;
      }
      if (JSON.stringify(session.messages).length > (config.autoCompactChars || 120000)) {
        await compactSession(session, config, emit);
      }

      let acc = "";
      let calls = [];
      let usage = null;
      let errored = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          acc = "";
          calls = [];
          usage = null;
          emit({ type: "request_start" });
          for await (const ev of streamChat({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            model: config.model,
            messages: [sysMsg, ...session.messages],
            tools: TOOL_SCHEMAS,
            signal,
          })) {
            if (ev.type === "text") {
              acc += ev.text;
              emit({ type: "text", text: ev.text });
            } else if (ev.type === "reasoning") {
              emit({ type: "reasoning", text: ev.text });
            } else if (ev.type === "tool_calls") {
              calls = ev.calls;
            } else if (ev.type === "usage") {
              usage = ev.usage;
            }
          }
          errored = null;
          break;
        } catch (e) {
          if (e.name === "AbortError" || signal?.aborted) {
            if (acc) {
              session.messages.push({ role: "assistant", content: acc });
            }
            emit({ type: "info", text: "(interrupted)" });
            saveSession(session);
            emit({ type: "done", reason: "interrupted" });
            return;
          }
          errored = e;
          const retryable = /API (429|5\d\d)/.test(e.message);
          if (attempt === 0 && retryable) {
            emit({ type: "info", text: `(retrying: ${e.message.split(":")[0]})` });
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          emit({ type: "error", message: e.message });
          throw e;
        }
      }
      if (errored) throw errored;

      if (usage) {
        session.usage.prompt += usage.prompt_tokens || 0;
        session.usage.completion += usage.completion_tokens || 0;
        const turn = turnCost(config, config.model, usage);
        if (turn > 0) session.cost += turn;
        emit({ type: "usage", usage, cost: turn, totalCost: session.cost });
      }

      if (!calls.length) {
        session.messages.push({ role: "assistant", content: acc });
        emit({ type: "message_end" });
        saveSession(session);
        emit({ type: "done", reason: "complete" });
        return;
      }

      const toolCalls = calls.map((c, i) => ({
        id: c.id || `call_${step}_${i}`,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
      session.messages.push({
        role: "assistant",
        content: acc || null,
        tool_calls: toolCalls,
      });
      if (acc) emit({ type: "message_end" });

      for (const tc of toolCalls) {
        if (signal?.aborted) {
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: "(interrupted)" });
          continue;
        }
        let input = {};
        let parseError = null;
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          parseError = "Error: invalid JSON arguments";
        }
        emit({ type: "tool_start", name: tc.function.name, input });
        let result;
        if (parseError) {
          result = parseError;
        } else {
          const allowed = await permissions.ask(tc.function.name, input);
          result = allowed
            ? await executeTool(tc.function.name, input, { cwd: process.cwd(), config, planMode, todos, shell })
            : "Error: user denied permission";
        }
        emit({ type: "tool_end", name: tc.function.name, result });
        session.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      saveSession(session);
    }
    emit({ type: "info", text: `(reached max steps: ${config.maxSteps || 100})` });
    emit({ type: "done", reason: "max_steps" });
  } catch (e) {
    if (e.name === "AbortError" || signal?.aborted) {
      emit({ type: "info", text: "(interrupted)" });
      saveSession(session);
      emit({ type: "done", reason: "interrupted" });
      return;
    }
    saveSession(session);
    throw e;
  }
  saveSession(session);
}
