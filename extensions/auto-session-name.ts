import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const TITLE_AT_USER_TURNS = [2, 15, 50];
const TITLER_MODEL = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const MARKER = "autoSessionName";
const MAX_NAME = 64;
const TITLE_TIMEOUT_MS = 25_000;

type Marker = { name: string; atTurn: number };

function textOf(entry: SessionEntry, role: "user" | "assistant"): string | null {
  if (entry.type !== "message") return null;
  const message = entry.message as { role?: string; content?: unknown };
  if (message.role !== role) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block): block is { type: "text"; text: string } => (block as { type?: string })?.type === "text")
    .map((block) => block.text)
    .join(" ");
  return text || null;
}

function isRealUserTurn(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith("<");
}

function lastMarker(ctx: ExtensionContext): Marker | null {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === MARKER) return entry.data as Marker;
  }
  return null;
}

function userTurns(ctx: ExtensionContext): string[] {
  return ctx.sessionManager
    .getEntries()
    .map((entry) => textOf(entry, "user"))
    .filter((text): text is string => !!text && isRealUserTurn(text));
}

function fallbackName(ctx: ExtensionContext): string | null {
  const first = userTurns(ctx)[0];
  if (!first) return null;
  const cleaned = first
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, MAX_NAME) : null;
}

// ctx.getSessionName/setSessionName are unbound in headless print mode
function currentName(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager.getSessionName();
}

function applyName(ctx: ExtensionContext, name: string): boolean {
  if (typeof ctx.setSessionName !== "function") return false;
  ctx.setSessionName(name);
  return true;
}

// pi owns the name once you /name it yourself, so only overwrite what we wrote
function weOwnTheName(ctx: ExtensionContext, marker: Marker | null): boolean {
  const current = currentName(ctx);
  if (!current) return true;
  return !!marker && current === marker.name;
}

function buildPrompt(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  const turns: string[] = [];
  for (const entry of entries) {
    const user = textOf(entry, "user");
    if (user && isRealUserTurn(user)) turns.push(`USER: ${user.slice(0, 600)}`);
    const assistant = textOf(entry, "assistant");
    if (assistant) turns.push(`ASSISTANT: ${assistant.slice(0, 300)}`);
    if (turns.length >= 24) break;
  }
  return [
    "Title this coding session for a session picker list.",
    `Rules: under ${MAX_NAME} characters, lowercase except proper nouns, no quotes, no trailing period,`,
    "name the concrete work (files, features, tools, repos), not the fact that it is a conversation.",
    "Reply with the title only.",
    "",
    turns.join("\n"),
  ].join("\n");
}

async function generateName(ctx: ExtensionContext): Promise<string | null> {
  // -ne is what keeps this from recursing into another titler, the rest just makes it fast
  const args = [
    "--model",
    TITLER_MODEL,
    "--thinking",
    "off",
    "--no-session",
    "--no-tools",
    "-ne",
    "-ns",
    "-np",
    "-nc",
    "--offline",
    "-p",
    buildPrompt(ctx),
  ];
  const result = await ctx.exec("pi", args, { timeout: TITLE_TIMEOUT_MS });
  if (result.code !== 0) return null;
  const name = result.stdout.trim().split("\n").pop()?.replace(/^["']|["']$/g, "").trim();
  return name ? name.slice(0, MAX_NAME) : null;
}

export default function (pi: ExtensionAPI) {
  let busy = false;

  pi.on("agent_settled", async (_event, ctx) => {
    if (busy || ctx.mode !== "tui" || typeof ctx.exec !== "function") return;
    const turns = userTurns(ctx).length;
    const marker = lastMarker(ctx);
    if (!TITLE_AT_USER_TURNS.includes(turns)) return;
    if (marker && marker.atTurn >= turns) return;
    if (!weOwnTheName(ctx, marker)) return;

    busy = true;
    try {
      const name = await generateName(ctx);
      if (!name || !applyName(ctx, name)) return;
      ctx.appendEntry<Marker>(MARKER, { name, atTurn: turns });
    } finally {
      busy = false;
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (currentName(ctx)) return;
    const name = fallbackName(ctx);
    if (name) applyName(ctx, name);
  });
}
