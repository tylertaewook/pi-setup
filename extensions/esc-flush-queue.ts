import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

type Keybindings = ConstructorParameters<typeof CustomEditor>[2];

const IDLE_POLL_MS = 20;
const IDLE_TIMEOUT_MS = 10_000;
const PATCHED = Symbol.for("esc-flush-queue.patched");
const STATE = Symbol.for("esc-flush-queue.state");

type EditorLike = {
  handleInput(data: string): void;
  getText?(): string;
  setText?(text: string): void;
  isShowingAutocomplete?(): boolean;
  onSubmit?: ((text: string) => void) | undefined;
};

// /reload re-evaluates this module but keeps the same ui object, so an editor
// installed before the reload still runs the OLD module's closure - shared state
// has to live somewhere both instances can see
type State = { live: ExtensionContext | null; flushing: boolean };
const state: State = ((globalThis as Record<symbol, unknown>)[STATE] as State | undefined) ??
  ((globalThis as Record<symbol, unknown>)[STATE] = { live: null, flushing: false } as State) as State;

function ask<T>(read: (ctx: ExtensionContext) => T, fallback: T): T {
  const ctx = state.live;
  if (!ctx) return fallback;
  try {
    return read(ctx);
  } catch {
    // pi throws from every method on a ctx retired by reload or session replacement
    state.live = null;
    return fallback;
  }
}

function flushable(editor: EditorLike): boolean {
  return typeof editor.getText === "function" && typeof editor.setText === "function";
}

// pi restores the queue synchronously as `queued + "\n\n" + draft`
function splitRestored(restored: string, draft: string): string {
  return draft && restored.endsWith(draft) ? restored.slice(0, restored.length - draft.length) : restored;
}

async function flush(editor: EditorLike, restored: string, draft: string): Promise<void> {
  const queued = splitRestored(restored, draft).trimEnd();
  if (!queued) return;

  const started = state.live;
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  while (!ask((ctx) => ctx.isIdle(), true)) {
    if (Date.now() > deadline || state.live !== started) return;
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
  if (state.live !== started) return;

  // keep anything typed during the wait instead of reverting to the old draft
  const now = editor.getText?.() ?? "";
  const typedSince = now.startsWith(restored) ? now.slice(restored.length) : "";
  editor.setText?.(draft + typedSince);
  // pi's own submit path calls addToHistory, so adding it here would duplicate
  editor.onSubmit?.(queued);
}

// powerline installs its own editor after us (packages load after ~/.pi/agent/extensions)
// and forwards only the autocomplete provider, so subclassing loses the race - decorate
// whatever instance actually gets installed instead
function decorate(editor: EditorLike, keybindings: Keybindings): EditorLike {
  if (!flushable(editor)) return editor;

  const original = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    const flushing =
      !state.flushing &&
      keybindings.matches(data, "app.interrupt") &&
      !editor.isShowingAutocomplete?.() &&
      !ask((ctx) => ctx.isIdle(), true) &&
      ask((ctx) => ctx.hasPendingMessages(), false);
    const draft = flushing ? (editor.getText?.() ?? "") : "";

    original(data);

    if (!flushing) return;
    // read the restored buffer now: the restore is synchronous, and waiting until
    // after the idle poll would fold anything typed meanwhile into the message
    const restored = editor.getText?.() ?? "";
    state.flushing = true;
    void flush(editor, restored, draft)
      .catch(() => {})
      .finally(() => {
        state.flushing = false;
      });
  };
  return editor;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.live = ctx;

    const ui = ctx.ui as typeof ctx.ui & { [PATCHED]?: boolean };
    if (ui[PATCHED]) return;
    ui[PATCHED] = true;

    const install = ctx.ui.setEditorComponent.bind(ctx.ui);
    const wrap = (factory: (tui: TUI, theme: EditorTheme, kb: Keybindings) => unknown) =>
      ((tui: TUI, theme: EditorTheme, kb: Keybindings) => decorate(factory(tui, theme, kb) as EditorLike, kb)) as never;

    ctx.ui.setEditorComponent = ((factory?: (tui: TUI, theme: EditorTheme, kb: Keybindings) => unknown) =>
      // passing undefined through unchanged keeps "restore pi's default editor"
      // working for callers that rely on it
      install(factory ? wrap(factory) : undefined)) as typeof ctx.ui.setEditorComponent;

    const installed = ctx.ui.getEditorComponent?.();
    ctx.ui.setEditorComponent(
      installed ?? ((tui: TUI, theme: EditorTheme, kb: Keybindings) => new CustomEditor(tui, theme, kb) as never),
    );
  });

  pi.on("session_shutdown", () => {
    state.live = null;
  });
}
