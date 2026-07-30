import { createTelegramClient } from "./telegram.js";
import { loadStore, saveStore, issuePairingCode, approvePairing, isAllowed } from "./pairing.js";
import { loadJobs, saveJobs, parseSchedule, addJob, dueJobs, markRan, removeJob, describeJob } from "./scheduler.js";
import { newSession, loadSession, saveSession } from "../session.js";
import { runAgent } from "../agent.js";
import { createPermissions } from "../permissions.js";
import { HOME_DIR } from "../config.js";
import fs from "node:fs";
import path from "node:path";

const CHAT_SESSIONS_PATH = path.join(HOME_DIR, "gateway-sessions.json");

function loadChatSessions() {
  try {
    return JSON.parse(fs.readFileSync(CHAT_SESSIONS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveChatSessions(map) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CHAT_SESSIONS_PATH, JSON.stringify(map, null, 2));
}

export function sessionForChat(chatId, { fresh = false } = {}) {
  const map = loadChatSessions();
  if (!fresh && map[chatId]) {
    const s = loadSession(map[chatId]);
    if (s) return s;
  }
  const s = newSession();
  map[chatId] = s.id;
  saveChatSessions(map);
  return s;
}

export async function startGateway(config, { telegram, store: injectedStore, onLog = console.log, once = false } = {}) {
  const token = config.telegram?.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("No Telegram token. Set telegram.token in config or TELEGRAM_BOT_TOKEN env.");
  const tg = telegram || createTelegramClient(token);
  const store = injectedStore || loadStore();
  const permissions = createPermissions({ yolo: true }); // paired users only reach here
  const running = new Map(); // chatId → AbortController

  const me = await tg.getMe();
  onLog(`gateway online as @${me.username} (${store.allowedUsers.length} paired user${store.allowedUsers.length === 1 ? "" : "s"})`);

  let offset = 0;
  const seen = new Set();

  async function handleMessage(msg) {
    const chatId = msg.chat?.id;
    const userId = msg.from?.id;
    const text = (msg.text || "").trim();
    if (!chatId || !userId || !text) return;

    if (!isAllowed(store, userId)) {
      const code = issuePairingCode(store, userId);
      onLog(`pairing requested by user ${userId} — approve with: kodigo gateway approve ${code}`);
      await tg.sendMessage(chatId, `This agent is private. Pairing code: ${code}\nAsk the owner to approve it.`);
      return;
    }

    if (text === "/new") {
      sessionForChat(chatId, { fresh: true });
      await tg.sendMessage(chatId, "(new session)");
      return;
    }
    if (text === "/stop") {
      const ac = running.get(chatId);
      if (ac) {
        ac.abort();
        running.delete(chatId);
        await tg.sendMessage(chatId, "(stopped)");
      } else {
        await tg.sendMessage(chatId, "(nothing running)");
      }
      return;
    }

    if (text === "/cron" || text.startsWith("/cron ")) {
      const rest = text.slice(5).trim();
      const jobs = loadJobs().filter((j) => j.chatId === chatId);
      if (!rest || rest === "list") {
        await tg.sendMessage(chatId, jobs.length ? jobs.map(describeJob).join("\n") : "(no jobs — /cron every 30m <prompt> or /cron daily 09:00 <prompt>)");
        return;
      }
      if (rest.startsWith("rm ") || rest.startsWith("remove ")) {
        const id = rest.split(/\s+/)[1];
        const all = loadJobs();
        await tg.sendMessage(chatId, removeJob(all, id) ? `(removed ${id})` : `(no job ${id})`);
        return;
      }
      const m = /^(every\s+\d+\s*\w+|daily\s+\d{1,2}:\d{2})\s+([\s\S]+)$/i.exec(rest);
      const schedule = m && parseSchedule(m[1]);
      if (!schedule) {
        await tg.sendMessage(chatId, "Usage: /cron every 30m <prompt> | /cron daily 09:00 <prompt> | /cron list | /cron rm <id>");
        return;
      }
      const all = loadJobs();
      const job = addJob(all, { chatId, prompt: m[2], schedule });
      await tg.sendMessage(chatId, `(scheduled ${describeJob(job)} — next run ${new Date(job.nextRunAt).toLocaleString()})`);
      return;
    }

    if (running.has(chatId)) {
      await tg.sendMessage(chatId, "(still working — /stop to interrupt, or wait)");
      return;
    }

    const reply = await runForChat(chatId, text);
    await tg.sendMessage(chatId, reply);
  }

  async function pollLoop() {
    do {
      let updates = [];
      try {
        updates = await tg.getUpdates(offset);
      } catch (e) {
        onLog(`poll error: ${e.message} — retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        if (seen.has(u.update_id)) continue;
        seen.add(u.update_id);
        await handleMessage(u.message || {});
      }
    } while (!once);
  }

  async function runForChat(chatId, text) {
    const session = sessionForChat(chatId);
    const ac = new AbortController();
    running.set(chatId, ac);
    let reply = "";
    try {
      await runAgent({
        session,
        userText: text,
        config,
        permissions,
        planMode: false,
        signal: ac.signal,
        emit: (ev) => {
          if (ev.type === "text") reply += ev.text;
          if (ev.type === "tool_start") {
            const summary = ev.input?.command ?? ev.input?.filePath ?? ev.input?.pattern ?? "";
            reply += `\n⏺ ${ev.name}(${String(summary).slice(0, 60)})\n`;
          }
        },
      });
    } catch (e) {
      reply += `\n✗ ${e.message}`;
    } finally {
      running.delete(chatId);
    }
    return reply.trim() || "(no response)";
  }

  function startScheduler({ intervalMs = 30000, tickOnce = false } = {}) {
    let stopped = false;
    async function tick(now = Date.now()) {
      const jobs = loadJobs();
      for (const job of dueJobs(jobs, now)) {
        if (!isAllowed(store, job.allowedUserId ?? store.allowedUsers[0])) continue;
        onLog(`running job ${job.id} for chat ${job.chatId}`);
        try {
          const out = await runForChat(job.chatId, job.prompt);
          if (job.kind === "heartbeat" && /^(nothing|no update|all quiet)/i.test(out)) {
            onLog(`heartbeat ${job.id}: quiet`);
          } else {
            await tg.sendMessage(job.chatId, `⏰ ${job.kind === "heartbeat" ? "heartbeat" : "cron"} ${job.id}:\n${out}`);
          }
        } catch (e) {
          onLog(`job ${job.id} failed: ${e.message}`);
        }
        markRan(jobs, job);
      }
    }
    if (tickOnce) return { tick, stop: () => {} };
    const timer = setInterval(() => {
      if (!stopped) tick().catch((e) => onLog(`scheduler error: ${e.message}`));
    }, intervalMs);
    timer.unref?.();
    return { tick, stop: () => { stopped = true; clearInterval(timer); } };
  }

  return { pollLoop, handleMessage, startScheduler, runForChat, store, tg };
}

export function approveCommand(code) {
  const store = loadStore();
  const userId = approvePairing(store, code.toUpperCase());
  saveStore(store);
  return userId;
}
