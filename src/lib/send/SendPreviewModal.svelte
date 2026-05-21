<script lang="ts">
  import { tick } from "svelte";

  import Modal from "../Modal.svelte";
  import type { SendOptions } from "../send";
  import "./send-preview.css";

  interface Props {
    open: boolean;
    sourceLabel: string;
    targetLabel: string;
    text: string;
    /** Initial values for the bracketed-paste / trailing-newline toggles. */
    defaults: SendOptions;
    onconfirm: (options: SendOptions) => void;
    oncancel: () => void;
  }

  let { open, sourceLabel, targetLabel, text, defaults, onconfirm, oncancel }: Props = $props();

  // Local form state — we only mutate the in-flight options, leaving the
  // app-wide `sendOptions` defaults untouched until the user explicitly
  // changes them in settings. Initialised from the inbound prop; an
  // `$effect` below re-seeds them every time `open` flips back to true,
  // which is the only point at which fresh defaults matter.
  let bracketedPaste = $state(true);
  let trailingNewline = $state(false);
  let expanded = $state(false);

  // Reset toggles whenever the modal opens for a new request.
  $effect(() => {
    if (open) {
      bracketedPaste = defaults.bracketedPaste;
      trailingNewline = defaults.trailingNewline;
      expanded = false;
    }
  });

  let sendBtn: HTMLButtonElement | undefined = $state();

  $effect(() => {
    if (!open) return;
    void tick().then(() => sendBtn?.focus());
  });

  function confirm(): void {
    onconfirm({ bracketedPaste, trailingNewline });
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.isComposing && !event.shiftKey) {
      // Only intercept Enter when the focus is inside the dialog — Modal
      // already scopes the event, but this guard keeps a future
      // multi-line textarea from swallowing form submission.
      const target = event.target as HTMLElement | null;
      if (target && target.tagName !== "TEXTAREA") {
        event.preventDefault();
        confirm();
      }
    }
  }

  const lineCount = $derived(text.split("\n").length);
  const charCount = $derived(text.length);
  const isLong = $derived(lineCount > 12 || charCount > 600);
</script>

<Modal {open} onclose={oncancel} label="Send preview" testid="send-preview" initialFocus={sendBtn}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div onkeydown={handleKeydown}>
    <header class="send-preview-header">
      <h2 class="send-preview-title">Send to pane</h2>
      <div class="send-preview-route">
        <span data-testid="send-preview-source">{sourceLabel}</span>
        <span class="arrow">→</span>
        <span data-testid="send-preview-target">{targetLabel}</span>
        <span>· {charCount} char{charCount === 1 ? "" : "s"}</span>
      </div>
    </header>
    <div class="send-preview-body">
      <pre
        class="send-preview-text"
        class:collapsed={isLong && !expanded}
        data-testid="send-preview-text">{text}</pre>
      {#if isLong}
        <button
          type="button"
          class="send-preview-toggle"
          onclick={() => (expanded = !expanded)}
          data-testid="send-preview-toggle"
        >
          {expanded ? "Show less" : `Show all (${lineCount} lines)`}
        </button>
      {/if}
      <div class="send-preview-options">
        <label>
          <input
            type="checkbox"
            bind:checked={bracketedPaste}
            data-testid="send-preview-bracketed"
          />
          Bracketed paste
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={trailingNewline}
            data-testid="send-preview-trailing"
          />
          Trailing newline
        </label>
      </div>
    </div>
    <footer class="send-preview-footer">
      <button type="button" onclick={oncancel} data-testid="send-preview-cancel"> Cancel </button>
      <button
        type="button"
        class="primary"
        bind:this={sendBtn}
        onclick={confirm}
        data-testid="send-preview-send"
      >
        Send
      </button>
    </footer>
  </div>
</Modal>
