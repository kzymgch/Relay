// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";

import PanesPanel, { type PaneRow } from "../../src/lib/panes/PanesPanel.svelte";

function basePanes(): PaneRow[] {
  return [
    {
      id: "pane-1",
      label: "Pane 1",
      command: "/bin/zsh",
      args: ["-l"],
      cwd: undefined,
      env: undefined,
      reorderHint: { direction: "row", canPrev: false, canNext: true },
      isSsh: false,
    },
    {
      id: "pane-2",
      label: "Pane 2",
      command: "/bin/zsh",
      args: ["-l"],
      cwd: "/tmp",
      env: { FOO: "bar" },
      reorderHint: { direction: "column", canPrev: true, canNext: true },
      isSsh: false,
    },
    {
      id: "pane-3",
      label: "Pane 3",
      isSsh: true,
      reorderHint: { direction: "column", canPrev: true, canNext: false },
    },
  ];
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    panes: basePanes(),
    initialPaneId: "pane-1",
    canClose: true,
    onupdatemeta: vi.fn(),
    onsplit: vi.fn(),
    onduplicate: vi.fn(),
    onreorder: vi.fn(),
    onclosepane: vi.fn(),
    onclose: vi.fn(),
    ...overrides,
  };
}

describe("PanesPanel", () => {
  afterEach(cleanup);

  it("does not render when open=false", () => {
    const { container } = render(PanesPanel, {
      props: defaultProps({ open: false }) as never,
    });
    expect(container.querySelector('[data-testid="panes-panel"]')).toBeNull();
  });

  it("opens with the initialPaneId tab active and prefills the form fields", () => {
    const { container } = render(PanesPanel, {
      props: defaultProps({ initialPaneId: "pane-2" }) as never,
    });
    const activeTab = container.querySelector('[data-testid="panes-tab-pane-2"]') as HTMLElement;
    expect(activeTab.classList.contains("active")).toBe(true);
    const labelInput = container.querySelector(
      '[data-testid="panes-field-label"]'
    ) as HTMLInputElement;
    expect(labelInput.value).toBe("Pane 2");
    const cwdInput = container.querySelector('[data-testid="panes-field-cwd"]') as HTMLInputElement;
    expect(cwdInput.value).toBe("/tmp");
    const envInput = container.querySelector(
      '[data-testid="panes-field-env"]'
    ) as HTMLTextAreaElement;
    expect(envInput.value).toBe("FOO=bar");
  });

  it("falls back to the first pane when initialPaneId is unknown", () => {
    const { container } = render(PanesPanel, {
      props: defaultProps({ initialPaneId: "octopus" }) as never,
    });
    const labelInput = container.querySelector(
      '[data-testid="panes-field-label"]'
    ) as HTMLInputElement;
    expect(labelInput.value).toBe("Pane 1");
  });

  it("switching tabs preserves drafts independently per tab", async () => {
    const { container } = render(PanesPanel, {
      props: defaultProps() as never,
    });
    // Tab 1: edit the label.
    const label = container.querySelector('[data-testid="panes-field-label"]') as HTMLInputElement;
    await fireEvent.input(label, { target: { value: "Edited 1" } });
    // Switch to tab 2 — label field reflects pane 2's spec.
    await fireEvent.click(
      container.querySelector('[data-testid="panes-tab-pane-2"]') as HTMLElement
    );
    const label2 = container.querySelector('[data-testid="panes-field-label"]') as HTMLInputElement;
    expect(label2.value).toBe("Pane 2");
    await fireEvent.input(label2, { target: { value: "Edited 2" } });
    // Switch back to tab 1 — earlier draft survives.
    await fireEvent.click(
      container.querySelector('[data-testid="panes-tab-pane-1"]') as HTMLElement
    );
    const labelBack = container.querySelector(
      '[data-testid="panes-field-label"]'
    ) as HTMLInputElement;
    expect(labelBack.value).toBe("Edited 1");
  });

  it("Save emits onupdatemeta for the active pane only", async () => {
    const onupdatemeta = vi.fn();
    const { container } = render(PanesPanel, {
      props: defaultProps({ onupdatemeta }) as never,
    });
    await fireEvent.input(
      container.querySelector('[data-testid="panes-field-label"]') as HTMLInputElement,
      { target: { value: "New label" } }
    );
    await fireEvent.input(
      container.querySelector('[data-testid="panes-field-args"]') as HTMLTextAreaElement,
      { target: { value: "-c\necho hello world" } }
    );
    await fireEvent.input(
      container.querySelector('[data-testid="panes-field-env"]') as HTMLTextAreaElement,
      { target: { value: "FOO=bar\nBAZ=qux" } }
    );
    await fireEvent.click(container.querySelector('[data-testid="panes-save"]') as HTMLElement);
    expect(onupdatemeta).toHaveBeenCalledTimes(1);
    const [paneId, patch] = onupdatemeta.mock.calls[0]!;
    expect(paneId).toBe("pane-1");
    expect(patch.label).toBe("New label");
    // Per-line args preserve embedded spaces.
    expect(patch.args).toEqual(["-c", "echo hello world"]);
    expect(patch.env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("Discard resets the active tab's draft to the live spec", async () => {
    const { container } = render(PanesPanel, {
      props: defaultProps() as never,
    });
    const label = container.querySelector('[data-testid="panes-field-label"]') as HTMLInputElement;
    await fireEvent.input(label, { target: { value: "Throwaway" } });
    await fireEvent.click(container.querySelector('[data-testid="panes-discard"]') as HTMLElement);
    const labelAfter = container.querySelector(
      '[data-testid="panes-field-label"]'
    ) as HTMLInputElement;
    expect(labelAfter.value).toBe("Pane 1");
  });

  it("Move buttons show direction-aware glyphs and fire onreorder for the active pane", async () => {
    const onreorder = vi.fn();
    const { container } = render(PanesPanel, {
      props: defaultProps({ onreorder, initialPaneId: "pane-1" }) as never,
    });
    const prev = container.querySelector('[data-testid="panes-move-prev"]') as HTMLButtonElement;
    const next = container.querySelector('[data-testid="panes-move-next"]') as HTMLButtonElement;
    // Pane 1 is sibling 0 in a row split → "Move ←" disabled, "Move →" enabled.
    expect(prev.textContent?.trim()).toBe("Move ←");
    expect(next.textContent?.trim()).toBe("Move →");
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    await fireEvent.click(next);
    expect(onreorder).toHaveBeenCalledWith("pane-1", 1);
  });

  it("Split right / down / Duplicate / Close pane fire with the active pane id", async () => {
    const onsplit = vi.fn();
    const onduplicate = vi.fn();
    const onclosepane = vi.fn();
    const { container } = render(PanesPanel, {
      props: defaultProps({
        onsplit,
        onduplicate,
        onclosepane,
        initialPaneId: "pane-2",
      }) as never,
    });
    await fireEvent.click(
      container.querySelector('[data-testid="panes-split-right"]') as HTMLElement
    );
    expect(onsplit).toHaveBeenCalledWith("pane-2", "row", "after");
    await fireEvent.click(
      container.querySelector('[data-testid="panes-split-down"]') as HTMLElement
    );
    expect(onsplit).toHaveBeenLastCalledWith("pane-2", "column", "after");
    await fireEvent.click(
      container.querySelector('[data-testid="panes-duplicate"]') as HTMLElement
    );
    expect(onduplicate).toHaveBeenCalledWith("pane-2");
    await fireEvent.click(container.querySelector('[data-testid="panes-close"]') as HTMLElement);
    expect(onclosepane).toHaveBeenCalledWith("pane-2");
  });

  it("Close pane button is disabled when canClose is false", () => {
    const { container } = render(PanesPanel, {
      props: defaultProps({ canClose: false }) as never,
    });
    const closeBtn = container.querySelector('[data-testid="panes-close"]') as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
  });

  it("SSH panes lock the command / args / cwd / env fields", () => {
    const { container } = render(PanesPanel, {
      props: defaultProps({ initialPaneId: "pane-3" }) as never,
    });
    const cmd = container.querySelector('[data-testid="panes-field-command"]') as HTMLInputElement;
    const args = container.querySelector('[data-testid="panes-field-args"]') as HTMLTextAreaElement;
    expect(cmd.disabled).toBe(true);
    expect(args.disabled).toBe(true);
  });
});
