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

    await fireEvent.keyDown(window, { key: "2", metaKey: true, shiftKey: true });

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

    await fireEvent.keyDown(window, { key: "3", metaKey: true, shiftKey: true });

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

    await fireEvent.keyDown(window, { key: "1", metaKey: true, shiftKey: true });
    // Give the async sendSelection a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeUndefined();
  });

  it("Cmd+Shift+N with an empty selection is a no-op", async () => {
    await mountPage();
    // Selection defaults to empty on all panes.
    invocations = [];

    await fireEvent.keyDown(window, { key: "2", metaKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeUndefined();
  });

  it("ignores Cmd+<digit> without Shift so it stays free for PR-09 focus shortcuts", async () => {
    await mountPage();
    const [left] = getXtermState().instances;
    left!.selection = "ls";
    invocations = [];

    await fireEvent.keyDown(window, { key: "2", metaKey: true, shiftKey: false });
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

    await fireEvent.keyDown(window, { key: "2", metaKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(invocations.find((i) => i.cmd === "pty_send_text")).toBeUndefined();
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
