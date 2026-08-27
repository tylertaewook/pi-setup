import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Bedrock spend read from AWS Cost Explorer via the doi-dev profile. CE data lags
// (a few refreshes a day, ~24h for the current day) and every GetCostAndUsage call
// bills $0.01, so results are cached and the boot line is best-effort, not live.
const PROFILE = "doi-dev";
const REGION = "us-east-1";
const SERVICE = "Amazon Bedrock";

const MONTHLY_LIMIT = 5000;
const DAILY_TARGET = 185;

const CACHE_FILE = join(homedir(), ".pi", "agent", ".bedrock-cost-cache.json");
const BOOT_TTL_MS = 6 * 60 * 60 * 1000;
const CE_TIMEOUT_MS = 20_000;

type Day = { date: string; amount: number };
type Snapshot = { fetchedAt: number; days: Day[]; estimated: boolean };

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthBounds(now: Date): { start: string; end: string; daysInMonth: number; elapsedFraction: number } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); // CE end is exclusive
  const daysInMonth = Math.round((nextMonth.getTime() - start.getTime()) / 86_400_000);
  const elapsedFraction = Math.min(1, (now.getTime() - start.getTime()) / (nextMonth.getTime() - start.getTime()));
  return { start: ymd(start), end: ymd(end), daysInMonth, elapsedFraction };
}

async function fetchSnapshot(pi: ExtensionAPI, now: Date): Promise<Snapshot> {
  const { start, end } = monthBounds(now);
  const args = [
    "ce", "get-cost-and-usage",
    "--profile", PROFILE,
    "--region", REGION,
    "--time-period", `Start=${start},End=${end}`,
    "--granularity", "DAILY",
    "--metrics", "UnblendedCost",
    "--filter", JSON.stringify({ Dimensions: { Key: "SERVICE", Values: [SERVICE] } }),
    "--output", "json",
  ];
  const result = await pi.exec("aws", args, { timeout: CE_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `aws ce exited ${result.code}`);
  const parsed = JSON.parse(result.stdout) as {
    ResultsByTime: Array<{ TimePeriod: { Start: string }; Total: { UnblendedCost: { Amount: string } }; Estimated: boolean }>;
  };
  const days = parsed.ResultsByTime.map((r) => ({ date: r.TimePeriod.Start, amount: Number(r.Total.UnblendedCost.Amount) }));
  return { fetchedAt: Date.now(), days, estimated: parsed.ResultsByTime.some((r) => r.Estimated) };
}

function readCache(): Snapshot | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

async function getSnapshot(pi: ExtensionAPI, now: Date, force: boolean): Promise<Snapshot> {
  if (!force) {
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < BOOT_TTL_MS) return cached;
  }
  const fresh = await fetchSnapshot(pi, now);
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(fresh));
  } catch {
    // a read-only home just means no cache; the numbers are still correct
  }
  return fresh;
}

type Report = {
  today: number;
  todayDate: string;
  todayIsCurrent: boolean;
  mtd: number;
  monthPct: number;
  elapsedFraction: number;
  remaining: number;
  estimated: boolean;
  stale: boolean;
};

function analyze(snap: Snapshot, now: Date): Report {
  const { elapsedFraction } = monthBounds(now);
  const mtd = snap.days.reduce((sum, d) => sum + d.amount, 0);
  const last = snap.days.at(-1);
  const today = last?.amount ?? 0;
  const todayDate = last?.date ?? ymd(now);
  return {
    today,
    todayDate,
    todayIsCurrent: todayDate === ymd(now),
    mtd,
    monthPct: Math.round((elapsedFraction * 100 + Number.EPSILON) * 10) / 10,
    elapsedFraction,
    remaining: MONTHLY_LIMIT - mtd,
    estimated: snap.estimated,
    stale: Date.now() - snap.fetchedAt > BOOT_TTL_MS,
  };
}

function status(mtd: number, elapsedFraction: number): { word: string; icon: string } {
  if (mtd > MONTHLY_LIMIT) return { word: "over $5k limit", icon: "\u{1F534}" };
  const paceRatio = elapsedFraction > 0 ? mtd / MONTHLY_LIMIT / elapsedFraction : 0;
  if (paceRatio > 1.1) return { word: "ahead of pace", icon: "\u{1F7E1}" };
  return { word: "on track", icon: "\u{1F7E2}" };
}

function budgetBar(mtd: number, width = 16): string {
  const frac = Math.max(0, Math.min(1, mtd / MONTHLY_LIMIT));
  const filled = Math.round(frac * width);
  const pct = Math.round((mtd / MONTHLY_LIMIT) * 100);
  return `[${"\u2588".repeat(filled)}${"\u2591".repeat(width - filled)}] ${pct}% of ${money(MONTHLY_LIMIT)}`;
}

function dailyAlert(today: number): string | null {
  if (today >= 250) return "\u{1F6A8} abnormal daily spend \u2014 investigate now";
  if (today >= 225) return "\u26A0\uFE0F strong warning: expensive models only for genuinely hard work";
  if (today >= DAILY_TARGET) return "daily target reached \u2014 prefer cheaper models unless the work is important";
  if (today >= 140) return "~75% of today's $185 target used";
  if (today >= 100) return `today ${money(today)} vs $185 daily target`;
  return null;
}

type Entry = { type: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }; message?: { role: string; provider?: string; model?: string; responseModel?: string; usage?: Entry["usage"] } };
type Slice = { label: string; cost: number; tokens: number };

function sessionBreakdown(entries: Entry[]): Slice[] {
  const byKey = new Map<string, { cost: number; tokens: number }>();
  for (const e of entries) {
    let key: string | undefined;
    let usage: Entry["usage"];
    if (e.type === "message" && e.message?.role === "assistant") {
      key = shortModel(`${e.message.provider}/${e.message.responseModel ?? e.message.model}`);
      usage = e.message.usage;
    } else if (e.type === "message" && e.message?.role === "toolResult" && e.message.usage) {
      key = "tools/summaries";
      usage = e.message.usage;
    } else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
      key = "tools/summaries";
      usage = e.usage;
    }
    if (!key || !usage) continue;
    const cur = byKey.get(key) ?? { cost: 0, tokens: 0 };
    cur.cost += usage.cost.total;
    cur.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    byKey.set(key, cur);
  }
  return Array.from(byKey, ([label, v]) => ({ label, ...v }))
    .filter((s) => s.cost > 0 || s.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
}

function shortModel(key: string): string {
  const tail = key.split("/").at(-1) ?? key;
  return tail.replace(/^(us|eu|apac)\./, "").replace(/^anthropic\./, "").replace(/-v\d+:\d+$/, "").replace(/-\d{8}$/, "");
}

function bar(value: number, max: number, width = 22): string {
  if (max <= 0) return "";
  const filled = Math.round((value / max) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function chart(rows: Array<{ label: string; value: number; note: string }>): string {
  const max = Math.max(...rows.map((r) => r.value), 0);
  const labelW = Math.max(...rows.map((r) => r.label.length), 0);
  return rows
    .map((r) => `  ${r.label.padEnd(labelW)}  ${bar(r.value, max)}  ${r.note}`)
    .join("\n");
}

function dailyTrend(snap: Snapshot): string {
  const days = snap.days.slice(-14);
  if (!days.length) return "";
  const rows = days.map((d) => ({ label: d.date.slice(5), value: d.amount, note: money(d.amount) }));
  return `Daily Bedrock spend (last ${days.length}d)\n${chart(rows)}`;
}

function modelRatio(entries: Entry[]): string {
  const slices = sessionBreakdown(entries);
  if (!slices.length) return "";
  const total = slices.reduce((s, x) => s + x.cost, 0);
  const rows = slices.slice(0, 8).map((s) => ({
    label: s.label,
    value: s.cost,
    note: total > 0 ? `${money(s.cost)} (${Math.round((s.cost / total) * 100)}%)` : `${(s.tokens / 1000).toFixed(0)}k tok`,
  }));
  return `This session by model — ${money(total)} total\n${chart(rows)}`;
}

function bootLines(r: Report): string[] {
  const { word, icon } = status(r.mtd, r.elapsedFraction);
  const dayLabel = r.todayIsCurrent ? "today" : `on ${r.todayDate}`;
  return [
    `${icon} Bedrock ${money(r.today)} ${dayLabel} \u00B7 ${money(r.mtd)}/${money(MONTHLY_LIMIT)} MTD (${r.monthPct}% of month)`,
    `   ${budgetBar(r.mtd)} \u00B7 ${word}${r.stale ? " \u00B7 cached" : ""}`,
  ];
}

function fullReport(r: Report): string {
  const { word, icon } = status(r.mtd, r.elapsedFraction);
  const alert = dailyAlert(r.today);
  const lines = [
    `Bedrock spend (Cost Explorer, ${PROFILE}${r.estimated ? ", estimated" : ""})`,
    `  ${r.todayIsCurrent ? "Today" : `Latest (${r.todayDate})`}:  ${money(r.today)}  (daily target ${money(DAILY_TARGET)})`,
    `  Month-to-date:  ${money(r.mtd)}  \u2014 ${r.monthPct}% of month elapsed`,
    `  ${budgetBar(r.mtd)}  ${icon} ${word}`,
    `  Remaining this month (${money(MONTHLY_LIMIT)} limit):  ${money(r.remaining)}`,
  ];
  if (!r.todayIsCurrent) lines.push(`  Note: CE has not posted today yet; latest day is ${r.todayDate}.`);
  if (r.stale) lines.push("  Note: cached >6h; run /cost to force a refresh ($0.01 CE call).");
  if (alert) lines.push(`  ${alert}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    void (async () => {
      try {
        const now = new Date();
        const snap = await getSnapshot(pi, now, false);
        ctx.ui.setWidget("bedrock-cost", bootLines(analyze(snap, now)));
      } catch {
        // no creds / offline / CE error: skip the boot line silently
      }
    })();
  });

  pi.registerCommand("cost", {
    description: "Bedrock spend today / MTD / budget bar (AWS Cost Explorer)",
    handler: async (args, ctx) => {
      const force = /\b(refresh|force|now)\b/i.test(args ?? "");
      try {
        const now = new Date();
        const snap = await getSnapshot(pi, now, force);
        const report = analyze(snap, now);
        ctx.ui.setWidget("bedrock-cost", bootLines(report));
        const sections = [fullReport(report), dailyTrend(snap), modelRatio(ctx.sessionManager.getEntries() as unknown as Entry[])].filter(Boolean);
        ctx.ui.notify(sections.join("\n\n"), status(report.mtd, report.elapsedFraction).icon === "\u{1F7E2}" ? "info" : "warn");
      } catch (err) {
        ctx.ui.notify(`Cost lookup failed: ${(err as Error).message}`, "error");
      }
    },
  });
}
