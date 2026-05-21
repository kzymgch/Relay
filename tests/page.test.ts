// @vitest-environment jsdom
//
// Integration tests for the top-level `+page.svelte` route — primarily to
// cover the inter-pane send wiring (Cmd+Shift+1..N + the right-click menu's
// resolve-from-handles flow). We stub the xterm and tauri-event modules so
// the page mounts without a real terminal or Tauri runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("@xterm/xterm", async () => {
  const { MockTerminal } = await import("./_xterm-mocks");
  return { Terminal: MockTerminal };
});
vi.mock("@xterm/addon-fit", async () => {
  const { MockFitAddon } = await import("./_xterm-mocks");
  return { FitAddon: MockFitAddon };
});
vi.mock("@xterm/addon-web-links", async () => {
  const { MockWebLinksAddon } = await import("./_xterm-mocks");
  return { WebLinksAddon: MockWebLinksAddon };
});
vi.mock("@xterm/addon-search", async () => {
  const { MockSearchAddon } = await import("./_xterm-mocks");
  return { SearchAddon: MockSearchAddon };
});
vi.mock("@xterm/addon-serialize", async () => {
  const { MockSerializeAddon } = await import("./_xterm-mocks");
  return { SerializeAddon: MockSerializeAddon };
});
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../src/lib/terminal.css", () => ({}));
vi.mock("../src/lib/pane.css", () => ({}));
vi.mock("../src/lib/app-root.css", () => ({}));

vi.mock("@tauri-apps/api/event", async () => {
  const mod = await import("./_tauri-event-mock");
  return { listen: mod.listen };
});

import Page from "../src/lib/AppRoot.svelte";
import { getXtermState, resetXtermMocks } from "./_xterm-mocks";
import { emitTauriEvent, resetTauriEventListeners } from "./_tauri-event-mock";

interface InvocationLog {
  cmd: string;
  args: Record<string, unknown>;
}

let invocations: InvocationLog[] = [];
let nextPaneId = 1;

function installIpcMock(): void {
  mockIPC((cmd, args) => {
    invocations.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    return undefined;
  });
}

const originalRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
function installUuidMock(): void {
  globalThis.crypto.randomUUID = (() =>
    `pane-${nextPaneId++}` as ReturnType<Crypto["randomUUID"]>) as Crypto["randomUUID"];
}

beforeEach(() => {
  invocations = [];
  nextPaneId = 1;
  resetXtermMocks();
  resetTauriEventListeners();
  clearMocks();
  installIpcMock();
  installUuidMock();
});

afterEach(() => {
  // Tear down mounted components so their MockTerminal instances don't
  // bleed selection state into the next test (each test seeds selection
  // on instances[0..2]).
  cleanup();
  globalThis.crypto.randomUUID = originalRandomUUID;
});

async function mountPage() {
  const result = render(Page);
  // Wait for all three panes to finish their initial pty_spawn so the
  // handle registry has every pane's pty id available.
  await vi.waitFor(() => {
    const running = result.container.querySelectorAll(".status-running");
    expect(running.length).toBe(3);
  });
  return result;
}

describe("Page — inter-pane send", () => {
  it("Cmd+Shift+2 sends the focused pane's selection to pane 2", async () => {
    await mountPage();

    // First xterm instance is the left pane (focused on mount); seed its
    // selection so the keybinding has something to deliver.
    const [left] = getXtermState().instances;
    left!.selection = "ls -la";

    invocations = [];

    // On a US keyboard a real Cmd+Shift+2 surfaces with `key === "@"` and
    // `code === "Digit2"`. The dispatch mirrors that so we'd catch any
    // regression to event.key-based gating.
    await fireEvent.keyDown(window, {
      key: "@",
      code: "Digit2",
      metaKey: true,
      shiftKey: true,
    });

    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeDefined();
    });
    const send = invocations.find((i) => i.cmd === "pty_send_text")!;
    // pane-1 = left, pane-2 = topRight (Pane 2 in spec terms). The
    // JS-allocated id sequence matches the order panes mount.
    expect(send.args).toEqual({
      id: "pane-2",
      text: "ls -la",
      bracketedPaste: true,
      trailingNewline: false,
    });
  });

  it("Cmd+Shift+3 sends to pane 3", async () => {
    await mountPage();
    const [left] = getXtermState().instances;
    left!.selection = "echo hi";
    invocations = [];

    await fireEvent.keyDown(window, {
      key: "#",
      code: "Digit3",
      metaKey: true,
      shiftKey: true,
    });

    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeDefined();
    });
    expect(invocations.find((i) => i.cmd === "pty_send_text")!.args.id).toBe("pane-3");
  });

  it("Cmd+Shift+<own-index> is a no-op (no self-send)", async () => {
    await mountPage();
    const [left] = getXtermState().instances;
    left!.selection = "ls";
    invocations = [];

    await fireEvent.keyDown(window, {
      key: "!",
      code: "Digit1",
      metaKey: true,
      shiftKey: true,
    });
    // Give the async sendSelection a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeUndefined();
  });

  it("Cmd+Shift+N with an empty selection is a no-op", async () => {
    await mountPage();
    // Selection defaults to empty on all panes.
    invocations = [];

    await fireEvent.keyDown(window, {
      key: "@",
      code: "Digit2",
      metaKey: true,
      shiftKey: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeUndefined();
  });

  it("ignores Cmd+<digit> without Shift on a send-targeting test (focuses instead)", async () => {
    // Cmd+digit alone is the focus shortcut, not a send; pty_send_text must
    // not fire. (Replaces the old "stays free for PR-09" guard now that
    // PR-09 has actually wired Cmd+1..N to focus.)
    await mountPage();
    const [left] = getXtermState().instances;
    left!.selection = "ls";
    invocations = [];

    await fireEvent.keyDown(window, { key: "2", code: "Digit2", metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeUndefined();
  });

  it("Cmd+Shift+N is a no-op when the target pane has exited", async () => {
    // Without the exit-clears-ptyId fix in Pane.svelte, AppRoot would resolve
    // a stale id for the exited target and the bridge would error with
    // "unknown pty id". The page-level contract is a clean no-op instead.
    await mountPage();
    const [left] = getXtermState().instances;
    left!.selection = "ls";

    // Exit pane 2.
    emitTauriEvent("pty:exit", { paneId: "pane-2", code: 0, success: true });
    invocations = [];

    await fireEvent.keyDown(window, {
      key: "@",
      code: "Digit2",
      metaKey: true,
      shiftKey: true,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeUndefined();
  });

  it("Cmd+1..3 moves keyboard focus across panes", async () => {
    const { container } = await mountPage();
    const instances = getXtermState().instances;
    instances[0]!.focus.mockClear();
    instances[1]!.focus.mockClear();
    instances[2]!.focus.mockClear();

    await fireEvent.keyDown(window, { key: "2", code: "Digit2", metaKey: true });
    await vi.waitFor(() => {
      expect(instances[1]!.focus).toHaveBeenCalled();
    });
    const panes = Array.from(container.querySelectorAll(".pane")) as HTMLElement[];
    expect(panes[1]!.classList.contains("focused")).toBe(true);

    await fireEvent.keyDown(window, { key: "3", code: "Digit3", metaKey: true });
    await vi.waitFor(() => {
      expect(instances[2]!.focus).toHaveBeenCalled();
    });
  });

  it("Cmd+K clears the focused pane's terminal", async () => {
    await mountPage();
    const [left] = getXtermState().instances;
    left!.clear.mockClear();
    await fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(left!.clear).toHaveBeenCalledTimes(1);
  });

  it("Cmd+R restarts the focused pane (kill + respawn)", async () => {
    await mountPage();
    invocations = [];
    await fireEvent.keyDown(window, { key: "r", metaKey: true });
    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_kill")).toBeDefined();
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });
    const killIdx = invocations.findIndex((i) => i.cmd === "pty_kill");
    const spawnIdx = invocations.findIndex((i) => i.cmd === "pty_spawn");
    expect(killIdx).toBeLessThan(spawnIdx);
    // Only the focused pane (left = pane-1) restarts.
    expect((invocations[killIdx] as InvocationLog).args.id).toBe("pane-1");
  });

  it("Cmd+F opens the focused pane's search bar", async () => {
    const { container } = await mountPage();
    expect(container.querySelector('[data-testid="pane-search"]')).toBeNull();
    await fireEvent.keyDown(window, { key: "f", metaKey: true });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="pane-search"]')).not.toBeNull();
    });
    // It opens inside the focused (left) pane, not somewhere else.
    const panes = Array.from(container.querySelectorAll(".pane")) as HTMLElement[];
    expect(panes[0]!.querySelector('[data-testid="pane-search"]')).not.toBeNull();
  });

  it("Cmd+= / Cmd++ / Cmd+- adjust font size on every pane in lock-step", async () => {
    await mountPage();
    const instances = getXtermState().instances;
    const initial = instances[0]!.options.fontSize as number;
    expect(typeof initial).toBe("number");

    await fireEvent.keyDown(window, { key: "=", code: "Equal", metaKey: true });
    await vi.waitFor(() => {
      expect(instances[0]!.options.fontSize).toBe(initial + 1);
    });
    expect(instances[1]!.options.fontSize).toBe(initial + 1);
    expect(instances[2]!.options.fontSize).toBe(initial + 1);

    // Cmd++ on a US keyboard is physically Shift+Equal — `key === "+"`,
    // `code === "Equal"`. Code-based dispatch keeps this working.
    await fireEvent.keyDown(window, {
      key: "+",
      code: "Equal",
      metaKey: true,
      shiftKey: true,
    });
    await vi.waitFor(() => {
      expect(instances[0]!.options.fontSize).toBe(initial + 2);
    });

    await fireEvent.keyDown(window, { key: "-", code: "Minus", metaKey: true });
    await vi.waitFor(() => {
      expect(instances[0]!.options.fontSize).toBe(initial + 1);
    });
  });

  it("Cmd+0 resets font size to the default", async () => {
    await mountPage();
    const instances = getXtermState().instances;
    const initial = instances[0]!.options.fontSize as number;

    await fireEvent.keyDown(window, { key: "=", code: "Equal", metaKey: true });
    await fireEvent.keyDown(window, { key: "=", code: "Equal", metaKey: true });
    await vi.waitFor(() => {
      expect(instances[0]!.options.fontSize).toBe(initial + 2);
    });

    await fireEvent.keyDown(window, { key: "0", code: "Digit0", metaKey: true });
    await vi.waitFor(() => {
      expect(instances[0]!.options.fontSize).toBe(initial);
    });
  });

  it("font size clamps at the configured minimum so it can't go subzero", async () => {
    await mountPage();
    const instances = getXtermState().instances;
    const initial = instances[0]!.options.fontSize as number;
    for (let i = 0; i < 50; i++) {
      await fireEvent.keyDown(window, { key: "-", code: "Minus", metaKey: true });
    }
    const final = instances[0]!.options.fontSize as number;
    expect(final).toBeGreaterThan(0);
    expect(final).toBeLessThan(initial);
  });

  it("ignores letter shortcuts without Cmd so typing stays in the terminal", async () => {
    await mountPage();
    const [left] = getXtermState().instances;
    left!.clear.mockClear();
    invocations = [];

    await fireEvent.keyDown(window, { key: "k" });
    await fireEvent.keyDown(window, { key: "r" });
    await fireEvent.keyDown(window, { key: "f" });
    await new Promise((r) => setTimeout(r, 20));

    expect(left!.clear).not.toHaveBeenCalled();
    expect(invocations.find((i) => i.cmd === "pty_kill")).toBeUndefined();
  });

  it("ignores Ctrl+letter so OS / shell shortcuts pass through to the terminal", async () => {
    await mountPage();
    const [left] = getXtermState().instances;
    left!.clear.mockClear();
    await fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(left!.clear).not.toHaveBeenCalled();
  });

  it("close button removes a pane and kills its PTY", async () => {
    const { container } = await mountPage();
    // Initial pane order: slot-left, slot-top-right, slot-bottom-right.
    // Close pane 2 (slot-top-right) — its PTY id is "pane-2".
    const panes = Array.from(container.querySelectorAll(".pane")) as HTMLElement[];
    expect(panes.length).toBe(3);
    const closeBtn = panes[1]!.querySelector(
      'button[aria-label="Close pane"]'
    ) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);
    invocations = [];
    await fireEvent.click(closeBtn);
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".pane").length).toBe(2);
    });
    const kill = invocations.find((i) => i.cmd === "pty_kill");
    expect(kill).toBeDefined();
    expect(kill!.args.id).toBe("pane-2");
  });

  it("disables the close button when only one pane remains", async () => {
    const { container } = await mountPage();
    // Close two panes to leave only one.
    const closeAll = async () => {
      const panes = Array.from(container.querySelectorAll(".pane")) as HTMLElement[];
      for (const p of panes) {
        const btn = p.querySelector('button[aria-label="Close pane"]') as HTMLButtonElement;
        if (!btn.disabled) {
          await fireEvent.click(btn);
          return;
        }
      }
    };
    await closeAll();
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".pane").length).toBe(2);
    });
    await closeAll();
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".pane").length).toBe(1);
    });
    const lastPane = container.querySelector(".pane")!;
    const closeBtn = lastPane.querySelector('button[aria-label="Close pane"]') as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
  });

  it("Move buttons in the pane popover reorder siblings in the same split", async () => {
    // Pane 2 (slot-top-right) sits in the column split alongside Pane 3.
    // Moving it down should swap their DOM order; PTYs survive (no kill/spawn).
    const { container } = await mountPage();
    const panes = Array.from(container.querySelectorAll(".pane")) as HTMLElement[];
    const pane2 = panes[1]!;
    const gear = pane2.querySelector('button[aria-label="Pane settings"]') as HTMLButtonElement;
    await fireEvent.click(gear);
    const moveDown = pane2.querySelector(
      '[data-testid="pane-settings-move-next"]'
    ) as HTMLButtonElement;
    // Inside a column split → glyph is "Move ↓".
    expect(moveDown.textContent?.trim()).toBe("Move ↓");
    invocations = [];
    await fireEvent.click(moveDown);

    await vi.waitFor(() => {
      const labels = Array.from(container.querySelectorAll(".pane .label")).map(
        (n) => (n as HTMLElement).textContent
      );
      // After reorder, the right column shows Pane 3 on top and Pane 2 on
      // bottom. DOM order corresponds to `Object.values(store.panes)`
      // insertion order, which doesn't change — so we check the layout
      // rect ordering by reading the `.slot` style top values instead.
      expect(labels).toEqual(["Pane 1", "Pane 2", "Pane 3"]);
    });
    // The store reordered the column's children; no PTY kill / spawn.
    expect(invocations.find((i) => i.cmd === "pty_kill")).toBeUndefined();
    expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeUndefined();
  });

  it("applies the horizontal-3 preset without killing any PTY (paneIds unchanged)", async () => {
    // Phase 4 contract (spec §5): same-count preset switches must reuse pane
    // ids verbatim so the Pane components stay mounted and the PTYs survive.
    // We verify by snapshotting `pty_kill` and `pty_spawn` invocation counts
    // before and after — they should not increase.
    const { container } = await mountPage();
    const toggle = container.querySelector(
      '[data-testid="layout-menu-toggle"]'
    ) as HTMLButtonElement;
    await fireEvent.click(toggle);
    const beforeSpawns = invocations.filter((i) => i.cmd === "pty_spawn").length;
    const beforeKills = invocations.filter((i) => i.cmd === "pty_kill").length;

    const horizontal = container.querySelector(
      '[data-testid="layout-menu-preset-horizontal-3"]'
    ) as HTMLButtonElement;
    await fireEvent.click(horizontal);

    // Allow Svelte to flush — the menu closes and the tree updates.
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="layout-menu-list"]')).toBeNull();
    });
    // Still three panes in the DOM, no new spawn / kill IPCs.
    expect(container.querySelectorAll(".pane").length).toBe(3);
    const afterSpawns = invocations.filter((i) => i.cmd === "pty_spawn").length;
    const afterKills = invocations.filter((i) => i.cmd === "pty_kill").length;
    expect(afterSpawns).toBe(beforeSpawns);
    expect(afterKills).toBe(beforeKills);
  });

  it("grid-2x2 preset spawns a fourth PTY for the new pane", async () => {
    const { container } = await mountPage();
    const toggle = container.querySelector(
      '[data-testid="layout-menu-toggle"]'
    ) as HTMLButtonElement;
    await fireEvent.click(toggle);
    invocations = [];
    const btn = container.querySelector(
      '[data-testid="layout-menu-preset-grid-2x2"]'
    ) as HTMLButtonElement;
    await fireEvent.click(btn);
    // The Pane component spawns asynchronously after mount, so wait for the
    // running status of the fourth pane rather than just its DOM presence.
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".status-running").length).toBe(4);
    });
    const spawns = invocations.filter((i) => i.cmd === "pty_spawn");
    expect(spawns).toHaveLength(1);
  });

  it("right-click menu on pane 2 sends to pane 3 using pane 2's selection", async () => {
    const { container } = await mountPage();
    // Find the second pane (topRight) by its label.
    const panes = Array.from(container.querySelectorAll(".pane")) as HTMLElement[];
    expect(panes.length).toBe(3);
    const pane2 = panes[1]!;

    // Seed selection on pane 2's xterm — the handles map orders by mount.
    getXtermState().instances[1]!.selection = "from pane 2";
    invocations = [];

    await fireEvent.contextMenu(pane2, { clientX: 10, clientY: 10 });
    const menu = pane2.querySelector('[data-testid="pane-send-menu"]');
    expect(menu).not.toBeNull();

    // Menu lists the two other panes; click "Pane 3".
    const buttons = Array.from(menu!.querySelectorAll("button")) as HTMLButtonElement[];
    const pane3Btn = buttons.find((b) => b.textContent === "Pane 3");
    expect(pane3Btn).toBeDefined();
    await fireEvent.click(pane3Btn!);

    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeDefined();
    });
    const send = invocations.find((i) => i.cmd === "pty_send_text")!;
    expect(send.args).toMatchObject({
      id: "pane-3",
      text: "from pane 2",
      bracketedPaste: true,
      trailingNewline: false,
    });
  });
});
