// Pure unit tests for the shared URL extractor used by Cmd+Enter.
// Lives next to the other small-utility tests because the rules need to
// match exactly in two callsites (buffer scan + selection-priority path).

import { describe, expect, it } from "vitest";

import { extractLastUrl, trimUrlTail } from "../src/lib/urls";

describe("urls/trimUrlTail", () => {
  it("strips trailing sentence punctuation", () => {
    expect(trimUrlTail("https://example.com.")).toBe("https://example.com");
    expect(trimUrlTail("https://example.com,")).toBe("https://example.com");
    expect(trimUrlTail("https://example.com;")).toBe("https://example.com");
    expect(trimUrlTail("https://example.com!")).toBe("https://example.com");
  });

  it("does NOT strip a trailing `?` — query indicator / presigned URL tail", () => {
    // `?` can legitimately end a URL: an empty-query indicator
    // (`https://example.com/search?`) or the tail of an OAuth / presigned
    // URL the user happened to select mid-stream. Treating it as sentence
    // punctuation would silently corrupt the link.
    expect(trimUrlTail("https://example.com/search?")).toBe("https://example.com/search?");
  });

  it("strips multiple punctuation chars layered together, but stops at `?`", () => {
    // `,.` are stripped, then `?` is reached and preserved.
    expect(trimUrlTail("https://example.com/?,.")).toBe("https://example.com/?");
  });

  it("does NOT strip a colon — URL ports / IPv6 hosts must round-trip", () => {
    expect(trimUrlTail("http://localhost:")).toBe("http://localhost:");
  });

  it("preserves a balanced trailing paren (Wikipedia URL)", () => {
    expect(trimUrlTail("https://en.wikipedia.org/wiki/Function_(mathematics)")).toBe(
      "https://en.wikipedia.org/wiki/Function_(mathematics)"
    );
  });

  it("strips an unbalanced trailing paren (sentence wrapper)", () => {
    expect(trimUrlTail("https://example.com/path)")).toBe("https://example.com/path");
  });

  it("preserves a balanced trailing bracket (IPv6 host)", () => {
    expect(trimUrlTail("http://[::1]:8080/admin")).toBe("http://[::1]:8080/admin");
    // Trailing `]` is balanced by `[` in the host.
    expect(trimUrlTail("http://[::1]")).toBe("http://[::1]");
  });

  it("strips an unbalanced trailing bracket", () => {
    expect(trimUrlTail("https://example.com/path]")).toBe("https://example.com/path");
  });

  it("preserves a balanced trailing brace", () => {
    expect(trimUrlTail("https://example.com/{template}")).toBe("https://example.com/{template}");
  });

  it("strips an unbalanced trailing brace", () => {
    expect(trimUrlTail("https://example.com/path}")).toBe("https://example.com/path");
  });

  it("strips iteratively past a balanced closer back to clean text", () => {
    // `https://x/(y).` — strip `.`, then `)` is balanced by `(` so stop.
    expect(trimUrlTail("https://x/(y).")).toBe("https://x/(y)");
  });

  it("strips iteratively across mixed trailing chars", () => {
    // `(https://x).` matched as `https://x).` — strip `.`, then `)` is
    // unbalanced, strip → "https://x"
    expect(trimUrlTail("https://x).")).toBe("https://x");
  });
});

describe("urls/extractLastUrl", () => {
  it("returns undefined when no URL is present", () => {
    expect(extractLastUrl("nothing here")).toBeUndefined();
    expect(extractLastUrl("")).toBeUndefined();
    expect(extractLastUrl("ftp://example.com")).toBeUndefined(); // http(s) only
  });

  it("extracts a bare URL", () => {
    expect(extractLastUrl("https://example.com")).toBe("https://example.com");
  });

  it("extracts and trims a URL with trailing punctuation", () => {
    expect(extractLastUrl("see https://example.com.")).toBe("https://example.com");
  });

  it("returns the LAST URL when several are present", () => {
    expect(extractLastUrl("first https://a.example/ then https://b.example/")).toBe(
      "https://b.example/"
    );
  });

  it("normalises selection-quoted URLs the same way as buffer-scanned ones", () => {
    // This is the bug the PR reviewer flagged: selection used to bypass
    // trimming, so `(https://example.com/path)` opened a broken URL.
    expect(extractLastUrl("(https://example.com/path)")).toBe("https://example.com/path");
    expect(extractLastUrl("https://example.com/path).")).toBe("https://example.com/path");
  });

  it("preserves balanced parens in a selection (Wikipedia URL)", () => {
    expect(extractLastUrl("see https://en.wikipedia.org/wiki/Function_(mathematics)")).toBe(
      "https://en.wikipedia.org/wiki/Function_(mathematics)"
    );
  });

  it("preserves IPv6 brackets in a selection", () => {
    expect(extractLastUrl("connect to http://[::1]:8080/admin now")).toBe(
      "http://[::1]:8080/admin"
    );
  });

  it("does not match a bare `http://` with no host", () => {
    // The regex requires at least one non-whitespace char after `://`, so
    // a dangling scheme inside prose doesn't get opened.
    expect(extractLastUrl("the http:// scheme is for non-tls")).toBeUndefined();
  });
});
