// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("../../src/lib/modal.css", () => ({}));
vi.mock("../../src/lib/pipe/pipe-rules-panel.css", () => ({}));

vi.mock("@tauri-apps/api/event", async () => {
  const mod = await import("../_tauri-event-mock");
  return { listen: mod.listen };
});

import { emitTauriEvent, resetTauriEventListeners } from "../_tauri-event-mock";
import PipeRulesPanel from "../../src/lib/pipe/PipeRulesPanel.svelte";
import type { PipeRule } from "../../src/lib/pipe";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

let calls: Call[] = [];
let rulesOnDisk: PipeRule[] = [];

function setupMock() {
  mockIPC((cmd, args) => {
    const normalized = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: normalized });
    switch (cmd) {
      case "pipe_list":
        return rulesOnDisk;
      case "pipe_upsert": {
        const rule = normalized.rule as PipeRule;
        const idx = rulesOnDisk.findIndex((r) => r.id === rule.id);
        if (idx >= 0) rulesOnDisk[idx] = rule;
        else rulesOnDisk.push(rule);
        return undefined;
      }
      case "pipe_delete": {
        rulesOnDisk = rulesOnDisk.filter((r) => r.id !== normalized.id);
        return undefined;
      }
      case "pipe_toggle": {
        const idx = rulesOnDisk.findIndex((r) => r.id === normalized.id);
        if (idx >= 0) rulesOnDisk[idx] = { ...rulesOnDisk[idx]!, enabled: !!normalized.enabled };
        return undefined;
      }
      default:
        return undefined;
    }
  });
}

beforeEach(() => {
  calls = [];
  rulesOnDisk = [];
  setupMock();
});

afterEach(() => {
  cleanup();
  clearMocks();
  resetTauriEventListeners();
});

const PANES = [
  { id: "pane-a", label: "Pane A" },
  { id: "pane-b", label: "Pane B" },
] as const;

describe("PipeRulesPanel", () => {
  it("does not render when closed", () => {
    const { container } = render(PipeRulesPanel, {
      props: { open: false, onclose: vi.fn(), panes: PANES },
    });
    expect(container.querySelector('[data-testid="pipe-rules-panel"]')).toBeNull();
  });

  it("creates a rule via pipe_upsert when the user clicks Add rule", async () => {
    const { container } = render(PipeRulesPanel, {
      props: { open: true, onclose: vi.fn(), panes: PANES },
    });

    // Wait for the first pipe_list refresh to land.
    await waitFor(() => expect(calls.some((c) => c.cmd === "pipe_list")).toBe(true));

    const source = container.querySelector('[data-testid="pipe-rule-source"]') as HTMLSelectElement;
    const target = container.querySelector('[data-testid="pipe-rule-target"]') as HTMLSelectElement;
    await fireEvent.change(source, { target: { value: "pane-a" } });
    await fireEvent.change(target, { target: { value: "pane-b" } });

    const save = container.querySelector('[data-testid="pipe-rules-save"]') as HTMLButtonElement;
    await fireEvent.click(save);

    await waitFor(() => {
      const upsertCalls = calls.filter((c) => c.cmd === "pipe_upsert");
      expect(upsertCalls.length).toBeGreaterThan(0);
      const rule = upsertCalls[upsertCalls.length - 1]!.args.rule as PipeRule;
      expect(rule.source).toBe("pane-a");
      expect(rule.target).toBe("pane-b");
      expect(rule.mode.kind).toBe("lineRealtime");
    });
  });

  it("toggles a rule's enabled flag through pipe_toggle", async () => {
    rulesOnDisk = [
      {
        id: "r1",
        source: "pane-a",
        target: "pane-b",
        enabled: true,
        mode: { kind: "lineRealtime" },
        include: null,
        exclude: null,
        stripAnsi: true,
      },
    ];
    const { container } = render(PipeRulesPanel, {
      props: { open: true, onclose: vi.fn(), panes: PANES },
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="pipe-rule-r1"]')).not.toBeNull();
    });

    const toggle = container.querySelector(
      '[data-testid="pipe-rule-toggle-r1"]'
    ) as HTMLInputElement;
    await fireEvent.click(toggle);

    await waitFor(() => {
      const toggleCalls = calls.filter((c) => c.cmd === "pipe_toggle");
      expect(toggleCalls.length).toBeGreaterThan(0);
      expect(toggleCalls[toggleCalls.length - 1]!.args.id).toBe("r1");
      expect(toggleCalls[toggleCalls.length - 1]!.args.enabled).toBe(false);
    });
  });

  it("deletes a rule through pipe_delete", async () => {
    rulesOnDisk = [
      {
        id: "r-del",
        source: "pane-a",
        target: "pane-b",
        enabled: true,
        mode: { kind: "lineRealtime" },
        include: null,
        exclude: null,
        stripAnsi: true,
      },
    ];
    const { container } = render(PipeRulesPanel, {
      props: { open: true, onclose: vi.fn(), panes: PANES },
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="pipe-rule-r-del"]')).not.toBeNull();
    });

    const del = container.querySelector(
      '[data-testid="pipe-rule-delete-r-del"]'
    ) as HTMLButtonElement;
    await fireEvent.click(del);

    await waitFor(() => {
      const deleteCalls = calls.filter((c) => c.cmd === "pipe_delete");
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(deleteCalls[deleteCalls.length - 1]!.args.id).toBe("r-del");
    });
  });

  it("shows a toast when a cycle-rejected event arrives", async () => {
    const { container } = render(PipeRulesPanel, {
      props: { open: true, onclose: vi.fn(), panes: PANES },
    });

    await waitFor(() => expect(calls.some((c) => c.cmd === "pipe_list")).toBe(true));

    emitTauriEvent("pipe:cycleRejected", {
      ruleId: "r1",
      source: "pane-a",
      target: "pane-b",
    });

    await waitFor(() => {
      const toast = container.querySelector('[data-testid="pipe-rules-toast"]');
      expect(toast).not.toBeNull();
      expect(toast?.textContent).toContain("cycle");
    });
  });
});
