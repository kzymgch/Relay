# Manual smoke checklist

Run this before tagging a release. Automated checks (`pnpm test`, `cargo
test`, `pnpm e2e`) cover the IPC contract and DOM-level wiring; this
checklist exercises the real Tauri runtime, real PTYs, real filesystem
persistence, and the macOS-only window effect that Playwright can't reach.

Tick each box as you go. If anything fails, file an issue with the specific
step that broke and the version (`git rev-parse --short HEAD`).

## 1. Build / boot

- [ ] `pnpm install` succeeds on a clean checkout.
- [ ] `pnpm tauri dev` launches the app window without errors in the
      terminal or the devtools console.

## 2. PTYs

- [ ] Three panes spawn and display the local shell prompt within ~1 s.
- [ ] Typing in each pane reaches the shell and produces output.
- [ ] `Cmd+R` restarts the focused pane (PTY exits, fresh prompt appears).
- [ ] `Cmd+K` clears the focused pane.

## 3. Layout

- [ ] `Cmd+P` → `Layout: …` palette entries swap to each preset.
- [ ] `Cmd+P` → `Split right: …` adds a new pane on the right.
- [ ] Splitter handles drag-resize smoothly; PTYs receive `resize` and
      tools like `vim` redraw correctly after a settle.
- [ ] `Cmd+1`–`Cmd+9` focus the corresponding pane in DFS order
      (`Cmd+9` jumps to the last pane regardless of count).

## 4. Send (drag-and-drop + preview)

- [ ] Selecting text in a pane reveals a floating "Send · N chars" chip
      near the selection end.
- [ ] Dragging the chip onto another pane highlights the drop target.
- [ ] Releasing opens the **Send preview** modal with the correct
      source → target labels and text.
- [ ] Pressing **Send** writes the bytes to the target PTY; the target
      shell echoes the payload.
- [ ] Toggling `Settings → Send options → Preview before send` off and
      using `Cmd+Shift+2` sends directly without the modal.

## 5. Theme

- [ ] `Settings → Theme → Preset` switches between Dark, Light,
      Solarized Dark, Solarized Light, and Dracula. Both the xterm
      canvas and the surrounding chrome update live.
- [ ] Selecting **Custom** reveals the colour pickers. Changing a slot
      updates the live view; saving persists; quitting and relaunching
      restores the same look.

## 6. Transparency

- [ ] `Settings → Theme → Transparent (macOS vibrancy)` ON paints the
      window background with the system's vibrancy material.
- [ ] Toggling OFF returns to a solid chrome background.

## 7. Keybinds

- [ ] `Settings → Keybindings → Record` on `Open command palette`,
      pressing `Cmd+Shift+P`, then **Save** rebinds the palette. The
      old `Cmd+P` no longer opens it; the new combo does.
- [ ] Pressing **Reset** on the same row restores the default.
- [ ] **Reset all to defaults** clears every override.
- [ ] Binding two actions to the same combo shows a red conflict banner
      naming both actions.

## 8. Session

- [ ] `Cmd+P` → `Save session as…` and naming it `smoke` persists.
- [ ] Quit the app, relaunch, `Cmd+P` → `Load session: smoke` restores
      the same layout and pane labels.
- [ ] With `Settings → Scrollback → Persist on exit` ON, the scrollback
      buffer is restored alongside the layout.

## 9. SSH (optional, requires a reachable host)

- [ ] Add a pane preset whose `ssh.host` points at a real machine.
      Spawning it connects and shows the remote prompt.
- [ ] `pkill ssh` on the host (or yanking the network) puts the pane
      into the `disconnected` state; the reconnect supervisor brings it
      back when the network returns.

## 10. Distribution

- [ ] `pnpm tauri build` produces a `.dmg` and a `Relay.app` bundle.
- [ ] First launch on a fresh user shows the macOS Gatekeeper warning;
      the README's workaround (`xattr -d com.apple.quarantine`) lets the
      app open.
- [ ] Vibrancy still works against the production webview (the
      `macOSPrivateApi` flag is the most likely break point between dev
      and release).
