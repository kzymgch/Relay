// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/svelte";

import SelectionChip from "../../src/lib/send/SelectionChip.svelte";

interface Disposable {
  dispose(): void;
}
interface FakeTerm {
  cols: number;
  rows: number;
  buffer: { active: { viewportY: number } };
  selection: string;
  selectionRange: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  getSelection(): string;
  getSelectionPosition():
    | { start: { x: number; y: number }; end: { x: number; y: number } }
    | undefined;
  onSelectionChange(handler: () => void): Disposable;
  onScroll(handler: () => void): Disposable;
  focus(): void;
  selectionHandlers: Array<() => void>;
}

function fakeTerm(initial: string, range?: FakeTerm["selectionRange"]): FakeTerm {
  return {
    cols: 80,
    rows: 24,
    buffer: { active: { viewportY: 0 } },
    selection: initial,
    selectionRange: range,
    selectionHandlers: [],
    getSelection() {
      return this.selection;
    },
    getSelectionPosition() {
      return this.selectionRange;
    },
    onSelectionChange(handler: () => void) {
      this.selectionHandlers.push(handler);
      return {
        dispose: () => {
          this.selectionHandlers = this.selectionHandlers.filter((h) => h !== handler);
        },
      };
    },
    onScroll() {
      return { dispose: () => undefined };
    },
    focus: vi.fn(),
  };
}

function fakeContainer(width = 800, height = 480): HTMLElement {
  const host = document.createElement("div");
  // jsdom defaults to 0x0 for getBoundingClientRect, which collapses the
  // chip positioner; override the function so coords are deterministic.
  host.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
  document.body.appendChild(host);
  return host;
}

describe("SelectionChip", () => {
  afterEach(cleanup);

  it("hidden when the selection is empty", () => {
    const term = fakeTerm("");
    const container = fakeContainer();
    const { getByTestId } = render(SelectionChip, {
      props: { term: term as never, container, paneId: "p1", sourceLabel: "Pane 1" },
    });
    expect(getByTestId("selection-chip").hasAttribute("hidden")).toBe(true);
  });

  it("visible when a non-empty selection range exists", async () => {
    const term = fakeTerm("hello", { start: { x: 1, y: 0 }, end: { x: 6, y: 0 } });
    const container = fakeContainer();
    const { getByTestId } = render(SelectionChip, {
      props: { term: term as never, container, paneId: "p1", sourceLabel: "Pane 1" },
    });
    const chip = getByTestId("selection-chip");
    expect(chip.hasAttribute("hidden")).toBe(false);
    expect(chip.textContent).toContain("5 chars");
  });

  it("populates DataTransfer on dragstart with text + relay payload", async () => {
    const term = fakeTerm("ls -lh", { start: { x: 1, y: 0 }, end: { x: 7, y: 0 } });
    const container = fakeContainer();
    const { getByTestId } = render(SelectionChip, {
      props: { term: term as never, container, paneId: "p1", sourceLabel: "Pane 1" },
    });
    const chip = getByTestId("selection-chip");

    // jsdom doesn't ship DataTransfer; stub the surface the handler touches.
    const store = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "" as DataTransfer["effectAllowed"],
      setData(type: string, value: string) {
        store.set(type, value);
      },
      getData(type: string) {
        return store.get(type) ?? "";
      },
      setDragImage() {
        /* no-op for the test */
      },
    } as unknown as DataTransfer;

    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    await fireEvent(chip, event);

    expect(dataTransfer.getData("text/plain")).toBe("ls -lh");
    const payload = JSON.parse(dataTransfer.getData("application/x-relay-send"));
    expect(payload).toEqual({ sourcePaneId: "p1", sourceLabel: "Pane 1" });
  });
});
