// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  killPty,
  parsePtyData,
  resizePty,
  spawnPty,
  writePty,
  type PtySpawnConfig,
} from "../src/lib/pty";

interface CapturedCall {
  cmd: string;
  args: Record<string, unknown>;
}

let calls: CapturedCall[] = [];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  clearMocks();
});

function captureWith<T>(responder?: (cmd: string, args: Record<string, unknown>) => T) {
  mockIPC((cmd, args) => {
    const normalized = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: normalized });
    return responder?.(cmd, normalized);
  });
}

describe("pty bridge wrapper", () => {
  it("spawnPty forwards the config and returns the paneId", async () => {
    captureWith((cmd) => (cmd === "pty_spawn" ? "pane-42" : undefined));
    const config: PtySpawnConfig = {
      command: "/bin/echo",
      args: ["hi"],
      cols: 80,
      rows: 24,
    };
    const id = await spawnPty(config);
    expect(id).toBe("pane-42");
    expect(calls).toEqual([{ cmd: "pty_spawn", args: { config } }]);
  });

  it("writePty serializes Uint8Array as a number array", async () => {
    captureWith();
    await writePty("p1", new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([{ cmd: "pty_write", args: { id: "p1", data: [1, 2, 3] } }]);
  });

  it("resizePty forwards cols and rows", async () => {
    captureWith();
    await resizePty("p1", 120, 40);
    expect(calls).toEqual([{ cmd: "pty_resize", args: { id: "p1", cols: 120, rows: 40 } }]);
  });

  it("killPty calls pty_kill with the id", async () => {
    captureWith();
    await killPty("p1");
    expect(calls).toEqual([{ cmd: "pty_kill", args: { id: "p1" } }]);
  });
});

describe("pty event payload", () => {
  it("parsePtyData turns number[] into Uint8Array", () => {
    const parsed = parsePtyData({ paneId: "p1", data: [104, 105, 0xff] });
    expect(parsed.paneId).toBe("p1");
    expect(parsed.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(parsed.data)).toEqual([104, 105, 255]);
  });

  it("parsePtyData handles empty payloads", () => {
    const parsed = parsePtyData({ paneId: "p2", data: [] });
    expect(parsed.data.length).toBe(0);
  });
});
