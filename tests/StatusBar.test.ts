// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/svelte";

vi.mock("../src/lib/status-bar.css", () => ({}));

import StatusBar from "../src/lib/StatusBar.svelte";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("StatusBar", () => {
  it("renders the focused pane label", () => {
    const { container } = render(StatusBar, {
      props: {
        focusedLabel: "Pane 1",
        sendTargetLabel: null,
        activeRuleCount: 0,
        sessionName: "",
      },
    });
    const focused = container.querySelector('[data-testid="status-bar-focused"]');
    expect(focused?.textContent).toContain("Pane 1");
  });

  it("omits the send-target chip when no target has been recorded", () => {
    const { container } = render(StatusBar, {
      props: {
        focusedLabel: "Pane 1",
        sendTargetLabel: null,
        activeRuleCount: 0,
        sessionName: "",
      },
    });
    expect(container.querySelector('[data-testid="status-bar-send-target"]')).toBeNull();
  });

  it("shows the send-target chip when a target label is provided", () => {
    const { container } = render(StatusBar, {
      props: {
        focusedLabel: "Pane 1",
        sendTargetLabel: "Pane 2",
        activeRuleCount: 0,
        sessionName: "",
      },
    });
    const chip = container.querySelector('[data-testid="status-bar-send-target"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Pane 2");
  });

  it("renders the active rule count and session name", () => {
    const { container } = render(StatusBar, {
      props: {
        focusedLabel: "Pane 1",
        sendTargetLabel: null,
        activeRuleCount: 3,
        sessionName: "morning",
      },
    });
    expect(container.querySelector('[data-testid="status-bar-rules"]')?.textContent).toContain("3");
    expect(container.querySelector('[data-testid="status-bar-session"]')?.textContent).toContain(
      "morning"
    );
  });

  it("falls back to '(unsaved)' when no session name is set", () => {
    const { container } = render(StatusBar, {
      props: {
        focusedLabel: "Pane 1",
        sendTargetLabel: null,
        activeRuleCount: 0,
        sessionName: "",
      },
    });
    expect(container.querySelector('[data-testid="status-bar-session"]')?.textContent).toContain(
      "(unsaved)"
    );
  });
});
