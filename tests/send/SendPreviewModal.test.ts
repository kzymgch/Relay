// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";

import SendPreviewModal from "../../src/lib/send/SendPreviewModal.svelte";
import { DEFAULT_SEND_OPTIONS } from "../../src/lib/send";

describe("SendPreviewModal", () => {
  afterEach(cleanup);

  it("renders source / target labels and the payload text", () => {
    const { getByTestId } = render(SendPreviewModal, {
      props: {
        open: true,
        sourceLabel: "shell-1",
        targetLabel: "claude",
        text: "echo hello",
        defaults: DEFAULT_SEND_OPTIONS,
        onconfirm: vi.fn(),
        oncancel: vi.fn(),
      },
    });
    expect(getByTestId("send-preview-source").textContent).toContain("shell-1");
    expect(getByTestId("send-preview-target").textContent).toContain("claude");
    expect(getByTestId("send-preview-text").textContent).toBe("echo hello");
  });

  it("confirm resolves with the toggled options", async () => {
    const onconfirm = vi.fn();
    const { getByTestId } = render(SendPreviewModal, {
      props: {
        open: true,
        sourceLabel: "src",
        targetLabel: "dst",
        text: "ls\n",
        defaults: { bracketedPaste: true, trailingNewline: false },
        onconfirm,
        oncancel: vi.fn(),
      },
    });
    await fireEvent.click(getByTestId("send-preview-trailing"));
    await fireEvent.click(getByTestId("send-preview-send"));
    expect(onconfirm).toHaveBeenCalledWith({
      bracketedPaste: true,
      trailingNewline: true,
    });
  });

  it("cancel calls oncancel without invoking onconfirm", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    const { getByTestId } = render(SendPreviewModal, {
      props: {
        open: true,
        sourceLabel: "src",
        targetLabel: "dst",
        text: "ls",
        defaults: DEFAULT_SEND_OPTIONS,
        onconfirm,
        oncancel,
      },
    });
    await fireEvent.click(getByTestId("send-preview-cancel"));
    expect(oncancel).toHaveBeenCalledTimes(1);
    expect(onconfirm).not.toHaveBeenCalled();
  });
});
