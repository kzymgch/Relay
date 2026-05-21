<script lang="ts" module>
  export interface ModalProps {
    open: boolean;
    /** Click on the backdrop dismisses; Escape dismisses. */
    onclose: () => void;
    /** ARIA label for the dialog. */
    label: string;
    /** Stable hook for tests (e.g. "command-palette", "settings-panel"). */
    testid?: string;
    /** Optional element to focus on open. */
    initialFocus?: HTMLElement | null;
    /** Body content. */
    children?: import("svelte").Snippet;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";

  import "./modal.css";

  let { open, onclose, label, testid, initialFocus, children }: ModalProps = $props();

  // When the modal opens, move keyboard focus to its content so Escape /
  // arrow keys land inside the dialog instead of the underlying terminal.
  $effect(() => {
    if (!open) return;
    void tick().then(() => {
      initialFocus?.focus();
    });
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onclose();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="modal-backdrop"
    onclick={onclose}
    {onkeydown}
    data-testid={testid ? `${testid}-backdrop` : undefined}
  >
    <div
      class="modal-window"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label={label}
      data-testid={testid}
      onclick={(e) => e.stopPropagation()}
    >
      {@render children?.()}
    </div>
  </div>
{/if}
