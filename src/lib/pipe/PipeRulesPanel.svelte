<script lang="ts">
  import Modal from "../Modal.svelte";
  import {
    defaultPipeMode,
    formatPipeMode,
    onPipeAutoDisabled,
    onPipeCycleRejected,
    onPipeTargetGone,
    pipeDelete,
    pipeList,
    pipeToggle,
    pipeUpsert,
    type PipeMode,
    type PipeRule,
  } from "../pipe";
  import "./pipe-rules-panel.css";

  interface PaneOption {
    id: string;
    label: string;
  }

  interface Props {
    open: boolean;
    onclose: () => void;
    /** The current pane list, used to populate source / target dropdowns. */
    panes: readonly PaneOption[];
    /** Called after every successful upsert/delete/toggle so AppRoot can
     *  refresh the status-bar rule count without polling. */
    onrulesChanged?: (rules: readonly PipeRule[]) => void;
  }

  const { open, onclose, panes, onrulesChanged }: Props = $props();

  let rules: PipeRule[] = $state([]);
  let toast: string | null = $state(null);

  // Draft form for "Add rule". An edit reuses the same form by pre-loading
  // the existing rule's values; the id is the implicit primary key so a
  // re-upsert with the same id replaces the row server-side.
  let draftId: string = $state("");
  let draftSource: string = $state("");
  let draftTarget: string = $state("");
  let draftEnabled: boolean = $state(true);
  let draftStripAnsi: boolean = $state(true);
  let draftInclude: string = $state("");
  let draftExclude: string = $state("");
  let draftKind: PipeMode["kind"] = $state("lineRealtime");
  let draftPattern: string = $state("");
  let draftLines: number = $state(5);
  let draftIntervalMs: number = $state(1000);

  let unlistenCycle: (() => void) | undefined;
  let unlistenAuto: (() => void) | undefined;
  let unlistenGone: (() => void) | undefined;

  async function refresh(): Promise<void> {
    try {
      rules = await pipeList();
      onrulesChanged?.(rules);
    } catch (e) {
      console.error("[pipe-rules] pipe_list failed", e);
    }
  }

  function showToast(message: string): void {
    toast = message;
  }

  $effect(() => {
    if (!open) return;
    void refresh();
    // Subscribe inline so the toast surface only listens while the modal
    // is visible.
    let cancelled = false;
    void (async () => {
      const cy = await onPipeCycleRejected((p) => {
        showToast(`Rule ${p.ruleId}: cycle ${p.source} → ${p.target} rejected`);
      });
      const auto = await onPipeAutoDisabled((p) => {
        showToast(`Rule ${p.ruleId} auto-disabled: ${p.reason}`);
        void refresh();
      });
      const gone = await onPipeTargetGone((p) => {
        showToast(`Rule ${p.ruleId}: target ${p.target} not running`);
      });
      if (cancelled) {
        cy();
        auto();
        gone();
        return;
      }
      unlistenCycle = cy;
      unlistenAuto = auto;
      unlistenGone = gone;
    })();
    return () => {
      cancelled = true;
      unlistenCycle?.();
      unlistenAuto?.();
      unlistenGone?.();
      unlistenCycle = undefined;
      unlistenAuto = undefined;
      unlistenGone = undefined;
    };
  });

  function resetDraft(): void {
    draftId = "";
    draftSource = panes[0]?.id ?? "";
    draftTarget = panes[1]?.id ?? "";
    draftEnabled = true;
    draftStripAnsi = true;
    draftInclude = "";
    draftExclude = "";
    const def = defaultPipeMode();
    draftKind = def.kind;
    draftPattern = "";
    draftLines = 5;
    draftIntervalMs = 1000;
  }

  function loadIntoDraft(rule: PipeRule): void {
    draftId = rule.id;
    draftSource = rule.source;
    draftTarget = rule.target;
    draftEnabled = rule.enabled;
    draftStripAnsi = rule.stripAnsi;
    draftInclude = rule.include ?? "";
    draftExclude = rule.exclude ?? "";
    draftKind = rule.mode.kind;
    draftPattern = rule.mode.kind === "regexMatch" ? rule.mode.pattern : "";
    draftLines = rule.mode.kind === "tailPeriodic" ? rule.mode.lines : 5;
    draftIntervalMs = rule.mode.kind === "tailPeriodic" ? rule.mode.intervalMs : 1000;
  }

  function buildMode(): PipeMode {
    switch (draftKind) {
      case "lineRealtime":
        return { kind: "lineRealtime" };
      case "regexMatch":
        return { kind: "regexMatch", pattern: draftPattern };
      case "tailPeriodic":
        return { kind: "tailPeriodic", lines: draftLines, intervalMs: draftIntervalMs };
      case "onExit":
        return { kind: "onExit" };
    }
  }

  async function saveDraft(): Promise<void> {
    const id = draftId.trim() || crypto.randomUUID();
    if (!draftSource || !draftTarget) {
      showToast("Source and target are required.");
      return;
    }
    if (draftSource === draftTarget) {
      showToast("Source and target must differ.");
      return;
    }
    const rule: PipeRule = {
      id,
      source: draftSource,
      target: draftTarget,
      enabled: draftEnabled,
      mode: buildMode(),
      include: draftInclude.trim() === "" ? null : draftInclude,
      exclude: draftExclude.trim() === "" ? null : draftExclude,
      stripAnsi: draftStripAnsi,
    };
    try {
      await pipeUpsert(rule);
      toast = null;
      resetDraft();
      await refresh();
    } catch (e) {
      showToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function deleteRule(rule: PipeRule): Promise<void> {
    try {
      await pipeDelete(rule.id);
      await refresh();
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function toggle(rule: PipeRule): Promise<void> {
    try {
      await pipeToggle(rule.id, !rule.enabled);
      await refresh();
    } catch (e) {
      showToast(`Toggle failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function labelFor(id: string): string {
    return panes.find((p) => p.id === id)?.label ?? id;
  }
</script>

<Modal {open} {onclose} label="Pipe rules" testid="pipe-rules-panel">
  <div class="pipe-rules-header">
    <h2>Pipe rules</h2>
    <button type="button" data-testid="pipe-rules-close" onclick={onclose}>Close</button>
  </div>
  <div class="pipe-rules-body">
    {#if toast}
      <div class="pipe-rules-toast" data-testid="pipe-rules-toast" role="alert">{toast}</div>
    {/if}

    {#if rules.length === 0}
      <div class="pipe-rules-empty" data-testid="pipe-rules-empty">No rules yet.</div>
    {:else}
      <table class="pipe-rules-table" data-testid="pipe-rules-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Target</th>
            <th>Mode</th>
            <th>Filter</th>
            <th>On</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rules as rule (rule.id)}
            <tr data-testid={`pipe-rule-${rule.id}`}>
              <td>{labelFor(rule.source)}</td>
              <td>{labelFor(rule.target)}</td>
              <td>{formatPipeMode(rule.mode)}</td>
              <td>
                {rule.include ? `inc: ${rule.include}` : ""}
                {rule.exclude ? ` exc: ${rule.exclude}` : ""}
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  data-testid={`pipe-rule-toggle-${rule.id}`}
                  onchange={() => toggle(rule)}
                  aria-label={`Toggle rule ${rule.id}`}
                />
              </td>
              <td class="danger">
                <button
                  type="button"
                  data-testid={`pipe-rule-edit-${rule.id}`}
                  onclick={() => loadIntoDraft(rule)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-testid={`pipe-rule-delete-${rule.id}`}
                  onclick={() => deleteRule(rule)}
                >
                  Delete
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <div class="pipe-rules-form" data-testid="pipe-rules-form">
      <label for="pipe-rule-source">Source</label>
      <select id="pipe-rule-source" bind:value={draftSource} data-testid="pipe-rule-source">
        <option value="" disabled>(select)</option>
        {#each panes as p (p.id)}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
      <label for="pipe-rule-target">Target</label>
      <select id="pipe-rule-target" bind:value={draftTarget} data-testid="pipe-rule-target">
        <option value="" disabled>(select)</option>
        {#each panes as p (p.id)}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
      <label for="pipe-rule-mode">Mode</label>
      <select id="pipe-rule-mode" bind:value={draftKind} data-testid="pipe-rule-mode">
        <option value="lineRealtime">Line realtime</option>
        <option value="regexMatch">Regex match</option>
        <option value="tailPeriodic">Tail periodic</option>
        <option value="onExit">On exit</option>
      </select>
      {#if draftKind === "regexMatch"}
        <label for="pipe-rule-pattern">Pattern</label>
        <input
          id="pipe-rule-pattern"
          type="text"
          bind:value={draftPattern}
          data-testid="pipe-rule-pattern"
        />
      {/if}
      {#if draftKind === "tailPeriodic"}
        <label for="pipe-rule-lines">Lines</label>
        <input
          id="pipe-rule-lines"
          type="number"
          min="1"
          bind:value={draftLines}
          data-testid="pipe-rule-lines"
        />
        <label for="pipe-rule-interval">Interval (ms)</label>
        <input
          id="pipe-rule-interval"
          type="number"
          min="50"
          bind:value={draftIntervalMs}
          data-testid="pipe-rule-interval"
        />
      {/if}
      <label for="pipe-rule-include">Include regex</label>
      <input
        id="pipe-rule-include"
        type="text"
        bind:value={draftInclude}
        data-testid="pipe-rule-include"
      />
      <label for="pipe-rule-exclude">Exclude regex</label>
      <input
        id="pipe-rule-exclude"
        type="text"
        bind:value={draftExclude}
        data-testid="pipe-rule-exclude"
      />
      <label for="pipe-rule-strip-ansi">Strip ANSI</label>
      <input
        id="pipe-rule-strip-ansi"
        type="checkbox"
        bind:checked={draftStripAnsi}
        data-testid="pipe-rule-strip-ansi"
      />
      <label for="pipe-rule-enabled">Enabled</label>
      <input
        id="pipe-rule-enabled"
        type="checkbox"
        bind:checked={draftEnabled}
        data-testid="pipe-rule-enabled"
      />
    </div>
  </div>

  <div class="pipe-rules-actions">
    <button type="button" data-testid="pipe-rules-reset" onclick={resetDraft}>Reset</button>
    <button type="button" class="primary" data-testid="pipe-rules-save" onclick={saveDraft}>
      {draftId ? "Update rule" : "Add rule"}
    </button>
  </div>
</Modal>
