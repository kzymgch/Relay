// @vitest-environment jsdom
//
// xterm.js v5's CoreBrowserService relies on browser-only APIs that jsdom
// does not provide (matchMedia + DPR plumbing). Rather than spin up a real
// browser for component tests, we stub @xterm/xterm and the addons here:
// these tests verify the wrapper's contract with xterm (it constructs the
// Terminal, loads every addon, mounts the container, forwards data and
// resize events, and disposes on unmount) without taking on a Chromium
// runtime.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";

interface OnDataCallback {
  (data: string): void;
}

interface OnResizeCallback {
  (event: { cols: number; rows: number }): void;
}

const xtermMocks = vi.hoisted(() => {
  const state: {
    instances: MockTerminal[];
    dataHandlers: OnDataCallback[];
    resizeHandlers: OnResizeCallback[];
  } = { instances: [], dataHandlers: [], resizeHandlers: [] };

  class MockTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    addons: unknown[] = [];
    openedOn: HTMLElement | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      state.instances.push(this);
    }

    loadAddon = vi.fn((addon: unknown) => {
      this.addons.push(addon);
    });

    open = vi.fn((el: HTMLElement) => {
      this.openedOn = el;
      el.classList.add("xterm-mounted");
    });

    write = vi.fn();
    clear = vi.fn();
    focus = vi.fn();

    paste = vi.fn((data: string) => {
      // Real xterm fires onData when the user pastes. Mirror that here.
      for (const cb of state.dataHandlers) cb(data);
    });

    onData = vi.fn((cb: OnDataCallback) => {
      state.dataHandlers.push(cb);
      return {
        dispose: vi.fn(() => {
          const i = state.dataHandlers.indexOf(cb);
          if (i >= 0) state.dataHandlers.splice(i, 1);
        }),
      };
    });

    onResize = vi.fn((cb: OnResizeCallback) => {
      state.resizeHandlers.push(cb);
      return {
        dispose: vi.fn(() => {
          const i = state.resizeHandlers.indexOf(cb);
          if (i >= 0) state.resizeHandlers.splice(i, 1);
        }),
      };
    });

    dispose = vi.fn(() => {
      this.openedOn?.classList.remove("xterm-mounted");
    });
  }

  class MockFitAddon {
    fit = vi.fn();
  }
  class MockWebLinksAddon {}
  class MockSearchAddon {
    findNext = vi.fn(() => true);
    findPrevious = vi.fn(() => true);
  }
  class MockSerializeAddon {
    serialize = vi.fn(() => "serialized");
  }

  return {
    state,
    MockTerminal,
    MockFitAddon,
    MockWebLinksAddon,
    MockSearchAddon,
    MockSerializeAddon,
  };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMocks.MockTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMocks.MockFitAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: xtermMocks.MockWebLinksAddon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: xtermMocks.MockSearchAddon }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: xtermMocks.MockSerializeAddon }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../src/lib/terminal.css", () => ({}));

// ResizeObserver is not implemented in jsdom.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  xtermMocks.state.instances.length = 0;
  xtermMocks.state.dataHandlers.length = 0;
  xtermMocks.state.resizeHandlers.length = 0;
});

// vi.mock calls are hoisted to the top of the file, so the static import
// below resolves to the stubs.
import Terminal from "../src/lib/Terminal.svelte";
import type { TerminalApi } from "../src/lib/terminal";

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
    const term = xtermMocks.state.instances.at(-1);
    expect(term).toBeDefined();
    expect(term!.open).toHaveBeenCalledTimes(1);
    // The container element passed to xterm is our `terminal-container` div.
    const target = term!.open.mock.calls[0]?.[0] as HTMLElement;
    expect(target.classList.contains("terminal-container")).toBe(true);
    // Mock marker confirms the open happened.
    expect(container.querySelector(".xterm-mounted")).not.toBeNull();
  });

  it("loads fit / web-links / search / serialize addons", async () => {
    await mount();
    const term = xtermMocks.state.instances.at(-1)!;
    expect(term.loadAddon).toHaveBeenCalledTimes(4);
    const addonNames = term.addons.map((a) => a?.constructor?.name);
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
    const term = xtermMocks.state.instances.at(-1)!;
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
    // Simulate xterm telling us a new size after a fit.
    for (const cb of xtermMocks.state.resizeHandlers) {
      cb({ cols: 120, rows: 40 });
    }
    expect(resizeHandler).toHaveBeenCalledWith(120, 40);
  });

  it("subscribes to onResize before the initial fit", async () => {
    // If fit() runs first and triggers term.resize(), our onResize listener
    // hasn't been attached yet and the initial size is lost. We catch that
    // here by comparing the call ordinals from vi.fn's invocationCallOrder.
    await mount();
    const term = xtermMocks.state.instances.at(-1)!;
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
    // mount() doesn't accept theme/fontSize via the helper; call render
    // directly so we can also use rerender().
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

    const term = xtermMocks.state.instances.at(-1)!;
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

  it("unmount disposes the xterm instance", async () => {
    const { container, unmount } = await mount();
    const term = xtermMocks.state.instances.at(-1)!;
    expect(container.querySelector(".xterm-mounted")).not.toBeNull();
    unmount();
    expect(term.dispose).toHaveBeenCalledTimes(1);
  });
});
