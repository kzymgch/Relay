<script lang="ts">
  import { onMount } from "svelte";

  import Pane, { type PaneHandle, type PaneSendTarget } from "./Pane.svelte";
  import { DEFAULT_SEND_OPTIONS, SendHistory, sendTextTo, type SendOptions } from "./send";
  import "./app-root.css";

  type PaneSlotId = "left" | "topRight" | "bottomRight";

  interface PaneSpec {
    id: PaneSlotId;
    label: string;
    command: string;
    args?: string[];
  }

  // PR-07 spawns the user's login shell in every slot. PR-12 will let the
  // user configure each pane's command / cwd / env, and PR-14 will load the
  // defaults from `config.toml`.
  const panes: PaneSpec[] = [
    { id: "left", label: "Pane 1", command: "/bin/zsh", args: ["-l"] },
    { id: "topRight", label: "Pane 2", command: "/bin/zsh", args: ["-l"] },
    { id: "bottomRight", label: "Pane 3", command: "/bin/zsh", args: ["-l"] },
  ];

  let focusedId: PaneSlotId = $state("left");

  // Global font size in CSS pixels. Cmd+/-/0 adjusts this and every Pane
  // forwards it to xterm via its `fontSize` prop so the change applies in
  // lock-step. The bounds keep the terminal usable (sub-8px is unreadable,
  // 32px crowds out content on small windows).
  const DEFAULT_FONT_SIZE = 13;
  const MIN_FONT_SIZE = 8;
  const MAX_FONT_SIZE = 32;
  const FONT_STEP = 1;
  let fontSize: number = $state(DEFAULT_FONT_SIZE);

  function clampFontSize(n: number): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));
  }

  // Pane handles registered via `onregister`. Plain object rather than $state
  // because we read them at the moment of action (keystroke / menu click);
  // no view needs to re-render when they change.
  const handles: Partial<Record<PaneSlotId, PaneHandle>> = {};

  // Send options + history are app-level state. PR-18 (settings GUI) will
  // expose `sendOptions` for editing; for now we keep the spec defaults.
  let sendOptions: SendOptions = $state({ ...DEFAULT_SEND_OPTIONS });
  const history = new SendHistory();

  /**
   * Read the selection from `source`, then deliver it to `target`'s PTY via
   * the Rust bridge. No-ops cleanly when either side isn't ready yet (still
   * spawning, exited, or selection is empty) so UI affordances can stay
   * enabled without leaking errors.
   */
  async function sendSelection(source: PaneSlotId, target: PaneSlotId): Promise<void> {
    if (source === target) return;
    const src = handles[source];
    const tgt = handles[target];
    if (!src || !tgt) return;
    const text = src.getSelection();
    if (!text) return;
    const targetPtyId = tgt.getPtyId();
    if (!targetPtyId) return;
    try {
      await sendTextTo(
        {
          text,
          targetPtyId,
          sourceLabel: src.label,
          targetLabel: tgt.label,
          options: sendOptions,
        },
        history,
        sendOptions
      );
    } catch (e) {
      console.error("[page] pty_send_text failed", e);
    }
  }

  /**
   * Build the right-click "Send to" menu entries for `source`. The entries
   * close over `source` so picking one always sends from the pane the user
   * right-clicked, not from whichever pane happens to be focused.
   */
  function sendTargetsFor(source: PaneSlotId): PaneSendTarget[] {
    return panes
      .filter((p) => p.id !== source)
      .map<PaneSendTarget>((p) => ({
        label: p.label,
        onSelect: () => {
          void sendSelection(source, p.id);
        },
      }));
  }

  function registerHandle(id: PaneSlotId, handle: PaneHandle | undefined) {
    if (handle) {
      handles[id] = handle;
    } else {
      delete handles[id];
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    // All shortcuts in this app are Cmd-based; bail early on anything else
    // so unrelated typing (including ctrl-based zsh bindings inside the
    // terminal) is never preempted.
    if (!event.metaKey) return;
    if (event.ctrlKey || event.altKey) return;

    // Font size first: "+" / "_" naturally require Shift on US layouts, and
    // we want Cmd++ to behave like Cmd+= regardless of how the key is
    // surfaced to JS.
    switch (event.key) {
      case "=":
      case "+":
        event.preventDefault();
        fontSize = clampFontSize(fontSize + FONT_STEP);
        return;
      case "-":
      case "_":
        event.preventDefault();
        fontSize = clampFontSize(fontSize - FONT_STEP);
        return;
      case "0":
        event.preventDefault();
        fontSize = DEFAULT_FONT_SIZE;
        return;
    }

    // Cmd+Shift+1..N — send the focused pane's selection to pane N.
    if (event.shiftKey) {
      const digit = Number.parseInt(event.key, 10);
      if (Number.isFinite(digit) && digit >= 1 && digit <= panes.length) {
        event.preventDefault();
        void sendSelection(focusedId, panes[digit - 1]!.id);
      }
      // Other Cmd+Shift+* combos are reserved for later PRs (palette,
      // settings, etc).
      return;
    }

    // Cmd+1..N — focus pane N.
    const digit = Number.parseInt(event.key, 10);
    if (Number.isFinite(digit) && digit >= 1 && digit <= panes.length) {
      event.preventDefault();
      focusedId = panes[digit - 1]!.id;
      // The Pane's $effect on `focused` will pull xterm focus too, so we
      // don't need to call handle.focus() explicitly.
      return;
    }

    // Single-letter shortcuts dispatched against the focused pane.
    const focused = handles[focusedId];
    switch (event.key) {
      case "k":
      case "K":
        event.preventDefault();
        focused?.clear();
        return;
      case "r":
      case "R":
        // Prevent the browser's reload shortcut from torching the whole app
        // even when there's no focused handle yet (during initial mount).
        event.preventDefault();
        focused?.restart();
        return;
      case "f":
      case "F":
        event.preventDefault();
        focused?.openSearch();
        return;
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<div class="layout">
  {#each panes as pane (pane.id)}
    <div class="slot" style="grid-area: {pane.id};">
      <Pane
        label={pane.label}
        command={pane.command}
        args={pane.args}
        {fontSize}
        focused={focusedId === pane.id}
        onfocus={() => (focusedId = pane.id)}
        sendTargets={sendTargetsFor(pane.id)}
        onregister={(h) => registerHandle(pane.id, h)}
      />
    </div>
  {/each}
</div>
