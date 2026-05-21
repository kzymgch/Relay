// @vitest-environment jsdom
//
// xterm.js v5's CoreBrowserService relies on browser-only APIs that jsdom
// does not provide. The wrapper contract is verified against stubs from
// `./_xterm-mocks`; real rendering is exercised via `pnpm tauri dev`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";

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

import Terminal from "../src/lib/Terminal.svelte";
import type { TerminalApi } from "../src/lib/terminal";
import { emitTerminalResize, getXtermState, resetXtermMocks } from "./_xterm-mocks";

beforeEach(() => {
  resetXtermMocks();
});

async function mount(extraProps: Record<string, unknown> = {}) {
  let api: TerminalApi | undefined;
  const result = render(Terminal, {
    props: {
      onready: (a: TerminalApi) => {
        api = a;
      },
      ...extraProps,
    },
  });
  await vi.waitFor(() => expect(api).toBeDefined());
  return { ...result, api: api as TerminalApi };
}

describe("Terminal component", () => {
  it("mounts xterm onto the container", async () => {
    const { container } = await mount();
    const term = getXtermState().instances.at(-1);
    expect(term).toBeDefined();
    expect(term!.open).toHaveBeenCalledTimes(1);
    const target = term!.open.mock.calls[0]?.[0] as HTMLElement;
    expect(target.classList.contains("terminal-container")).toBe(true);
    expect(container.querySelector(".xterm-mounted")).not.toBeNull();
  });

  it("loads fit / web-links / search / serialize addons", async () => {
    await mount();
    const term = getXtermState().instances.at(-1)!;
    expect(term.loadAddon).toHaveBeenCalledTimes(4);
    const addonNames = term.addons.map(
      (a) => (a as { constructor: { name: string } }).constructor.name
    );
    expect(addonNames).toEqual(
      expect.arrayContaining([
        "MockFitAddon",
        "MockWebLinksAddon",
        "MockSearchAddon",
        "MockSerializeAddon",
      ])
    );
  });

  it("write() forwards to xterm.write", async () => {
    const { api } = await mount();
    const term = getXtermState().instances.at(-1)!;
    api.write("hello world\r\n");
    expect(term.write).toHaveBeenCalledWith("hello world\r\n");
  });

  it("exposes the documented imperative API", async () => {
    const { api } = await mount();
    expect(typeof api.write).toBe("function");
    expect(typeof api.clear).toBe("function");
    expect(typeof api.focus).toBe("function");
    expect(typeof api.fit).toBe("function");
    expect(typeof api.paste).toBe("function");
    expect(typeof api.serialize).toBe("function");
    expect(typeof api.findNext).toBe("function");
    expect(typeof api.findPrevious).toBe("function");
    expect(typeof api.cols).toBe("number");
    expect(typeof api.rows).toBe("number");
  });

  it("ondata fires when paste is called", async () => {
    const dataHandler = vi.fn();
    const { api } = await mount({ ondata: dataHandler });
    api.paste("typed text");
    expect(dataHandler).toHaveBeenCalledWith("typed text");
  });

  it("onresize forwards new dimensions from xterm", async () => {
    const resizeHandler = vi.fn();
    await mount({ onresize: resizeHandler });
    emitTerminalResize(120, 40);
    expect(resizeHandler).toHaveBeenCalledWith(120, 40);
  });

  it("subscribes to onResize before the initial fit", async () => {
    await mount();
    const term = getXtermState().instances.at(-1)!;
    const fitAddon = term.addons.find(
      (a) => (a as { constructor: { name: string } }).constructor.name === "MockFitAddon"
    ) as { fit: ReturnType<typeof vi.fn> };

    const onResizeOrder = term.onResize.mock.invocationCallOrder[0];
    const fitOrder = fitAddon.fit.mock.invocationCallOrder[0];
    expect(onResizeOrder).toBeDefined();
    expect(fitOrder).toBeDefined();
    expect(onResizeOrder).toBeLessThan(fitOrder);
  });

  it("propagates reactive prop changes to xterm.options", async () => {
    let api: TerminalApi | undefined;
    const onready = (a: TerminalApi) => {
      api = a;
    };
    const { rerender } = render(Terminal, {
      props: {
        onready,
        fontSize: 14,
        fontFamily: "Menlo, monospace",
        cursorBlink: true,
        theme: { background: "#111" },
      },
    });
    await vi.waitFor(() => expect(api).toBeDefined());

    const term = getXtermState().instances.at(-1)!;
    expect(term.options.fontSize).toBe(14);
    expect(term.options.fontFamily).toBe("Menlo, monospace");
    expect(term.options.cursorBlink).toBe(true);
    expect(term.options.theme).toEqual({ background: "#111" });

    await rerender({
      onready,
      fontSize: 18,
      fontFamily: "Fira Code, monospace",
      cursorBlink: false,
      theme: { background: "#fff" },
    });

    expect(term.options.fontSize).toBe(18);
    expect(term.options.fontFamily).toBe("Fira Code, monospace");
    expect(term.options.cursorBlink).toBe(false);
    expect(term.options.theme).toEqual({ background: "#fff" });
  });

  it("propagates a scrollback change to xterm.options (reactive)", async () => {
    let api: TerminalApi | undefined;
    const onready = (a: TerminalApi) => {
      api = a;
    };
    const { rerender } = render(Terminal, {
      props: { onready, scrollback: 5000 },
    });
    await vi.waitFor(() => expect(api).toBeDefined());
    const term = getXtermState().instances.at(-1)!;
    expect(term.options.scrollback).toBe(5000);
    await rerender({ onready, scrollback: 20000 });
    expect(term.options.scrollback).toBe(20000);
  });

  it("unmount disposes the xterm instance", async () => {
    const { container, unmount } = await mount();
    const term = getXtermState().instances.at(-1)!;
    expect(container.querySelector(".xterm-mounted")).not.toBeNull();
    unmount();
    expect(term.dispose).toHaveBeenCalledTimes(1);
  });
});
