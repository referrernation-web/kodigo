import { streamChat, complete } from "./llm.js";
import { TOOL_SCHEMAS, executeTool, detectShell } from "./tools.js";
import { loadProjectContext } from "./config.js";
import { saveSession } from "./session.js";
import { spinner, printTool, paint } from "./ui.js";

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

export async function compactSession(session, config) {
  const msgs = session.messages;
  if (msgs.length <= 4) return;
  const keep = 4;
  let cut = msgs.length - keep;
  while (cut > 0 && msgs[cut].role === "tool") cut--;
  if (cut <= 0) return;
  const earlier = msgs.slice(0, cut);
  const transcript = earlier
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 1000) : "[tool call]"}`)
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
    process.stdout.write(paint("gray", `\n(context compacted: ${earlier.length} messages summarized)\n`));
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

export async function runAgent({ session, userText, config, permissions, planMode = false, signal }) {
  const todos = [];
  const shell = detectShell();
  session.messages.push({ role: "user", content: userText });
  const sysMsg = { role: "system", content: systemPrompt(config, planMode, shell.name) };

  try {
    for (let step = 0; step < (config.maxSteps || 100); step++) {
      if (signal?.aborted) break;
      if (config.budget && session.cost >= config.budget) {
        process.stdout.write(
          paint("yellow", `\n(budget reached: $${session.cost.toFixed(4)} of $${config.budget} — stopping. Raise with --budget <usd>)\n`)
        );
        saveSession(session);
        return;
      }
      if (JSON.stringify(session.messages).length > (config.autoCompactChars || 120000)) {
        await compactSession(session, config);
      }

      const spin = spinner();
      let acc = "";
      let reasoningAcc = "";
      let calls = [];
      let usage = null;
      let errored = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          acc = "";
          calls = [];
          usage = null;
          for await (const ev of streamChat({
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            model: config.model,
            messages: [sysMsg, ...session.messages],
            tools: TOOL_SCHEMAS,
            signal,
          })) {
            spin.stop();
            if (ev.type === "text") {
              acc += ev.text;
              process.stdout.write(ev.text);
            } else if (ev.type === "reasoning") {
              reasoningAcc += ev.text;
              process.stdout.write(paint("gray", ev.text));
            } else if (ev.type === "tool_calls") {
              calls = ev.calls;
            } else if (ev.type === "usage") {
              usage = ev.usage;
            }
          }
          errored = null;
          break;
        } catch (e) {
          spin.stop();
          if (e.name === "AbortError" || signal?.aborted) {
            if (acc) {
              session.messages.push({ role: "assistant", content: acc });
            }
            process.stdout.write(paint("gray", "\n(interrupted)\n"));
            saveSession(session);
            return;
          }
          errored = e;
          const retryable = /API (429|5\d\d)/.test(e.message);
          if (attempt === 0 && retryable) {
            process.stdout.write(paint("gray", `\n(retrying: ${e.message.split(":")[0]})\n`));
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw e;
        }
      }
      spin.stop();
      if (errored) throw errored;

      if (usage) {
        session.usage.prompt += usage.prompt_tokens || 0;
        session.usage.completion += usage.completion_tokens || 0;
        const turn = turnCost(config, config.model, usage);
        if (turn > 0) {
          session.cost += turn;
          process.stdout.write(paint("gray", `\n[$${session.cost.toFixed(4)} total]`));
        }
      }

      if (!calls.length) {
        session.messages.push({ role: "assistant", content: acc });
        process.stdout.write("\n");
        saveSession(session);
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
      if (acc) process.stdout.write("\n");

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
        printTool(tc.function.name, input);
        let result;
        if (parseError) {
          result = parseError;
        } else {
          const allowed = await permissions.ask(tc.function.name, input);
          result = allowed
            ? await executeTool(tc.function.name, input, { cwd: process.cwd(), config, planMode, todos, shell })
            : "Error: user denied permission";
        }
        const preview = result.length > 400 ? result.slice(0, 400) + "…" : result;
        process.stdout.write(paint("gray", "  ⎿ " + preview.replace(/\n/g, "\n    ") + "\n"));
        session.messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      saveSession(session);
    }
    process.stdout.write(paint("yellow", `\n(reached max steps: ${config.maxSteps || 100})\n`));
  } catch (e) {
    if (e.name === "AbortError" || signal?.aborted) {
      process.stdout.write(paint("gray", "\n(interrupted)\n"));
      saveSession(session);
      return;
    }
    saveSession(session);
    throw e;
  }
  saveSession(session);
}
