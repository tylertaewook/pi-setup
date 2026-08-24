import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PBB_SESSIONS = join(homedir(), ".pi", "pbb", "sessions");
const POLL_MS = 1000;
const STATUS_KEY = "bg";
const WIDGET_KEY = "pbb-jobs";
const MAX_COMMAND = 48;

type Job = { jobId?: string; status?: string; pid?: number; startedAt?: string; command?: string };

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// reload/quit kills the process group without writing job.completed, so a job file
// can claim running forever - trust the pid, not the status field
function isAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runningJobs(sessionId: string): Job[] {
  const jobs: Job[] = [];
  for (const sessionKey of dirs(PBB_SESSIONS)) {
    const instances = join(PBB_SESSIONS, sessionKey, "instances");
    for (const instance of dirs(instances)) {
      const dir = join(instances, instance);
      if (readJson<{ sessionId?: string }>(join(dir, "identity.json"))?.sessionId !== sessionId) continue;
      const jobsDir = join(dir, "jobs");
      let names: string[] = [];
      try {
        names = readdirSync(jobsDir).filter((name) => name.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of names) {
        const job = readJson<Job>(join(jobsDir, name));
        if (job?.status === "running" && isAlive(job.pid)) jobs.push(job);
      }
    }
  }
  return jobs;
}

function since(startedAt: string | undefined): string {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(start)) return "";
  const seconds = Math.floor((Date.now() - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function jobLine(job: Job): string {
  const command = (job.command ?? "").replace(/\s+/g, " ").trim();
  const short = command.length > MAX_COMMAND ? `${command.slice(0, MAX_COMMAND - 1)}…` : command;
  return ` ⚙ ${job.jobId ?? "?"} · ${since(job.startedAt)} · ${short}`;
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let shown = "";

  const tick = (ctx: ExtensionContext) => {
    const jobs = runningJobs(ctx.sessionManager.getSessionId());
    const lines = jobs.map(jobLine);
    const signature = lines.join("\n");
    if (signature === shown) return;
    shown = signature;
    ctx.ui.setStatus(STATUS_KEY, jobs.length === 0 ? undefined : `⚙ ${jobs.length} bg`);
    ctx.ui.setWidget(WIDGET_KEY, lines.length === 0 ? undefined : lines, { placement: "belowEditor" });
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || timer) return;
    timer = setInterval(() => tick(ctx), POLL_MS);
    timer.unref?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = null;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
