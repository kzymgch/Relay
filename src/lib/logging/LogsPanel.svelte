<script lang="ts">
  // Live tail (spec §11). Polls `log_tail` while the modal is visible. The
  // poll pauses when the document is hidden so a Cmd+Tab away doesn't burn
  // IPC calls and FDs.
  import Modal from "../Modal.svelte";
  import { logTail } from "../logging";
  import "./logs-panel.css";

  interface Props {
    open: boolean;
    onclose: () => void;
    paneId: string | null;
    paneLabel: string;
  }

  const { open, onclose, paneId, paneLabel }: Props = $props();

  const POLL_MS = 500;
  const TAIL_BYTES = 32 * 1024;

  let tailText: string = $state("");
  let lastError: string | null = $state(null);
  const decoder = new TextDecoder();

  $effect(() => {
    if (!open || !paneId) {
      tailText = "";
      lastError = null;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const bytes = await logTail(paneId, TAIL_BYTES);
        if (cancelled) return;
        tailText = decoder.decode(bytes);
        lastError = null;
      } catch (e) {
        if (cancelled) return;
        lastError = e instanceof Error ? e.message : String(e);
      }
    };
    void tick();
    timer = setInterval(() => {
      void tick();
    }, POLL_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  });
</script>

<Modal {open} {onclose} label="Logs" testid="logs-panel">
  <div class="logs-panel-header">
    <h2>Logs: {paneLabel}</h2>
    <button type="button" data-testid="logs-panel-close" onclick={onclose}>Close</button>
  </div>
  <p class="logs-panel-meta" data-testid="logs-panel-meta">
    Tail polled every {POLL_MS} ms while this panel is open. Last {TAIL_BYTES} bytes shown.
  </p>
  <div class="logs-panel-body">
    {#if lastError}
      <p class="logs-panel-empty" data-testid="logs-panel-error">Error: {lastError}</p>
    {:else if tailText === ""}
      <p class="logs-panel-empty" data-testid="logs-panel-empty">
        No log lines yet. Enable logging in Settings and wait for output.
      </p>
    {:else}
      <pre class="logs-panel-tail" data-testid="logs-panel-tail">{tailText}</pre>
    {/if}
  </div>
</Modal>
