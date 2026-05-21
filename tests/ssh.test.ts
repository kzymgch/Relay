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
import { resetXtermMocks } from "./_xterm-mocks";
import { emitTauriEvent, resetTauriEventListeners } from "./_tauri-event-mock";
import { sshConfigHosts, sshKeychainHas, sshKeychainSet, sshReconnect } from "../src/lib/ssh";

interface InvocationLog {
  cmd: string;
  args: Record<string, unknown>;
}

let invocations: InvocationLog[] = [];
let nextPaneId = 1;

function installIpcMock(): void {
  mockIPC((cmd, args) => {
    const normalized = (args ?? {}) as Record<string, unknown>;
    invocations.push({ cmd, args: normalized });
    switch (cmd) {
      case "pty_spawn":
      case "pty_write":
      case "pty_resize":
      case "pty_kill":
      case "ssh_reconnect":
      case "ssh_keychain_set":
      case "ssh_keychain_delete":
        return undefined;
      case "ssh_keychain_has":
        // Pretend a password exists for the user the test asks about; the
        // assertion only cares about the IPC call shape.
        return true;
      case "ssh_config_hosts":
        return [{ alias: "devbox" }, { alias: "gpu01" }];
      default:
        return undefined;
    }
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
  globalThis.crypto.randomUUID = originalRandomUUID;
});

async function mountSshPane(extra: Record<string, unknown> = {}) {
  const result = render(Pane, {
    props: {
      label: "Devbox",
      ssh: { host: "devbox", user: "alice", autoReconnect: true, ...((extra.ssh as object) ?? {}) },
      ...extra,
    },
  });
  await vi.waitFor(() => {
    expect(invocations.find((i) => i.cmd === "pty_spawn")).toBeDefined();
  });
  return result;
}

describe("ssh.ts IPC wrappers", () => {
  it("ssh_reconnect invokes with the pane id", async () => {
    await sshReconnect("pane-42");
    const call = invocations.find((i) => i.cmd === "ssh_reconnect")!;
    expect(call.args).toEqual({ id: "pane-42" });
  });

  it("ssh_config_hosts returns the alias list", async () => {
    const hosts = await sshConfigHosts();
    expect(hosts.map((h) => h.alias)).toEqual(["devbox", "gpu01"]);
  });

  it("ssh_keychain_set passes user/host/password to the backend", async () => {
    await sshKeychainSet("alice", "devbox", "hunter2");
    const call = invocations.find((i) => i.cmd === "ssh_keychain_set")!;
    // Plaintext never leaves Rust after this — but on the *invoke* the
    // password is in the args record. We assert the shape rather than the
    // payload contents, which is what matters for the IPC contract.
    expect(call.args).toEqual({ user: "alice", host: "devbox", password: "hunter2" });
  });

  it("ssh_keychain_has returns whatever Rust says", async () => {
    const has = await sshKeychainHas("alice", "devbox");
    expect(has).toBe(true);
  });
});

describe("SSH Pane component", () => {
  it("routes SSH-flavored PaneSpec to pty_spawn with an `ssh` config field", async () => {
    await mountSshPane();
    const spawn = invocations.find((i) => i.cmd === "pty_spawn")!;
    const config = spawn.args.config as Record<string, unknown>;
    expect(config.ssh).toEqual({
      host: "devbox",
      user: "alice",
      autoReconnect: true,
    });
    // Local-pane fields should be absent so the backend doesn't accidentally
    // launch a local process alongside the SSH session.
    expect(config.command).toBeUndefined();
    expect(config.args).toBeUndefined();
  });

  it("flips status when ssh:status events arrive", async () => {
    const { container } = await mountSshPane();
    const status = () => container.querySelector('[data-testid="pane-status"]')?.textContent ?? "";

    // The supervisor emits Connecting before the actual connect, then
    // Connected once the russh session is up. The component should
    // surface both.
    emitTauriEvent("ssh:status", {
      paneId: "pane-1",
      status: "connecting",
      attempt: 0,
      message: null,
    });
    await vi.waitFor(() => {
      expect(status()).toContain("connecting");
    });
    emitTauriEvent("ssh:status", {
      paneId: "pane-1",
      status: "connected",
      attempt: 0,
      message: null,
    });
    await vi.waitFor(() => {
      expect(status()).toContain("connected");
    });
  });

  it("shows the Reconnect button only while disconnected/reconnecting", async () => {
    const { container } = await mountSshPane();
    const reconnectBtn = () => container.querySelector('[data-testid="pane-ssh-reconnect"]');

    // Initial spawn lands the pane in `connected` → `running`; no button.
    emitTauriEvent("ssh:status", {
      paneId: "pane-1",
      status: "connected",
      attempt: 0,
      message: null,
    });
    await vi.waitFor(() => {
      expect(reconnectBtn()).toBeNull();
    });

    emitTauriEvent("ssh:status", {
      paneId: "pane-1",
      status: "disconnected",
      attempt: 0,
      message: null,
    });
    await vi.waitFor(() => {
      expect(reconnectBtn()).not.toBeNull();
    });

    // Clicking it invokes ssh_reconnect with the live pane id.
    invocations = [];
    await fireEvent.click(reconnectBtn()!);
    await vi.waitFor(() => {
      const call = invocations.find((i) => i.cmd === "ssh_reconnect");
      expect(call).toBeDefined();
      expect((call!.args as Record<string, unknown>).id).toBe("pane-1");
    });
  });

  it("surfaces the reconnect attempt number while reconnecting", async () => {
    const { container } = await mountSshPane();
    emitTauriEvent("ssh:status", {
      paneId: "pane-1",
      status: "reconnecting",
      attempt: 3,
      message: null,
    });
    await vi.waitFor(() => {
      const text = container.querySelector('[data-testid="pane-status"]')?.textContent ?? "";
      // The exact phrasing must include the attempt number so the user
      // can see backoff progress; assert the digits are present rather
      // than over-pinning the surrounding copy.
      expect(text).toContain("3");
      expect(text).toContain("reconnecting");
    });
  });
});
