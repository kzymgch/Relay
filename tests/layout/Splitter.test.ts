// @vitest-environment jsdom
//
// Pointer-driven behaviour test for `Splitter.svelte`. We verify that:
//   1. pointerdown begins a drag
//   2. each subsequent pointermove emits the incremental delta along the
//      configured split axis (row → x, column → y)
//   3. pointerup ends the drag and fires `ondragend`
//
// jsdom's PointerEvent constructor doesn't propagate clientX/clientY from
// the init dict consistently across versions, so we build a generic Event
// of the right type and patch the fields with `Object.assign`. Svelte 5
// dispatches purely by event-type string, so this works for `onpointerdown`
// / `onpointermove` / `onpointerup`. `setPointerCapture` is also unimplemented
// in jsdom; Splitter's try/catch absorbs the failure.

import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";

vi.mock("../../src/lib/layout/splitter.css", () => ({}));

import Splitter from "../../src/lib/layout/Splitter.svelte";

function pointer(el: HTMLElement, type: string, init: Record<string, unknown>) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, init);
  el.dispatchEvent(ev);
}

afterEach(() => cleanup());

interface DragLog {
  delta: number;
}

function mountRowSplitter(extra: Record<string, unknown> = {}) {
  const log: DragLog[] = [];
  const endLog: number[] = [];
  const result = render(Splitter, {
    props: {
      direction: "row",
      x: 100,
      y: 0,
      length: 200,
      ondrag: (delta: number) => log.push({ delta }),
      ondragend: () => endLog.push(1),
      ...extra,
    },
  });
  const el = result.container.querySelector('[data-testid="splitter"]') as HTMLElement;
  return { log, endLog, el };
}

describe("Splitter — pointer events", () => {
  it("renders a row separator with the configured direction and dimensions", () => {
    const { el } = mountRowSplitter();
    expect(el.getAttribute("data-direction")).toBe("row");
    expect(el.getAttribute("role")).toBe("separator");
    expect(el.getAttribute("aria-orientation")).toBe("vertical");
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("0px");
    expect(el.style.height).toBe("200px");
  });

  it("emits incremental x deltas during a row-direction drag", async () => {
    const { log, el } = mountRowSplitter();
    pointer(el, "pointerdown", { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
    pointer(el, "pointermove", { clientX: 110, clientY: 50, pointerId: 1 });
    pointer(el, "pointermove", { clientX: 125, clientY: 50, pointerId: 1 });
    pointer(el, "pointermove", { clientX: 120, clientY: 50, pointerId: 1 });
    expect(log.map((l) => l.delta)).toEqual([10, 15, -5]);
  });

  it("ignores moves outside an active drag", () => {
    const { log, el } = mountRowSplitter();
    // No pointerdown — moves alone shouldn't emit.
    pointer(el, "pointermove", { clientX: 50, clientY: 50, pointerId: 1 });
    expect(log).toEqual([]);
  });

  it("fires ondragend on pointerup once", () => {
    const { endLog, el } = mountRowSplitter();
    pointer(el, "pointerdown", { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
    pointer(el, "pointerup", { clientX: 100, clientY: 50, pointerId: 1 });
    expect(endLog).toEqual([1]);
    // A second pointerup without a fresh drag is a no-op.
    pointer(el, "pointerup", { clientX: 100, clientY: 50, pointerId: 1 });
    expect(endLog).toEqual([1]);
  });

  it("emits y deltas for a column-direction splitter", () => {
    const log: DragLog[] = [];
    const result = render(Splitter, {
      props: {
        direction: "column",
        x: 0,
        y: 200,
        length: 400,
        ondrag: (delta: number) => log.push({ delta }),
      },
    });
    const el = result.container.querySelector('[data-testid="splitter"]') as HTMLElement;
    expect(el.style.width).toBe("400px");

    pointer(el, "pointerdown", { clientX: 0, clientY: 200, button: 0, pointerId: 1 });
    pointer(el, "pointermove", { clientX: 50, clientY: 215, pointerId: 1 }); // dy=15
    pointer(el, "pointermove", { clientX: 50, clientY: 205, pointerId: 1 }); // dy=-10
    expect(log.map((l) => l.delta)).toEqual([15, -10]);
  });

  it("ignores non-primary mouse buttons (so middle/right click don't start a drag)", () => {
    const { log, el } = mountRowSplitter();
    pointer(el, "pointerdown", { clientX: 100, clientY: 50, button: 2, pointerId: 1 });
    pointer(el, "pointermove", { clientX: 200, clientY: 50, pointerId: 1 });
    expect(log).toEqual([]);
  });

  it("toggles a 'dragging' class while a drag is in progress", async () => {
    const { el } = mountRowSplitter();
    expect(el.classList.contains("dragging")).toBe(false);
    pointer(el, "pointerdown", { clientX: 100, clientY: 50, button: 0, pointerId: 1 });
    await tick(); // let Svelte flush the $state → DOM update
    expect(el.classList.contains("dragging")).toBe(true);
    pointer(el, "pointerup", { clientX: 100, clientY: 50, pointerId: 1 });
    await tick();
    expect(el.classList.contains("dragging")).toBe(false);
  });
});
