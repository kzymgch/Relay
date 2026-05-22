// Shared URL extraction + normalisation used by the Cmd+Enter handler.
//
// Two callers need identical semantics:
//   - Terminal.findLastUrl()    — scans the xterm buffer for the latest
//                                  printed URL.
//   - AppRoot's selection path  — opens whatever URL the user selected.
// Keeping the regex and the trim rules in one place ensures
// "select-and-open" and "open-the-last-printed-one" never disagree on
// where the URL actually ends.

// Conservative regex: only http(s), no embedded whitespace, angle
// brackets, or quotes. Anything xterm's web-links addon would have
// rendered as a link is recoverable here.
export const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;

// Pure sentence punctuation — never legitimately the last character of
// a URL printed by a CLI. Stripped unconditionally.
//
// Notably absent: `?` (legitimate as an empty-query indicator like
// `https://example.com/search?`, and routinely appears partway through
// presigned / OAuth URLs that users may select mid-stream) and `:` (port
// separator / IPv6 host punctuation; kept by the bracket-balance rule
// further down).
const URL_PURE_PUNCT_TAIL = ".,;!";

// Closing chars that *can* be part of a URL (Wikipedia
// `Function_(mathematics)`, IPv6 `http://[::1]`) — only stripped when
// the captured URL contains more closers than openers, i.e. the
// closer is acting as a wrapper around the URL rather than a
// structural part of it.
const URL_BALANCED_TAIL: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Strip trailing characters that are clearly wrappers/punctuation, while
 * preserving closing brackets/parens that are balanced inside the URL.
 *
 * Examples:
 *   "https://x/foo."                                → "https://x/foo"
 *   "(https://x/path)"   (matched as "https://x/path)") → "https://x/path"
 *   "https://en.wikipedia.org/wiki/Function_(mathematics)" → unchanged
 *   "http://[::1]:8080"                             → unchanged
 */
export function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (URL_PURE_PUNCT_TAIL.includes(ch)) {
      end--;
      continue;
    }
    const opener = URL_BALANCED_TAIL[ch];
    if (opener !== undefined) {
      let openers = 0;
      let closers = 0;
      for (let i = 0; i < end; i++) {
        if (url[i] === opener) openers++;
        else if (url[i] === ch) closers++;
      }
      if (closers > openers) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * Return the last http(s) URL found in `text` (post-trim), or `undefined`
 * when there is none. `last` rather than `first` matches the buffer-scan
 * semantics — if the user selects a region containing multiple URLs the
 * most recently printed one wins, same as if they hadn't selected anything.
 */
export function extractLastUrl(text: string): string | undefined {
  URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = URL_RE.exec(text)) !== null) {
    last = match[0];
  }
  if (last === undefined) return undefined;
  const trimmed = trimUrlTail(last);
  return trimmed || undefined;
}
