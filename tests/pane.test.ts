// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { emitTauriEvent, resetTauriEventListeners } from "./_tauri-event-mock";

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
        return `pane-${nextPaneId++}`;
      case "pty_write":
      case "pty_resize":
      case "pty_kill":
        return undefined;
      default:
        return undefined;
    }
  });
}

beforeEach(() => {
  invocations = [];
  nextPaneId = 1;
  spawnError = undefined;
  resetXtermMocks();
  resetTauriEventListeners();
  clearMocks();
  installIpcMock();
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
});
