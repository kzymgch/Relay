# Relay

Multi-pane terminal app for orchestrating CLIs side-by-side
(e.g. `codex`, `claude code`, and a regular shell) in one window,
with text routing between panes.

- **Platform**: macOS 12+ on Apple Silicon (`aarch64-apple-darwin`) only
- **Stack**: Tauri 2 + Rust + Svelte 5 (SvelteKit / adapter-static) + Vite + TypeScript
- **Terminal rendering**: xterm.js (planned)
- **Distribution**: GitHub Releases, **unsigned** (see [Gatekeeper note](#gatekeeper-on-first-launch))

> Personal-use project. Not signed or notarized.

---

## Requirements

| Tool                               | Version                                   | Install                                                     |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| macOS                              | 12 (Monterey) or newer, Apple Silicon     | —                                                           |
| Xcode Command Line Tools           | —                                         | `xcode-select --install`                                    |
| Rust                               | stable (pinned via `rust-toolchain.toml`) | `rustup target add aarch64-apple-darwin`                    |
| Node.js                            | 20 LTS or newer                           | nvm / fnm / asdf, etc.                                      |
| pnpm                               | 10.x (pinned via `packageManager`)        | `brew install pnpm` or `corepack enable`                    |
| lefthook (optional, for git hooks) | 1.x                                       | `brew install lefthook` (auto-installed via `pnpm install`) |

`npm` and `yarn` are blocked by the `preinstall` hook — use `pnpm`.

---

## Getting started

```bash
pnpm install          # installs deps + runs lefthook install + svelte-kit sync
pnpm tauri dev        # launch the Tauri dev build (opens the app window)
```

Frontend-only iteration (no Tauri shell):

```bash
pnpm dev              # Vite dev server at http://localhost:1420
```

---

## Scripts

| Script              | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | Vite dev server                           |
| `pnpm build`        | Vite production build                     |
| `pnpm preview`      | Preview the Vite build                    |
| `pnpm tauri dev`    | Tauri dev build (window)                  |
| `pnpm tauri build`  | Tauri production bundle (`.app` / `.dmg`) |
| `pnpm lint`         | ESLint                                    |
| `pnpm lint:fix`     | ESLint with `--fix`                       |
| `pnpm format`       | Prettier (write)                          |
| `pnpm format:check` | Prettier (check only — used in CI)        |
| `pnpm typecheck`    | `svelte-kit sync` + `svelte-check`        |
| `pnpm test`         | Vitest (run once)                         |
| `pnpm test:watch`   | Vitest (watch mode)                       |

Rust (run inside `src-tauri/`):

| Command                                     | Purpose                    |
| ------------------------------------------- | -------------------------- |
| `cargo fmt --check`                         | Format check               |
| `cargo clippy --all-targets -- -D warnings` | Lint (warnings are errors) |
| `cargo test --all`                          | Run all Rust tests         |

---

## Building distributables

```bash
pnpm tauri build
```

Outputs land in `src-tauri/target/release/bundle/`:

- `macos/Relay.app` — application bundle (directory)
- `dmg/Relay_<version>_aarch64.dmg` — installer image

**Releases** publish the `.dmg` directly. The `.app` bundle is a directory and
cannot be uploaded as-is — zip it with `ditto` if you need to attach it:

```bash
ditto -c -k --sequesterRsrc --keepParent Relay.app Relay-app.zip
```

### Gatekeeper on first launch

Because Relay is **not code-signed or notarized**, macOS Gatekeeper will block
the first launch with "Relay can't be opened because Apple cannot check it
for malicious software."

Two ways to allow it:

1. Right-click the app → **Open** → confirm in the dialog.
2. Remove the quarantine attribute from a terminal:

   ```bash
   xattr -d com.apple.quarantine /Applications/Relay.app
   ```

---

## Project layout

```
.
├── src/                  # Svelte / SvelteKit frontend
│   ├── app.html
│   └── routes/
├── src-tauri/            # Rust backend (Tauri)
│   ├── src/
│   ├── capabilities/
│   ├── icons/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── static/               # static assets served by Vite
├── tests/                # Vitest tests
├── .github/workflows/    # GitHub Actions CI
├── eslint.config.js
├── lefthook.yml
└── package.json
```

---

## CI

Every PR runs on `macos-14` (Apple Silicon) in GitHub Actions:

- **Frontend**: `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm test`
- **Rust**: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --all`

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch naming, commit rules,
and the per-PR Definition of Done.

---

## License

[MIT](./LICENSE)
