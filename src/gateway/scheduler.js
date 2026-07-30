import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME_DIR } from "../config.js";

const JOBS_PATH = path.join(HOME_DIR, "scheduler.json");

export function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_PATH, "utf8"));
  } catch {
    return [];
  }
}

export function saveJobs(jobs) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(JOBS_PATH, JSON.stringify(jobs, null, 2));
}

export function parseSchedule(spec) {
  const every = /^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hours?|d|days?)$/i.exec(spec.trim());
  if (every) {
    const n = parseInt(every[1], 10);
    const unit = every[2].toLowerCase()[0];
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return { type: "interval", intervalMs: ms };
  }
  const daily = /^daily\s+(\d{1,2}):(\d{2})$/i.exec(spec.trim());
  if (daily) {
    return { type: "daily", hour: parseInt(daily[1], 10), minute: parseInt(daily[2], 10) };
  }
  return null;
}

export function nextRun(schedule, from = Date.now()) {
  if (schedule.type === "interval") return from + schedule.intervalMs;
  const d = new Date(from);
  d.setHours(schedule.hour, schedule.minute, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function addJob(jobs, { chatId, prompt, schedule, kind = "cron" }) {
  const job = {
    id: crypto.randomBytes(3).toString("hex"),
    chatId,
    prompt,
    schedule,
    kind,
    nextRunAt: nextRun(schedule),
    createdAt: Date.now(),
  };
  jobs.push(job);
  saveJobs(jobs);
  return job;
}

export function dueJobs(jobs, now = Date.now()) {
  return jobs.filter((j) => j.nextRunAt <= now);
}

export function markRan(jobs, job, ranAt = Date.now()) {
  job.lastRunAt = ranAt;
  job.nextRunAt = nextRun(job.schedule, ranAt);
  saveJobs(jobs);
}

export function removeJob(jobs, id) {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  saveJobs(jobs);
  return true;
}

export function describeJob(j) {
  const when = j.schedule.type === "interval" ? `every ${j.schedule.intervalMs / 60000}min` : `daily ${String(j.schedule.hour).padStart(2, "0")}:${String(j.schedule.minute).padStart(2, "0")}`;
  return `${j.id}  [${j.kind}] ${when} — "${j.prompt.slice(0, 50)}"`;
}
