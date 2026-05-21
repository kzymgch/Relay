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
import { emitTerminalResize, getXtermState, resetXtermMocks } from "./_xterm-mocks";
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

  it("handle.clear() proxies to the terminal's clear", async () => {
    const onregister = vi.fn();
    const { container } = await mountPane({ onregister });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const handle = onregister.mock.calls.at(-1)?.[0];
    const term = getXtermState().instances.at(-1)!;
    term.clear.mockClear();
    handle.clear();
    expect(term.clear).toHaveBeenCalledTimes(1);
  });

  it("handle.restart() kills then respawns the PTY", async () => {
    const onregister = vi.fn();
    const { container } = await mountPane({ onregister });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    invocations = [];
    const handle = onregister.mock.calls.at(-1)?.[0];

    handle.restart();

    await vi.waitFor(() => {
      expect(invocations.find((i) => i.cmd === "pty_kill")).toBeDefined();
      expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
    });
    const killIdx = invocations.findIndex((i) => i.cmd === "pty_kill");
    const spawnIdx = invocations.findIndex((i) => i.cmd === "pty_spawn");
    expect(killIdx).toBeLessThan(spawnIdx);
  });

  it("handle.openSearch() shows the search bar and Esc closes it", async () => {
    const onregister = vi.fn();
    const { container } = await mountPane({ onregister });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const handle = onregister.mock.calls.at(-1)?.[0];

    handle.openSearch();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="pane-search"]')).not.toBeNull();
    });

    const input = container.querySelector('[data-testid="pane-search"] input') as HTMLInputElement;
    expect(input).toBeDefined();
    await fireEvent.keyDown(input, { key: "Escape" });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="pane-search"]')).toBeNull();
    });
  });

  it("Enter in the search bar invokes findNext with the typed query", async () => {
    const onregister = vi.fn();
    const { container } = await mountPane({ onregister });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const handle = onregister.mock.calls.at(-1)?.[0];
    handle.openSearch();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="pane-search"]')).not.toBeNull();
    });

    const input = container.querySelector('[data-testid="pane-search"] input') as HTMLInputElement;
    // The search bar is bound to its own state via `bind:value`. Setting the
    // value plus an input event is what testing-library uses to drive the
    // binding.
    input.value = "needle";
    await fireEvent.input(input);

    const term = getXtermState().instances.at(-1)!;
    const search = term.addons.find(
      (a) => (a as { constructor: { name: string } }).constructor.name === "MockSearchAddon"
    ) as { findNext: ReturnType<typeof vi.fn>; findPrevious: ReturnType<typeof vi.fn> };
    search.findNext.mockClear();

    await fireEvent.keyDown(input, { key: "Enter" });
    expect(search.findNext).toHaveBeenCalledWith("needle");

    await fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(search.findPrevious).toHaveBeenCalledWith("needle");
  });

  it("fontSize prop propagates to xterm.options", async () => {
    const { container } = await mountPane({ fontSize: 18 });
    await vi.waitFor(() => {
      expect(container.querySelector(".status-running")).not.toBeNull();
    });
    const term = getXtermState().instances.at(-1)!;
    expect(term.options.fontSize).toBe(18);
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

  it("opens the settings popover and emits a patch on Save", async () => {
    const onupdatemeta = vi.fn();
    const { container } = await mountPane({
      label: "Editor",
      command: "/bin/zsh",
      args: ["-l"],
      onupdatemeta,
    });
    // Popover starts closed.
    expect(container.querySelector('[data-testid="pane-settings"]')).toBeNull();
    const gear = container.querySelector('button[aria-label="Pane settings"]') as HTMLButtonElement;
    await fireEvent.click(gear);
    const popover = container.querySelector('[data-testid="pane-settings"]');
    expect(popover).not.toBeNull();

    // Fields prefill with the current spec.
    const labelInput = container.querySelector(
      '[data-testid="pane-settings-label"]'
    ) as HTMLInputElement;
    expect(labelInput.value).toBe("Editor");

    const cmdInput = container.querySelector(
      '[data-testid="pane-settings-command"]'
    ) as HTMLInputElement;
    await fireEvent.input(labelInput, { target: { value: "Logs" } });
    await fireEvent.input(cmdInput, { target: { value: "/usr/bin/tail" } });
    const argsInput = container.querySelector(
      '[data-testid="pane-settings-args"]'
    ) as HTMLTextAreaElement;
    // One arg per line — see the comment in Pane.svelte::openSettings; this
    // shape lets users pass arguments that contain spaces (e.g. `-c "echo hi"`)
    // without inventing a quoting syntax.
    await fireEvent.input(argsInput, { target: { value: "-f\n/var/log/syslog" } });
    const envInput = container.querySelector(
      '[data-testid="pane-settings-env"]'
    ) as HTMLTextAreaElement;
    await fireEvent.input(envInput, { target: { value: "FOO=bar\nBAZ=qux" } });

    const save = container.querySelector('[data-testid="pane-settings-save"]') as HTMLButtonElement;
    await fireEvent.click(save);

    expect(onupdatemeta).toHaveBeenCalledTimes(1);
    const patch = onupdatemeta.mock.calls[0]![0];
    expect(patch.label).toBe("Logs");
    expect(patch.command).toBe("/usr/bin/tail");
    expect(patch.args).toEqual(["-f", "/var/log/syslog"]);
    expect(patch.env).toEqual({ FOO: "bar", BAZ: "qux" });
    // Popover dismissed after save.
    expect(container.querySelector('[data-testid="pane-settings"]')).toBeNull();
  });

  it("preserves args that contain spaces through a settings round-trip", async () => {
    // Regression: a single-line `args.join(" ")` form would shred
    // ["-c", "echo hello world"] into ["-c", "echo", "hello", "world"].
    // The textarea/per-line shape keeps the original arg intact.
    const onupdatemeta = vi.fn();
    const { container } = await mountPane({
      command: "/bin/zsh",
      args: ["-c", "echo hello world"],
      onupdatemeta,
    });
    const gear = container.querySelector('button[aria-label="Pane settings"]') as HTMLButtonElement;
    await fireEvent.click(gear);
    const argsInput = container.querySelector(
      '[data-testid="pane-settings-args"]'
    ) as HTMLTextAreaElement;
    // Prefill matches the original args, one per line.
    expect(argsInput.value).toBe("-c\necho hello world");
    // Save without edits should round-trip identically.
    const save = container.querySelector('[data-testid="pane-settings-save"]') as HTMLButtonElement;
    await fireEvent.click(save);
    expect(onupdatemeta).toHaveBeenCalledTimes(1);
    expect(onupdatemeta.mock.calls[0]![0].args).toEqual(["-c", "echo hello world"]);
  });

  it("settings popover shows direction-aware Move buttons and fires onreorder", async () => {
    const onreorder = vi.fn();
    // Pane sits inside a `row` parent (sibling 1 of 3) → buttons are
    // "Move ←" (enabled because canPrev) and "Move →" (enabled because canNext).
    const { container } = await mountPane({
      onreorder,
      reorderHint: { direction: "row", canPrev: true, canNext: true },
    });
    const gear = container.querySelector('button[aria-label="Pane settings"]') as HTMLButtonElement;
    await fireEvent.click(gear);

    const prev = container.querySelector(
      '[data-testid="pane-settings-move-prev"]'
    ) as HTMLButtonElement;
    const next = container.querySelector(
      '[data-testid="pane-settings-move-next"]'
    ) as HTMLButtonElement;
    expect(prev.textContent?.trim()).toBe("Move ←");
    expect(next.textContent?.trim()).toBe("Move →");
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);

    await fireEvent.click(next);
    expect(onreorder).toHaveBeenCalledWith(1);
  });

  it("Move buttons disable at the start / end of the sibling list", async () => {
    const { container } = await mountPane({
      onreorder: vi.fn(),
      // First sibling (canPrev=false), last too (canNext=false) → 1 of 1.
      reorderHint: { direction: "column", canPrev: false, canNext: false },
    });
    await fireEvent.click(
      container.querySelector('button[aria-label="Pane settings"]') as HTMLButtonElement
    );
    const prev = container.querySelector(
      '[data-testid="pane-settings-move-prev"]'
    ) as HTMLButtonElement;
    const next = container.querySelector(
      '[data-testid="pane-settings-move-next"]'
    ) as HTMLButtonElement;
    // Column direction → up/down glyphs.
    expect(prev.textContent?.trim()).toBe("Move ↑");
    expect(next.textContent?.trim()).toBe("Move ↓");
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });

  it("Move buttons are hidden when the pane has no parent split", async () => {
    const { container } = await mountPane({
      // No reorderHint → no Move buttons.
    });
    await fireEvent.click(
      container.querySelector('button[aria-label="Pane settings"]') as HTMLButtonElement
    );
    expect(container.querySelector('[data-testid="pane-settings-move-prev"]')).toBeNull();
    expect(container.querySelector('[data-testid="pane-settings-move-next"]')).toBeNull();
  });

  it("settings 'Split right' fires onsplit and closes the popover", async () => {
    const onsplit = vi.fn();
    const { container } = await mountPane({ onsplit });
    const gear = container.querySelector('button[aria-label="Pane settings"]') as HTMLButtonElement;
    await fireEvent.click(gear);
    const splitRight = container.querySelector(
      '[data-testid="pane-settings-split-right"]'
    ) as HTMLButtonElement;
    await fireEvent.click(splitRight);
    expect(onsplit).toHaveBeenCalledWith("row", "after");
    expect(container.querySelector('[data-testid="pane-settings"]')).toBeNull();
  });

  it("close button is enabled only when onclose is provided", async () => {
    // No onclose → disabled (single-pane / last-pane case AppRoot models).
    const { container: noClose } = await mountPane({});
    const closeBtnDisabled = noClose.querySelector(
      'button[aria-label="Close pane"]'
    ) as HTMLButtonElement;
    expect(closeBtnDisabled.disabled).toBe(true);

    // With onclose → enabled and fires the callback.
    const onclose = vi.fn();
    const { container } = await mountPane({ onclose });
    const closeBtn = container.querySelector(
      'button[aria-label="Close pane"]'
    ) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(false);
    await fireEvent.click(closeBtn);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("debounces pty_resize while a drag streams xterm resize events", async () => {
    // PR-11: splitter dragging causes FitAddon → xterm.onResize to fire many
    // times in quick succession. The Pane must coalesce these into a single
    // trailing-edge pty_resize IPC so shells (vim/htop) don't flicker on
    // every frame. We drive the xterm `onResize` callback directly via the
    // mock and assert the IPC fires exactly once with the *last* size.
    vi.useFakeTimers();
    try {
      const { container } = await mountPane();
      await vi.waitFor(() => {
        expect(container.querySelector(".status-running")).not.toBeNull();
      });
      invocations = invocations.filter((i) => i.cmd !== "pty_resize");

      emitTerminalResize(81, 25);
      emitTerminalResize(82, 26);
      emitTerminalResize(90, 30);
      // Within the debounce window no IPC has fired yet.
      expect(invocations.find((i) => i.cmd === "pty_resize")).toBeUndefined();

      vi.advanceTimersByTime(60);
      const resizes = invocations.filter((i) => i.cmd === "pty_resize");
      expect(resizes).toHaveLength(1);
      expect(resizes[0]!.args).toMatchObject({ id: "pane-1", cols: 90, rows: 30 });
    } finally {
      vi.useRealTimers();
    }
  });
});
