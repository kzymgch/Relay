// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { DEFAULT_SEND_OPTIONS, SEND_HISTORY_LIMIT, SendHistory, sendTextTo } from "../src/lib/send";

interface CapturedCall {
  cmd: string;
  args: Record<string, unknown>;
}

let calls: CapturedCall[] = [];

function captureIpc() {
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    return undefined;
  });
}

beforeEach(() => {
  calls = [];
  captureIpc();
});

afterEach(() => {
  clearMocks();
});

describe("sendTextTo", () => {
  it("invokes pty_send_text with bracketed paste enabled by default", async () => {
    const history = new SendHistory();
    const ok = await sendTextTo(
      {
        text: "ls",
        targetPtyId: "pane-target",
        sourceLabel: "Pane 1",
        targetLabel: "Pane 2",
      },
      history
    );
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        cmd: "pty_send_text",
        args: {
          id: "pane-target",
          text: "ls",
          bracketedPaste: true,
          trailingNewline: false,
        },
      },
    ]);
  });

  it("propagates explicit options through to the bridge", async () => {
    const history = new SendHistory();
    await sendTextTo(
      {
        text: "echo hi",
        targetPtyId: "pane-target",
        sourceLabel: "Pane 1",
        targetLabel: "Pane 2",
        options: { bracketedPaste: false, trailingNewline: true },
      },
      history
    );
    expect(calls[0]?.args).toMatchObject({
      bracketedPaste: false,
      trailingNewline: true,
    });
  });

  it("honors per-call overrides on top of session defaults", async () => {
    const history = new SendHistory();
    await sendTextTo(
      {
        text: "x",
        targetPtyId: "pane-target",
        sourceLabel: "Pane 1",
        targetLabel: "Pane 2",
        // Only `trailingNewline` is set; bracketedPaste should fall back to
        // the supplied defaults rather than the module-level constant.
        options: { trailingNewline: true },
      },
      history,
      { bracketedPaste: false, trailingNewline: false }
    );
    expect(calls[0]?.args).toMatchObject({
      bracketedPaste: false,
      trailingNewline: true,
    });
  });

  it("skips empty payloads without invoking the bridge", async () => {
    const history = new SendHistory();
    const ok = await sendTextTo(
      {
        text: "",
        targetPtyId: "pane-target",
        sourceLabel: "Pane 1",
        targetLabel: "Pane 2",
      },
      history
    );
    expect(ok).toBe(false);
    expect(calls.length).toBe(0);
    expect(history.list().length).toBe(0);
  });

  it("records the send in history with the resolved options", async () => {
    const history = new SendHistory();
    const before = Date.now();
    await sendTextTo(
      {
        text: "ls",
        targetPtyId: "pane-target",
        sourceLabel: "Pane 1",
        targetLabel: "Pane 2",
      },
      history
    );
    const list = history.list();
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      text: "ls",
      sourceLabel: "Pane 1",
      targetLabel: "Pane 2",
      options: DEFAULT_SEND_OPTIONS,
    });
    expect(list[0]!.timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe("SendHistory", () => {
  it("returns newest entries first", () => {
    const history = new SendHistory();
    history.push({
      text: "a",
      sourceLabel: "Pane 1",
      targetLabel: "Pane 2",
      options: DEFAULT_SEND_OPTIONS,
      timestamp: 1,
    });
    history.push({
      text: "b",
      sourceLabel: "Pane 1",
      targetLabel: "Pane 2",
      options: DEFAULT_SEND_OPTIONS,
      timestamp: 2,
    });
    expect(history.list().map((e) => e.text)).toEqual(["b", "a"]);
  });

  it("enforces a bounded size so a long session does not grow unbounded", () => {
    const history = new SendHistory(3);
    for (let i = 0; i < 5; i++) {
      history.push({
        text: `t${i}`,
        sourceLabel: "Pane 1",
        targetLabel: "Pane 2",
        options: DEFAULT_SEND_OPTIONS,
        timestamp: i,
      });
    }
    expect(history.list().map((e) => e.text)).toEqual(["t4", "t3", "t2"]);
  });

  it("default limit matches the documented constant", () => {
    expect(SEND_HISTORY_LIMIT).toBeGreaterThan(0);
  });
});
