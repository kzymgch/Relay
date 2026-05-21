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
    // Cmd+Shift+1..N — send the focused pane's selection to pane N.
    // We avoid stealing keys that don't both Meta and Shift to keep
    // editor-style shortcuts (e.g. Cmd+1) free for PR-09.
    if (!event.metaKey || !event.shiftKey) return;
    if (event.altKey || event.ctrlKey) return;
    const digit = Number.parseInt(event.key, 10);
    if (!Number.isFinite(digit) || digit < 1 || digit > panes.length) return;
    const target = panes[digit - 1];
    if (!target) return;
    event.preventDefault();
    void sendSelection(focusedId, target.id);
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
        focused={focusedId === pane.id}
        onfocus={() => (focusedId = pane.id)}
        sendTargets={sendTargetsFor(pane.id)}
        onregister={(h) => registerHandle(pane.id, h)}
      />
    </div>
  {/each}
</div>
