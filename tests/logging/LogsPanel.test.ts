// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/svelte";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("../../src/lib/modal.css", () => ({}));
vi.mock("../../src/lib/logging/logs-panel.css", () => ({}));

import LogsPanel from "../../src/lib/logging/LogsPanel.svelte";

let tailCalls = 0;
let tailResponder: () => number[] = () => Array.from(new TextEncoder().encode("hello\n"));

function setup() {
  mockIPC((cmd) => {
    if (cmd === "log_tail") {
      tailCalls += 1;
      return tailResponder();
    }
    return undefined;
  });
}

beforeEach(() => {
  tailCalls = 0;
  tailResponder = () => Array.from(new TextEncoder().encode("hello world\n"));
  setup();
});

afterEach(() => {
  cleanup();
  clearMocks();
});

describe("LogsPanel", () => {
  it("does not render when closed", () => {
    const { container } = render(LogsPanel, {
      props: {
        open: false,
        onclose: vi.fn(),
        paneId: "pane-a",
        paneLabel: "Pane A",
      },
    });
    expect(container.querySelector('[data-testid="logs-panel"]')).toBeNull();
  });

  it("polls log_tail when opened and shows the decoded text", async () => {
    const { container } = render(LogsPanel, {
      props: {
        open: true,
        onclose: vi.fn(),
        paneId: "pane-a",
        paneLabel: "Pane A",
      },
    });

    await waitFor(() => {
      expect(tailCalls).toBeGreaterThan(0);
      const tail = container.querySelector('[data-testid="logs-panel-tail"]');
      expect(tail?.textContent).toContain("hello world");
    });
  });

  it("renders the empty state when log_tail returns nothing", async () => {
    tailResponder = () => [];
    const { container } = render(LogsPanel, {
      props: {
        open: true,
        onclose: vi.fn(),
        paneId: "pane-a",
        paneLabel: "Pane A",
      },
    });
    await waitFor(() => {
      expect(tailCalls).toBeGreaterThan(0);
      expect(container.querySelector('[data-testid="logs-panel-empty"]')).not.toBeNull();
    });
  });
});
