// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SvelteMap } from "svelte/reactivity";

import {
  deleteSession,
  installAutosave,
  listSessions,
  loadSession,
  readAutosave,
  readAutosaveScrollback,
  saveSession,
  serializeSession,
  writeAutosave,
  writeAutosaveScrollback,
  type SessionData,
} from "../src/lib/sessions";
import type { LayoutSnapshot } from "../src/lib/layout/tree";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

let calls: Call[] = [];

function captureWith<T>(responder?: (cmd: string, args: Record<string, unknown>) => T) {
  mockIPC((cmd, args) => {
    const normalized = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: normalized });
    return responder?.(cmd, normalized);
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  clearMocks();
});

function fixtureLayout(): LayoutSnapshot {
  return {
    tree: { kind: "leaf", paneId: "a" },
    panes: { a: { id: "a", label: "Pane 1", command: "/bin/zsh" } },
    focusedPaneId: "a",
  };
}

describe("serializeSession", () => {
  it("captures the layout snapshot, send options, and reserved fields", () => {
    const layout = fixtureLayout();
    const custom = new SvelteMap<string, LayoutSnapshot>();
    custom.set("alt", fixtureLayout());
    const data = serializeSession(
      {
        tree: layout.tree,
        panes: layout.panes,
        focusedPaneId: layout.focusedPaneId,
        customLayouts: custom,
      },
      { bracketedPaste: true, trailingNewline: false },
      "morning"
    );
    expect(data.layout.tree).toEqual(layout.tree);
    expect(data.layout.panes).toEqual(layout.panes);
    expect(data.layout.focusedPaneId).toBe("a");
    expect(data.layout.customLayouts).toHaveProperty("alt");
    expect(data.sendOptions).toEqual({ bracketedPaste: true, trailingNewline: false });
    expect(data.rules).toEqual([]);
    expect(data.scrollbackKeys).toEqual([]);
    expect(data.name).toBe("morning");
  });
});

describe("session command wrappers", () => {
  function emptyData(): SessionData {
    return {
      layout: {
        tree: fixtureLayout().tree,
        panes: fixtureLayout().panes,
        focusedPaneId: "a",
        customLayouts: {},
      },
      sendOptions: null,
      rules: [],
      scrollbackKeys: [],
      savedAt: "",
      name: "",
    };
  }

  it("saveSession forwards name + data", async () => {
    captureWith();
    const data = emptyData();
    await saveSession("morning", data);
    expect(calls[0]).toEqual({ cmd: "session_save", args: { name: "morning", data } });
  });

  it("loadSession returns the payload (or null when bridge is silent)", async () => {
    captureWith(() => emptyData());
    const got = await loadSession("morning");
    expect(got).not.toBeNull();
    expect(got!.layout.focusedPaneId).toBe("a");

    clearMocks();
    captureWith(() => undefined);
    expect(await loadSession("missing")).toBeNull();
  });

  it("listSessions defaults to [] when the bridge is silent", async () => {
    captureWith(() => undefined);
    expect(await listSessions()).toEqual([]);
  });

  it("deleteSession forwards the name", async () => {
    captureWith();
    await deleteSession("morning");
    expect(calls[0]).toEqual({ cmd: "session_delete", args: { name: "morning" } });
  });

  it("writeAutosave / readAutosave round-trip via the bridge", async () => {
    let stored: SessionData | undefined;
    captureWith((cmd, args) => {
      if (cmd === "session_autosave_write") {
        stored = args.data as SessionData;
        return undefined;
      }
      if (cmd === "session_autosave_read") {
        return stored;
      }
      return undefined;
    });
    await writeAutosave(emptyData());
    expect(stored).toBeDefined();
    expect(await readAutosave()).toEqual(stored);
  });
});

describe("autosave scrollback wrappers", () => {
  it("writes per-pane bytes and maxBytes through the bridge", async () => {
    captureWith();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await writeAutosaveScrollback("pane-1", bytes, 1024);
    expect(calls[0]).toEqual({
      cmd: "session_autosave_scrollback_write",
      args: { paneId: "pane-1", bytes: [1, 2, 3, 4, 5], maxBytes: 1024 },
    });
  });

  it("decodes the returned byte array into a Uint8Array", async () => {
    captureWith((cmd) => {
      if (cmd === "session_autosave_scrollback_read") return [9, 8, 7];
      return undefined;
    });
    const back = await readAutosaveScrollback("pane-1");
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Array.from(back)).toEqual([9, 8, 7]);
  });
});

describe("installAutosave", () => {
  it("calls persistScrollback before snapshot and stamps the resulting keys", async () => {
    captureWith();
    const baseData: SessionData = {
      layout: {
        tree: fixtureLayout().tree,
        panes: fixtureLayout().panes,
        focusedPaneId: "a",
        customLayouts: {},
      },
      sendOptions: null,
      rules: [],
      scrollbackKeys: [],
      savedAt: "",
      name: "",
    };
    const order: string[] = [];
    const teardown = installAutosave({
      snapshot: () => {
        order.push("snapshot");
        return { ...baseData };
      },
      enabled: () => true,
      persistScrollback: async () => {
        order.push("persistScrollback");
        return ["pane-a", "pane-b"];
      },
    });
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(calls.find((c) => c.cmd === "session_autosave_write")).toBeDefined();
    });
    expect(order).toEqual(["persistScrollback", "snapshot"]);
    const write = calls.find((c) => c.cmd === "session_autosave_write")!;
    expect((write.args as { data: SessionData }).data.scrollbackKeys).toEqual(["pane-a", "pane-b"]);
    teardown();
  });

  it("writes on visibilitychange when enabled, skips when disabled", async () => {
    let enabled = true;
    let snapCalls = 0;
    const data: SessionData = {
      layout: {
        tree: fixtureLayout().tree,
        panes: fixtureLayout().panes,
        focusedPaneId: "a",
        customLayouts: {},
      },
      sendOptions: null,
      rules: [],
      scrollbackKeys: [],
      savedAt: "",
      name: "",
    };
    captureWith();

    const teardown = installAutosave({
      snapshot: () => {
        snapCalls += 1;
        return data;
      },
      enabled: () => enabled,
    });

    // Simulate the page being hidden (Cmd+Tab away).
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(calls.find((c) => c.cmd === "session_autosave_write")).toBeDefined();
    });
    expect(snapCalls).toBeGreaterThanOrEqual(1);
    expect(
      (calls.find((c) => c.cmd === "session_autosave_write")!.args as { data: SessionData }).data
    ).toEqual(data);

    // Disable autosave and re-fire — no new write should land.
    calls = [];
    enabled = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.find((c) => c.cmd === "session_autosave_write")).toBeUndefined();

    teardown();
  });
});
