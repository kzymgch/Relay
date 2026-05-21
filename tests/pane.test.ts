// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
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

vi.mock("@tauri-apps/api/event", async () => {
  const mod = await import("./_tauri-event-mock");
  return { listen: mod.listen };
});

import Pane from "../src/lib/Pane.svelte";
import { getXtermState, resetXtermMocks } from "./_xterm-mocks";
import { emitTauriEvent, listenerCount, resetTauriEventListeners } from "./_tauri-event-mock";

interface InvocationLog {
  cmd: string;
  args: Record<string, unknown>;
}

let invocations: InvocationLog[] = [];
let nextPaneId = 1;
let spawnError: string | undefined;

function installIpcMock(): void {
  mockIPC((cmd, args) => {
    const normalized = (args ?? {}) as Record<string, unknown>;
    invocations.push({ cmd, args: normalized });
    switch (cmd) {
      case "pty_spawn":
        if (spawnError) {
          throw new Error(spawnError);
        }
        // The id now travels in the request; backend just confirms success.
        return undefined;
      case "pty_write":
      case "pty_resize":
      case "pty_kill":
        return undefined;
      default:
        return undefined;
    }
  });
}

// `crypto.randomUUID()` is called inside Pane.spawn() right before pty_spawn.
// Tests need predictable ids to assert on, so we stub it with the same
// "pane-N" sequence the previous backend allocator used.
const originalRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
function installUuidMock(): void {
  globalThis.crypto.randomUUID = (() =>
    `pane-${nextPaneId++}` as ReturnType<Crypto["randomUUID"]>) as Crypto["randomUUID"];
}

beforeEach(() => {
  invocations = [];
  nextPaneId = 1;
  spawnError = undefined;
  resetXtermMocks();
  resetTauriEventListeners();
  clearMocks();
  installIpcMock();
  installUuidMock();
});

afterEach(() => {
  globalThis.crypto.randomUUID = originalRandomUUID;
});

async function mountPane(extraProps: Record<string, unknown> = {}) {
  const result = render(Pane, {
    props: {
      label: "Pane A",
      command: "/bin/zsh",
      args: ["-l"],
      ...extraProps,
    },
  });
  // The first thing the pane does is mount Terminal, which triggers onready,
  // which kicks off pty_spawn.
  await vi.waitFor(() => {
    expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
  });
  return result;
}

describe("Pane component", () => {
  it("spawns the configured command on mount", async () => {
    const { container } = await mountPane({
      label: "Shell",
      command: "/bin/zsh",
      args: ["-l"],
    });
    const spawn = invocations.find((i) => i.cmd === "pty_spawn")!;
    const config = spawn.args.config as Record<string, unknown>;
    expect(config.command).toBe("/bin/zsh");
    expect(config.args).toEqual(["-l"]);
    expect(config.cols).toBe(80);
    expect(config.rows).toBe(24);

    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    expect(container.querySelector(".label")?.textContent).toBe("Shell");
  });

  it("renders an exited status when pty:exit arrives", async () => {
    const { container } = await mountPane();
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });

    emitTauriEvent("pty:exit", { paneId: "pane-1", code: 7, success: false });

    await vi.waitFor(() => {
      expect(container.querySelector(".status-exited")).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="pane-status"]')?.textContent).toContain("code 7");
  });

  it("forwards typed input to pty_write", async () => {
    const { container } = await mountPane();
    // Wait until spawn() has resolved and the pane is `running` — only then
    // does handleData forward to pty_write.
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    invocations = [];

    for (const cb of getXtermState().dataHandlers) cb("abc");

    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_write")).toBeDefined();
    });
    const write = invocations.find((i) => i.cmd === "pty_write")!;
    expect(write.args.id).toBe("pane-1");
    expect(write.args.data).toEqual([97, 98, 99]); // utf-8 bytes for "abc"
  });

  it("writes pty:data events into the terminal", async () => {
    const { container } = await mountPane();
    // The pty:data listener is wired up inside spawn() after spawnPty
    // resolves; wait for the running state so we know the listener is live.
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const term = getXtermState().instances.at(-1)!;
    term.write.mockClear();

    emitTauriEvent("pty:data", { paneId: "pane-1", data: [104, 105] });

    await vi.waitFor(() => {
      expect(term.write).toHaveBeenCalled();
    });
    const written = term.write.mock.calls[0]?.[0] as Uint8Array;
    expect(written).toBeInstanceOf(Uint8Array);
    expect(Array.from(written)).toEqual([104, 105]);
  });

  it("ignores pty:data events for other panes", async () => {
    const { container } = await mountPane();
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const term = getXtermState().instances.at(-1)!;
    term.write.mockClear();
    emitTauriEvent("pty:data", { paneId: "pane-OTHER", data: [1, 2, 3] });
    expect(term.write).not.toHaveBeenCalled();
  });

  it("click fires the onfocus callback", async () => {
    const onfocus = vi.fn();
    const { container } = await mountPane({ onfocus });
    const paneEl = container.querySelector(".pane")!;
    await fireEvent.click(paneEl);
    expect(onfocus).toHaveBeenCalledTimes(1);
  });

  it("clicking the restart button does not trigger onfocus", async () => {
    const onfocus = vi.fn();
    const { container } = await mountPane({ onfocus });
    const restartBtn = container.querySelector(
      'button[aria-label="Restart pane"]'
    ) as HTMLButtonElement;
    await fireEvent.click(restartBtn);
    expect(onfocus).not.toHaveBeenCalled();
  });

  it("focused=true applies the focused class", async () => {
    const { container } = await mountPane({ focused: true });
    expect(container.querySelector(".pane.focused")).not.toBeNull();
  });

  it("restart kills the current PTY and spawns a fresh one", async () => {
    const { container } = await mountPane();
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    invocations = [];

    const restartBtn = container.querySelector(
      'button[aria-label="Restart pane"]'
    ) as HTMLButtonElement;
    await fireEvent.click(restartBtn);

    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_kill")).toBeDefined();
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });

    const killIdx = invocations.findIndex((i) => i.cmd === "pty_kill");
    const spawnIdx = invocations.findIndex((i) => i.cmd === "pty_spawn");
    expect(killIdx).toBeLessThan(spawnIdx);
    expect((invocations[killIdx] as InvocationLog).args.id).toBe("pane-1");
  });

  it("shows an error banner when pty_spawn rejects", async () => {
    spawnError = "/bin/nope: not found";
    const { container } = await mountPane({ command: "/bin/nope" });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-error")).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="pane-error"]')?.textContent).toContain(
      "/bin/nope: not found"
    );
  });

  it("routes pty:data emitted while pty_spawn is still in flight", async () => {
    // The bridge starts its forward task immediately after spawn_pty returns
    // and can emit `pty:data` / `pty:exit` before the Tauri response makes
    // it back to JS. Because the frontend now picks its own id and commits
    // `currentPtyId` before awaiting spawnPty, the listener can route those
    // pre-response events instead of dropping them on the floor.
    let spawnResolve: (() => void) | undefined;
    mockIPC((cmd, args) => {
      invocations.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "pty_spawn") {
        return new Promise<void>((resolve) => {
          spawnResolve = resolve;
        });
      }
      return undefined;
    });

    render(Pane, {
      props: { label: "x", command: "/bin/echo", args: ["hi"] },
    });

    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });
    // At this point spawnPty is still pending, but listeners are already
    // registered AND currentPtyId is already committed to the JS-allocated
    // id.
    expect(listenerCount("pty:data")).toBe(1);
    expect(listenerCount("pty:exit")).toBe(1);

    const term = getXtermState().instances.at(-1)!;
    term.write.mockClear();
    emitTauriEvent("pty:data", { paneId: "pane-1", data: [104, 105] });

    await vi.waitFor(() => {
      expect(term.write).toHaveBeenCalled();
    });
    expect(Array.from(term.write.mock.calls[0]?.[0] as Uint8Array)).toEqual([104, 105]);

    spawnResolve?.();
  });

  it("kills the late-arrived PTY when unmount races with spawn", async () => {
    let spawnResolve: (() => void) | undefined;
    mockIPC((cmd, args) => {
      invocations.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "pty_spawn") {
        return new Promise<void>((resolve) => {
          spawnResolve = resolve;
        });
      }
      return undefined;
    });

    const { unmount } = render(Pane, {
      props: { label: "x", command: "/bin/sleep", args: ["10"] },
    });
    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });

    unmount();

    // Backend reports the spawn finally succeeded — after the pane is gone.
    expect(spawnResolve).toBeDefined();
    spawnResolve?.();

    // The post-await branch must detect `destroyed` and kill the late id so
    // the PTY does not leak in the registry.
    await vi.waitFor(() => {
      const kill = invocations.find((i) => i.cmd === "pty_kill");
      expect(kill).toBeDefined();
      // The JS-allocated id (first call to our mocked randomUUID).
      expect((kill as InvocationLog).args.id).toBe("pane-1");
    });

    // No listener should remain attached to the dead pane.
    expect(listenerCount("pty:data")).toBe(0);
    expect(listenerCount("pty:exit")).toBe(0);
  });

  it("focuses the terminal when the focused prop becomes true", async () => {
    // Initial mount with focused=false: no focus call yet.
    const { rerender } = render(Pane, {
      props: {
        label: "x",
        command: "/bin/zsh",
        focused: false,
      },
    });
    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });
    const focusFn = getXtermState().instances.at(-1)!.focus;
    expect(focusFn).not.toHaveBeenCalled();

    // Parent now selects this pane — xterm must receive the focus call so
    // keystrokes go to the right pane without the user clicking.
    await rerender({
      label: "x",
      command: "/bin/zsh",
      focused: true,
    });
    await vi.waitFor(() => {
      expect(focusFn).toHaveBeenCalled();
    });
  });

  it("ignores a stale spawn success when restart races", async () => {
    // Hold both spawn calls open so we can settle them in the wrong order
    // and confirm the stale (first) response cannot flip the pane to
    // running once a newer session has started.
    let firstResolve: (() => void) | undefined;
    let secondResolve: (() => void) | undefined;
    let spawnCount = 0;
    mockIPC((cmd, args) => {
      invocations.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "pty_spawn") {
        spawnCount += 1;
        if (spawnCount === 1) {
          return new Promise<void>((resolve) => {
            firstResolve = resolve;
          });
        }
        if (spawnCount === 2) {
          return new Promise<void>((resolve) => {
            secondResolve = resolve;
          });
        }
      }
      return undefined;
    });

    const { container } = render(Pane, {
      props: { label: "x", command: "/bin/zsh" },
    });
    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });

    const restartBtn = container.querySelector(
      'button[aria-label="Restart pane"]'
    ) as HTMLButtonElement;
    await fireEvent.click(restartBtn);

    await vi.waitFor(() => {
      expect(invocations.filter((i) => i.cmd === "pty_spawn").length).toBeGreaterThanOrEqual(2);
    });

    // Stale success must not flip the pane to running.
    firstResolve?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector(".status-running")).toBeNull();
    expect(container.querySelector(".status-spawning")).not.toBeNull();

    // The current session decides the transition.
    secondResolve?.();
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
  });

  it("ignores a stale spawn failure when restart races", async () => {
    let firstReject: ((err: unknown) => void) | undefined;
    let secondResolve: (() => void) | undefined;
    let spawnCount = 0;
    mockIPC((cmd, args) => {
      invocations.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "pty_spawn") {
        spawnCount += 1;
        if (spawnCount === 1) {
          return new Promise<void>((_, reject) => {
            firstReject = reject;
          });
        }
        if (spawnCount === 2) {
          return new Promise<void>((resolve) => {
            secondResolve = resolve;
          });
        }
      }
      return undefined;
    });

    const { container } = render(Pane, {
      props: { label: "x", command: "/bin/zsh" },
    });
    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });

    const restartBtn = container.querySelector(
      'button[aria-label="Restart pane"]'
    ) as HTMLButtonElement;
    await fireEvent.click(restartBtn);

    await vi.waitFor(() => {
      expect(invocations.filter((i) => i.cmd === "pty_spawn").length).toBeGreaterThanOrEqual(2);
    });

    // Stale failure must not flip the pane to error.
    firstReject?.(new Error("stale spawn failure"));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector(".status-error")).toBeNull();
    expect(container.querySelector(".status-spawning")).not.toBeNull();

    // The current session decides the transition.
    secondResolve?.();
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
  });

  it("right-click with a selection opens the Send-to menu listing targets", async () => {
    const onSelect = vi.fn();
    const { container } = await mountPane({
      sendTargets: [
        { label: "Pane 2", onSelect },
        { label: "Pane 3", onSelect: vi.fn() },
      ],
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    // Selection has to be non-empty for the menu to appear — the right-click
    // otherwise falls through to native (devtools / browser default).
    getXtermState().instances.at(-1)!.selection = "ls";

    const paneEl = container.querySelector(".pane") as HTMLElement;
    await fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });

    const menu = container.querySelector('[data-testid="pane-send-menu"]');
    expect(menu).not.toBeNull();
    const items = Array.from(menu!.querySelectorAll("button")).map((b) => b.textContent);
    expect(items).toEqual(["Pane 2", "Pane 3"]);
  });

  it("right-click with no selection does not open the menu", async () => {
    const { container } = await mountPane({
      sendTargets: [{ label: "Pane 2", onSelect: vi.fn() }],
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    // Default mock selection is empty.
    const paneEl = container.querySelector(".pane") as HTMLElement;
    await fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });
    expect(container.querySelector('[data-testid="pane-send-menu"]')).toBeNull();
  });

  it("clicking a Send-to entry invokes the target's callback", async () => {
    const sendToPane2 = vi.fn();
    const { container } = await mountPane({
      sendTargets: [{ label: "Pane 2", onSelect: sendToPane2 }],
    });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    getXtermState().instances.at(-1)!.selection = "ls -la";

    const paneEl = container.querySelector(".pane") as HTMLElement;
    await fireEvent.contextMenu(paneEl, { clientX: 10, clientY: 20 });

    const target = container.querySelector(
      '[data-testid="pane-send-menu"] button'
    ) as HTMLButtonElement;
    await fireEvent.click(target);
    expect(sendToPane2).toHaveBeenCalledTimes(1);
    // Menu dismisses after the pick so a second contextmenu still works.
    expect(container.querySelector('[data-testid="pane-send-menu"]')).toBeNull();
  });

  it("handle.getPtyId returns undefined after pty:exit", async () => {
    // Inter-pane send (PR-08 AppRoot.sendSelection) calls handle.getPtyId
    // at the moment of the send; a stale id would reach pty_send_text and
    // the bridge would reject it as "unknown pty id". Once the child has
    // exited the handle must surface "no live pty" so the caller no-ops.
    const onregister = vi.fn();
    const { container } = await mountPane({ onregister });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const handle = onregister.mock.calls.at(-1)?.[0];
    expect(handle?.getPtyId()).toBe("pane-1");

    emitTauriEvent("pty:exit", { paneId: "pane-1", code: 0, success: true });

    await vi.waitFor(() => {
      expect(container.querySelector(".status-exited")).not.toBeNull();
    });
    expect(handle?.getPtyId()).toBeUndefined();
  });

  it("registers a handle on mount and unregisters on unmount", async () => {
    const onregister = vi.fn();
    const { unmount } = await mountPane({ onregister });
    // Most recent registration call is the live handle.
    await vi.waitFor(() => {
      expect(onregister).toHaveBeenCalled();
    });
    const handle = onregister.mock.calls.at(-1)?.[0];
    expect(handle).toBeDefined();
    expect(handle.label).toBe("Pane A");
    expect(typeof handle.getPtyId).toBe("function");
    expect(typeof handle.getSelection).toBe("function");

    // The handle reads through to xterm's selection at call time.
    getXtermState().instances.at(-1)!.selection = "hello";
    expect(handle.getSelection()).toBe("hello");

    unmount();
    // Last call after unmount must clear the handle so the parent doesn't
    // hold a dangling reference.
    expect(onregister.mock.calls.at(-1)?.[0]).toBeUndefined();
  });

  it("focuses the terminal when mounted with focused=true", async () => {
    // The initial layout starts with one pane already selected; that pane
    // should not require a click to capture keystrokes.
    const { container } = await mountPane({ focused: true });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const focusFn = getXtermState().instances.at(-1)!.focus;
    expect(focusFn).toHaveBeenCalled();
  });
});
