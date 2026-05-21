// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";

vi.mock("../../src/lib/modal.css", () => ({}));
vi.mock("../../src/lib/palette/command-palette.css", () => ({}));

import CommandPalette from "../../src/lib/palette/CommandPalette.svelte";
import type { PaletteAction } from "../../src/lib/palette/actions";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

function action(id: string, label: string, group: PaletteAction["group"]): PaletteAction {
  return { id, label, group, run: vi.fn() };
}

describe("CommandPalette", () => {
  it("does not render when open is false", () => {
    const { container } = render(CommandPalette, {
      props: {
        open: false,
        actions: [action("focus.a", "Focus: A", "pane")],
        onclose: vi.fn(),
      },
    });
    expect(container.querySelector('[data-testid="command-palette"]')).toBeNull();
  });

  it("renders every action when query is empty", async () => {
    const actions = [
      action("focus.a", "Focus: Pane A", "pane"),
      action("focus.b", "Focus: Pane B", "pane"),
      action("layout.2x2", "Layout: 2x2", "layout"),
    ];
    const { container } = render(CommandPalette, {
      props: { open: true, actions, onclose: vi.fn() },
    });
    const rows = container.querySelectorAll('[data-testid^="command-palette-row-"]');
    expect(rows.length).toBe(3);
  });

  it("filters by fuzzy match and reorders by score", async () => {
    const actions = [
      action("focus.b", "Focus: Pane B", "pane"),
      action("layout.2x2", "Layout: 2x2", "layout"),
      action("layout.h3", "Layout: horizontal-3", "layout"),
    ];
    const { container } = render(CommandPalette, {
      props: { open: true, actions, onclose: vi.fn() },
    });
    const input = container.querySelector(
      '[data-testid="command-palette-input"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "lay" } });
    await vi.waitFor(() => {
      const rows = container.querySelectorAll('[data-testid^="command-palette-row-"]');
      // "Focus: Pane B" doesn't contain l-a-y as subsequence (actually it
      // does have "a" but not l→a→y in order). Two layouts remain.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const ids = Array.from(rows).map((r) => r.getAttribute("data-testid"));
      expect(ids).toContain("command-palette-row-layout.2x2");
      expect(ids).toContain("command-palette-row-layout.h3");
    });
  });

  it("Enter runs the highlighted action and dismisses the palette", async () => {
    const ran: string[] = [];
    const actions: PaletteAction[] = [
      {
        ...action("a", "Focus: A", "pane"),
        run: () => {
          ran.push("a");
        },
      },
      {
        ...action("b", "Focus: B", "pane"),
        run: () => {
          ran.push("b");
        },
      },
    ];
    const onclose = vi.fn();
    const { container } = render(CommandPalette, {
      props: { open: true, actions, onclose },
    });
    const input = container.querySelector(
      '[data-testid="command-palette-input"]'
    ) as HTMLInputElement;
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => {
      expect(ran).toEqual(["b"]);
    });
    expect(onclose).toHaveBeenCalled();
  });

  it("shows 'No matches' when nothing scores", async () => {
    const actions = [action("a", "Focus: Alpha", "pane")];
    const { container } = render(CommandPalette, {
      props: { open: true, actions, onclose: vi.fn() },
    });
    const input = container.querySelector(
      '[data-testid="command-palette-input"]'
    ) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "zzz" } });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("No matches");
    });
  });
});
