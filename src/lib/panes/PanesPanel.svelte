<script lang="ts" module>
  import type { PaneMetaPatch } from "../Pane.svelte";

  export interface PaneRow {
    id: string;
    label: string;
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    /** Hint for the Move ← / Move → buttons; `null` when the pane is the
     *  lone root and can't be reordered. */
    reorderHint: {
      direction: "row" | "column";
      canPrev: boolean;
      canNext: boolean;
    } | null;
    /** `true` for SSH panes — fields that don't apply (command / args /
     *  cwd / env) are still shown read-only so the user sees what was
     *  saved without us silently dropping them on save. */
    isSsh: boolean;
  }

  export interface PanesPanelProps {
    open: boolean;
    panes: readonly PaneRow[];
    /** Initial selected tab. Falls back to the first pane when omitted or
     *  when the id isn't in `panes`. */
    initialPaneId?: string;
    /** Whether closing a pane is permitted right now (false when only one
     *  pane remains). */
    canClose: boolean;
    onupdatemeta: (paneId: string, patch: PaneMetaPatch) => void;
    onsplit: (paneId: string, direction: "row" | "column", position: "before" | "after") => void;
    onduplicate: (paneId: string) => void;
    onreorder: (paneId: string, delta: -1 | 1) => void;
    onclosepane: (paneId: string) => void;
    onclose: () => void;
  }
</script>

<script lang="ts">
  import Modal from "../Modal.svelte";
  import "./panes-panel.css";

  let {
    open,
    panes,
    initialPaneId,
    canClose,
    onupdatemeta,
    onsplit,
    onduplicate,
    onreorder,
    onclosepane,
    onclose,
  }: PanesPanelProps = $props();

  interface Draft {
    label: string;
    command: string;
    argsRaw: string;
    cwd: string;
    envRaw: string;
  }

  // Per-tab draft state survives tab switches but is wiped on modal close
  // (so opening fresh always reflects the live pane spec). Keyed by pane
  // id so a layout change between opens doesn't bleed stale drafts into a
  // different pane.
  let drafts: Record<string, Draft> = $state({});
  let activeId: string = $state("");

  /** Build a fresh draft from the live pane spec. The args / env raw
   *  strings mirror the form's textareas — keeping them as separate
   *  fields avoids round-tripping through `.split("\n")` on every
   *  keystroke and losing the cursor position. */
  function freshDraft(row: PaneRow): Draft {
    return {
      label: row.label,
      command: row.command ?? "",
      argsRaw: (row.args ?? []).join("\n"),
      cwd: row.cwd ?? "",
      envRaw: Object.entries(row.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    };
  }

  // Re-seed drafts whenever the modal opens. Tab switching uses the
  // already-seeded drafts so unsaved edits survive.
  $effect(() => {
    if (!open) {
      drafts = {};
      return;
    }
    const next: Record<string, Draft> = {};
    for (const row of panes) {
      next[row.id] = freshDraft(row);
    }
    drafts = next;
    const initial =
      initialPaneId && panes.some((p) => p.id === initialPaneId)
        ? initialPaneId
        : (panes[0]?.id ?? "");
    activeId = initial;
  });

  const activePane = $derived(panes.find((p) => p.id === activeId));
  const activeDraft = $derived(drafts[activeId]);

  function parseArgs(raw: string): string[] {
    return raw
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  function parseEnv(raw: string): Record<string, string> | undefined {
    if (raw.trim() === "") return undefined;
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return out;
  }

  function save(): void {
    if (!activePane || !activeDraft) return;
    const patch: PaneMetaPatch = {
      label: activeDraft.label,
      command: activeDraft.command,
      args: parseArgs(activeDraft.argsRaw),
      cwd: activeDraft.cwd.trim() === "" ? undefined : activeDraft.cwd,
      env: parseEnv(activeDraft.envRaw),
    };
    onupdatemeta(activePane.id, patch);
  }

  function discard(): void {
    if (!activePane) return;
    drafts = { ...drafts, [activePane.id]: freshDraft(activePane) };
  }

  function updateDraft(patch: Partial<Draft>): void {
    if (!activePane) return;
    const current = drafts[activePane.id];
    if (!current) return;
    drafts = { ...drafts, [activePane.id]: { ...current, ...patch } };
  }
</script>

<Modal {open} {onclose} label="Pane settings" testid="panes-panel">
  <header class="panes-header">
    <h2>Panes</h2>
    <div class="panes-tabs" role="tablist">
      {#each panes as row (row.id)}
        <button
          type="button"
          class="panes-tab"
          class:active={row.id === activeId}
          role="tab"
          aria-selected={row.id === activeId}
          onclick={() => (activeId = row.id)}
          data-testid={`panes-tab-${row.id}`}
        >
          {row.label}
        </button>
      {/each}
    </div>
  </header>

  {#if activePane && activeDraft}
    {@const row = activePane}
    {@const draft = activeDraft}
    <div class="panes-body" data-testid={`panes-body-${row.id}`}>
      <label>
        <span>Label</span>
        <input
          type="text"
          value={draft.label}
          oninput={(e) => updateDraft({ label: (e.currentTarget as HTMLInputElement).value })}
          data-testid="panes-field-label"
        />
      </label>
      <label>
        <span>Command{row.isSsh ? " (SSH pane — ignored)" : ""}</span>
        <input
          type="text"
          value={draft.command}
          oninput={(e) => updateDraft({ command: (e.currentTarget as HTMLInputElement).value })}
          disabled={row.isSsh}
          data-testid="panes-field-command"
        />
      </label>
      <label>
        <span>Args (one per line)</span>
        <textarea
          rows="3"
          value={draft.argsRaw}
          oninput={(e) => updateDraft({ argsRaw: (e.currentTarget as HTMLTextAreaElement).value })}
          disabled={row.isSsh}
          spellcheck="false"
          autocapitalize="none"
          data-testid="panes-field-args"
        ></textarea>
      </label>
      <label>
        <span>Cwd</span>
        <input
          type="text"
          value={draft.cwd}
          oninput={(e) => updateDraft({ cwd: (e.currentTarget as HTMLInputElement).value })}
          disabled={row.isSsh}
          data-testid="panes-field-cwd"
        />
      </label>
      <label>
        <span>Env (KEY=value per line)</span>
        <textarea
          rows="3"
          value={draft.envRaw}
          oninput={(e) => updateDraft({ envRaw: (e.currentTarget as HTMLTextAreaElement).value })}
          disabled={row.isSsh}
          data-testid="panes-field-env"
        ></textarea>
      </label>
      <p class="panes-hint">Command / args / cwd / env apply on next restart (Cmd+R).</p>
    </div>

    <footer class="panes-footer">
      <div class="panes-actions primary">
        <button type="button" onclick={discard} data-testid="panes-discard">Discard</button>
        <button type="button" class="primary" onclick={save} data-testid="panes-save">
          Save
        </button>
      </div>
      {#if row.reorderHint}
        <div class="panes-actions">
          <button
            type="button"
            onclick={() => onreorder(row.id, -1)}
            disabled={!row.reorderHint.canPrev}
            data-testid="panes-move-prev"
            title={row.reorderHint.direction === "row" ? "Move left" : "Move up"}
          >
            {row.reorderHint.direction === "row" ? "Move ←" : "Move ↑"}
          </button>
          <button
            type="button"
            onclick={() => onreorder(row.id, 1)}
            disabled={!row.reorderHint.canNext}
            data-testid="panes-move-next"
            title={row.reorderHint.direction === "row" ? "Move right" : "Move down"}
          >
            {row.reorderHint.direction === "row" ? "Move →" : "Move ↓"}
          </button>
        </div>
      {/if}
      <div class="panes-actions">
        <button
          type="button"
          onclick={() => onsplit(row.id, "row", "after")}
          data-testid="panes-split-right"
        >
          Split right
        </button>
        <button
          type="button"
          onclick={() => onsplit(row.id, "column", "after")}
          data-testid="panes-split-down"
        >
          Split down
        </button>
        <button type="button" onclick={() => onduplicate(row.id)} data-testid="panes-duplicate">
          Duplicate
        </button>
        <button
          type="button"
          class="danger"
          disabled={!canClose}
          onclick={() => onclosepane(row.id)}
          data-testid="panes-close"
        >
          Close pane
        </button>
      </div>
    </footer>
  {:else}
    <div class="panes-empty">No panes.</div>
  {/if}
</Modal>
