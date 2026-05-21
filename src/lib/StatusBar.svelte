<script lang="ts">
  // Status bar (spec §16). Renders below the layout grid and surfaces the
  // focused pane, the most recent send target, the count of active pipe
  // rules, and the current session name.
  //
  // Pure presentational — AppRoot owns the data sources (layout store,
  // pipe rule count, session name) and passes them in via props. No IPC
  // happens here.
  import "./status-bar.css";

  interface Props {
    focusedLabel: string;
    /** Label of the focused pane's most recent send target, or null. */
    sendTargetLabel: string | null;
    /** Number of enabled pipe rules currently in the registry. */
    activeRuleCount: number;
    /** Session name from the most recent save / autosave; "" when unsaved. */
    sessionName: string;
  }

  const { focusedLabel, sendTargetLabel, activeRuleCount, sessionName }: Props = $props();
</script>

<div class="status-bar" data-testid="status-bar">
  <span class="status-bar-item" data-testid="status-bar-focused">
    <span class="label">Focus</span>
    <span>{focusedLabel}</span>
  </span>
  {#if sendTargetLabel}
    <span class="status-bar-item" data-testid="status-bar-send-target">
      <span class="label">→</span>
      <span>{sendTargetLabel}</span>
    </span>
  {/if}
  <span class="status-bar-spacer"></span>
  <span class="status-bar-item" data-testid="status-bar-rules">
    <span class="label">Rules</span>
    <span>{activeRuleCount}</span>
  </span>
  <span class="status-bar-item" data-testid="status-bar-session">
    <span class="label">Session</span>
    <span>{sessionName || "(unsaved)"}</span>
  </span>
</div>
