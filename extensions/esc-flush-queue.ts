import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

type Keybindings = ConstructorParameters<typeof CustomEditor>[2];

const IDLE_POLL_MS = 20;
const IDLE_TIMEOUT_MS = 10_000;

type EditorLike = {
  handleInput(data: string): void;
  getText?(): string;
  setText?(text: string): void;
  addToHistory?(text: string): void;
  isShowingAutocomplete?(): boolean;
  onSubmit?: ((text: string) => void) | undefined;
};

function flushable(editor: EditorLike): boolean {
  return typeof editor.getText === "function" && typeof editor.setText === "function";
}

async function flush(editor: EditorLike, ctx: ExtensionContext, draft: string): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  while (!ctx.isIdle()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }

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
function decorate(editor: EditorLike, keybindings: Keybindings, ctx: ExtensionContext): EditorLike {
  if (!flushable(editor)) return editor;

  const original = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    const flushing =
      keybindings.matches(data, "app.interrupt") &&
      !editor.isShowingAutocomplete?.() &&
      !ctx.isIdle() &&
      ctx.hasPendingMessages();
    const draft = flushing ? (editor.getText?.() ?? "") : "";

    original(data);

    if (flushing) void flush(editor, ctx, draft);
  };
  return editor;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const install = ctx.ui.setEditorComponent.bind(ctx.ui);

    const ownFactory = (tui: TUI, theme: EditorTheme, kb: Keybindings) =>
      decorate(new CustomEditor(tui, theme, kb) as unknown as EditorLike, kb, ctx) as never;

    ctx.ui.setEditorComponent = ((factory?: (tui: TUI, theme: EditorTheme, kb: Keybindings) => unknown) => {
      if (!factory) return install(ownFactory as never);
      return install(((tui: TUI, theme: EditorTheme, kb: Keybindings) =>
        decorate(factory(tui, theme, kb) as EditorLike, kb, ctx)) as never);
    }) as typeof ctx.ui.setEditorComponent;

    ctx.ui.setEditorComponent(undefined);
  });
}
