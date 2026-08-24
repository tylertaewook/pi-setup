import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

type Keybindings = ConstructorParameters<typeof CustomEditor>[2];

const IDLE_POLL_MS = 20;
const IDLE_TIMEOUT_MS = 10_000;
const PATCHED = Symbol.for("esc-flush-queue.patched");

type EditorLike = {
  handleInput(data: string): void;
  getText?(): string;
  setText?(text: string): void;
  addToHistory?(text: string): void;
  isShowingAutocomplete?(): boolean;
  onSubmit?: ((text: string) => void) | undefined;
};

// the decorated editor outlives the ctx it was installed with, and pi throws from
// any method on a ctx that a reload or session replacement has retired - so read
// the ctx through this and never capture one in a closure
let live: ExtensionContext | null = null;

function ask<T>(read: (ctx: ExtensionContext) => T, fallback: T): T {
  const ctx = live;
  if (!ctx) return fallback;
  try {
    return read(ctx);
  } catch {
    live = null;
    return fallback;
  }
}

function flushable(editor: EditorLike): boolean {
  return typeof editor.getText === "function" && typeof editor.setText === "function";
}

async function flush(editor: EditorLike, draft: string): Promise<void> {
  const started = live;
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  while (!ask((ctx) => ctx.isIdle(), true)) {
    if (Date.now() > deadline || live !== started) return;
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
  if (live !== started) return;

  const restored = editor.getText?.() ?? "";
  // the interrupt handler appends the untouched draft after the queued text
  const queued = draft && restored.endsWith(draft) ? restored.slice(0, restored.length - draft.length) : restored;
  if (!queued.trim()) return;

  editor.setText?.(draft);
  editor.addToHistory?.(queued.trimEnd());
  editor.onSubmit?.(queued.trimEnd());
}

// powerline installs its own editor after us (packages load after ~/.pi/agent/extensions)
// and forwards only the autocomplete provider, so subclassing loses the race - decorate
// whatever instance actually gets installed instead
function decorate(editor: EditorLike, keybindings: Keybindings): EditorLike {
  if (!flushable(editor)) return editor;

  const original = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    const flushing =
      keybindings.matches(data, "app.interrupt") &&
      !editor.isShowingAutocomplete?.() &&
      !ask((ctx) => ctx.isIdle(), true) &&
      ask((ctx) => ctx.hasPendingMessages(), false);
    const draft = flushing ? (editor.getText?.() ?? "") : "";

    original(data);

    if (flushing) void flush(editor, draft);
  };
  return editor;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    live = ctx;

    const ui = ctx.ui as typeof ctx.ui & { [PATCHED]?: boolean };
    if (ui[PATCHED]) return;
    ui[PATCHED] = true;

    const install = ctx.ui.setEditorComponent.bind(ctx.ui);

    ctx.ui.setEditorComponent = ((factory?: (tui: TUI, theme: EditorTheme, kb: Keybindings) => unknown) =>
      install(((tui: TUI, theme: EditorTheme, kb: Keybindings) =>
        decorate(
          (factory ? factory(tui, theme, kb) : new CustomEditor(tui, theme, kb)) as EditorLike,
          kb,
        )) as never)) as typeof ctx.ui.setEditorComponent;

    ctx.ui.setEditorComponent(undefined);
  });

  pi.on("session_shutdown", () => {
    live = null;
  });
}
