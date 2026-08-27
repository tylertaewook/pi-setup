import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Spend is summed from pi's own per-turn cost in the session logs (token counts x
// model price). Since Bedrock is only used through pi here, this equals the bill,
// and it is local, real-time, and free — no Cost Explorer, no AWS creds.
const MONTHLY_LIMIT = 5000;
const DAILY_TARGET = 185;
const KEY_TTL_DAYS = 30;

// The Bedrock key rotates ~monthly; spend before the current key was billed to the
// old one, so it doesn't count. `/cost rotate` stamps today into this state file on
// each new key — no code edit. Once a new calendar month starts, month-start wins.
const STATE_FILE = join(homedir(), ".pi", "agent", ".bedrock-cost.json");
const SEED_ANCHOR = "2026-08-27";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const CACHE_TTL_MS = 30_000;

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readAnchor(): string {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { anchor?: string };
    if (raw.anchor && /^\d{4}-\d{2}-\d{2}$/.test(raw.anchor)) return raw.anchor;
  } catch {
    // missing or malformed: fall back to the seed
  }
  return SEED_ANCHOR;
}

function writeAnchor(date: string): void {
  writeFileSync(STATE_FILE, JSON.stringify({ anchor: date }, null, 2) + "\n");
  memo = null;
}

function shortModel(key: string): string {
  const tail = key.split("/").at(-1) ?? key;
  return tail.replace(/^(us|eu|apac|global)\./, "").replace(/^(anthropic|openai|xai)\./, "").replace(/-v\d+:\d+$/, "").replace(/-\d{8}$/, "");
}

type Slice = { label: string; cost: number };
type Stats = {
  today: number;
  mtd: number;
  monthPct: number;
  elapsedFraction: number;
  remaining: number;
  anchor: string;
  keyDaysLeft: number;
  keyExpiry: string;
  days: Array<{ date: string; amount: number }>;
  byModel: Slice[];
};

type Entry = {
  type?: string;
  id?: string;
  timestamp?: number | string;
  message?: { usage?: { cost?: { total?: number } }; provider?: string; model?: string; responseModel?: string };
};

function scan(now: Date): Stats {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const anchorStr = readAnchor();
  const anchor = new Date(`${anchorStr}T00:00:00`);
  const start = anchor > monthStart ? anchor : monthStart;
  const todayStr = localDate(now);

  const byDay = new Map<string, number>();
  const byModel = new Map<string, number>();
  const seen = new Set<string>();

  let files: string[] = [];
  try {
    files = readdirSync(SESSIONS_DIR, { recursive: true })
      .map((f) => String(f))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(SESSIONS_DIR, f));
  } catch {
    files = [];
  }

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let e: Entry;
      try {
        e = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      if (e.type !== "message" || !e.message?.usage) continue;
      // fork/clone copies entries verbatim into a new file; dedupe so they count once
      if (e.id) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
      }
      const cost = e.message.usage.cost?.total ?? 0;
      const ts = typeof e.timestamp === "number" ? e.timestamp : Date.parse(String(e.timestamp));
      if (!Number.isFinite(ts)) continue;
      const dt = new Date(ts);
      if (dt < start) continue;
      const d = localDate(dt);
      byDay.set(d, (byDay.get(d) ?? 0) + cost);
      const key = shortModel(`${e.message.provider}/${e.message.responseModel ?? e.message.model}`);
      byModel.set(key, (byModel.get(key) ?? 0) + cost);
    }
  }

  const mtd = Array.from(byDay.values()).reduce((s, v) => s + v, 0);
  const elapsedFraction = Math.min(1, (now.getTime() - monthStart.getTime()) / (nextMonth.getTime() - monthStart.getTime()));
  const expiryMs = anchor.getTime() + KEY_TTL_DAYS * 86_400_000;
  return {
    today: byDay.get(todayStr) ?? 0,
    mtd,
    monthPct: Math.round(elapsedFraction * 1000) / 10,
    elapsedFraction,
    remaining: MONTHLY_LIMIT - mtd,
    anchor: anchorStr,
    keyDaysLeft: Math.ceil((expiryMs - now.getTime()) / 86_400_000),
    keyExpiry: localDate(new Date(expiryMs)),
    days: Array.from(byDay, ([date, amount]) => ({ date, amount })).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: Array.from(byModel, ([label, cost]) => ({ label, cost })).filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost),
  };
}

let memo: { at: number; stats: Stats } | null = null;
function getStats(force: boolean): Stats {
  if (!force && memo && Date.now() - memo.at < CACHE_TTL_MS) return memo.stats;
  const stats = scan(new Date());
  memo = { at: Date.now(), stats };
  return stats;
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
  if (today >= 250) return "\u{1F534} abnormal daily spend \u2014 investigate now";
  if (today >= 225) return "\u{1F7E1} strong warning: expensive models only for genuinely hard work";
  if (today >= DAILY_TARGET) return "daily target reached \u2014 prefer cheaper models unless the work is important";
  if (today >= 140) return "~75% of today's $185 target used";
  if (today >= 100) return `today ${money(today)} vs $185 daily target`;
  return null;
}

function bar(value: number, max: number, width = 22): string {
  if (max <= 0) return "";
  const filled = Math.round((value / max) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

function chart(rows: Array<{ label: string; value: number; note: string }>): string {
  const max = Math.max(...rows.map((r) => r.value), 0);
  const labelW = Math.max(...rows.map((r) => r.label.length), 0);
  return rows.map((r) => `  ${r.label.padEnd(labelW)}  ${bar(r.value, max)}  ${r.note}`).join("\n");
}

function keyLine(s: Stats): string {
  const warn = s.keyDaysLeft <= 5 ? " \u{1F7E1} rotate soon" : "";
  return `key issued ${s.anchor} \u00B7 ${s.keyDaysLeft}d left (expires ${s.keyExpiry})${warn}`;
}

function bootLines(s: Stats): string[] {
  const { word, icon } = status(s.mtd, s.elapsedFraction);
  const width = 14;
  const filled = Math.round(Math.max(0, Math.min(1, s.mtd / MONTHLY_LIMIT)) * width);
  const barStr = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  const pct = Math.round((s.mtd / MONTHLY_LIMIT) * 100);
  return [
    `${icon} ${money(s.today)} today \u00B7 ${money(s.mtd)}/$5k MTD ${barStr} ${pct}% \u00B7 ${word} \u00B7 ${s.keyDaysLeft}d key`,
  ];
}

function fullReport(s: Stats): string {
  const { word, icon } = status(s.mtd, s.elapsedFraction);
  const lines = [
    "pi spend (from session logs)",
    `  Today:  ${money(s.today)}  (daily target ${money(DAILY_TARGET)})`,
    `  Month-to-date:  ${money(s.mtd)}  \u2014 ${s.monthPct}% of month elapsed`,
    `  ${budgetBar(s.mtd)}  ${icon} ${word}`,
    `  Remaining this month (${money(MONTHLY_LIMIT)} limit):  ${money(s.remaining)}`,
    `  ${keyLine(s)}`,
  ];
  const alert = dailyAlert(s.today);
  if (alert) lines.push(`  ${alert}`);
  if (s.days.length) {
    const recent = s.days.slice(-14);
    lines.push("", `Daily pi spend since ${s.anchor} (last ${recent.length}d)`);
    lines.push(chart(recent.map((d) => ({ label: d.date.slice(5), value: d.amount, note: money(d.amount) }))));
  }
  if (s.byModel.length) {
    const total = s.byModel.reduce((sum, m) => sum + m.cost, 0);
    lines.push("", `By model \u2014 ${money(total)} total`);
    lines.push(chart(s.byModel.slice(0, 8).map((m) => ({ label: m.label, value: m.cost, note: `${money(m.cost)} (${Math.round((m.cost / total) * 100)}%)` }))));
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    void (async () => {
      try {
        ctx.ui.setWidget("bedrock-cost", bootLines(getStats(false)));
      } catch {
        // no session logs yet / unreadable: skip the boot line silently
      }
    })();
  });

  pi.registerCommand("cost", {
    description: "pi spend today / MTD / budget bar + charts. `/cost rotate` when you issue a new Bedrock key",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      try {
        if (/\brotate|rotated|new.?key\b/.test(arg)) {
          const today = localDate(new Date());
          writeAnchor(today);
          const stats = getStats(true);
          ctx.ui.setWidget("bedrock-cost", bootLines(stats));
          ctx.ui.notify(`Key rotation recorded: counting spend from ${today}. ${keyLine(stats)}`, "info");
          return;
        }
        const stats = getStats(/\b(refresh|force|now)\b/.test(arg));
        ctx.ui.setWidget("bedrock-cost", bootLines(stats));
        ctx.ui.notify(fullReport(stats), status(stats.mtd, stats.elapsedFraction).icon === "\u{1F7E2}" ? "info" : "warn");
      } catch (err) {
        ctx.ui.notify(`Cost lookup failed: ${(err as Error).message}`, "error");
      }
    },
  });
}
