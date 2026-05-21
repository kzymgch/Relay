# Contributing

This document captures the workflow, conventions, and quality bar for working
on Relay.

---

## Branches

- Base branch: `main` (protected — PR required, linear history, no force-push)
- Per-change branches off `main`:
  - `feat/<topic>` — new feature or behavior
  - `fix/<topic>` — bug fix
  - `chore/<topic>` — tooling, refactor, infra, dependencies
- One focused change per PR. Aim for **< 500 lines of diff**.

---

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint via lefthook's `commit-msg` hook.

Typical types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`, `perf`.

Examples:

```
feat: add bracketed-paste send across panes
fix: clean up PTY child on window close
chore: bump @tauri-apps/cli to 2.12
```

PRs are merged with **squash merge**. Write the merge subject as a single
Conventional Commit message.

---

## Quality gates

Every PR must pass the following locally and in CI.

### Frontend

| Command                    | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `pnpm lint`                | ESLint (typescript-eslint + eslint-plugin-svelte) |
| `pnpm format:check`        | Prettier (`prettier-plugin-svelte`)               |
| `pnpm typecheck`           | `svelte-kit sync` + `svelte-check`                |
| `pnpm test`                | Vitest (unit)                                     |
| `pnpm e2e` (PR-30 onwards) | Playwright browser smoke                          |

### Rust (`src-tauri/`)

| Command                                     | Purpose                    |
| ------------------------------------------- | -------------------------- |
| `cargo fmt --check`                         | rustfmt                    |
| `cargo clippy --all-targets -- -D warnings` | Lint (warnings are errors) |
| `cargo test --all`                          | Unit + integration tests   |

CI runs both on `macos-14` for every PR.

---

## Pre-commit hooks

`pnpm install` runs `lefthook install` (via the `prepare` script). The
`pre-commit` hook runs Prettier, ESLint, and `rustfmt` on staged files. The
`commit-msg` hook runs `commitlint`.

To skip hooks intentionally (rare — generally **don't**):

```bash
LEFTHOOK=0 git commit -m "..."
```

---

## Definition of Done

A PR is ready to merge when:

- [ ] Implements the intended scope and nothing extra
- [ ] New / changed code is covered by a corresponding test
      (Rust unit/integration test, Vitest, or Playwright browser smoke)
- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` is green
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --all` is green
- [ ] For PR-30 and later: `pnpm e2e` is green
- [ ] CI is green on the PR
- [ ] PR description includes test plan and (if relevant) a screenshot / recording

---

## Testing strategy

- **Rust unit tests** — module-level (`#[cfg(test)] mod tests`).
- **Rust integration tests** — `src-tauri/tests/` exercising Tauri commands
  via `tauri::test::mock_builder` (no real window).
- **Frontend unit tests** — Vitest. Svelte components via
  `@testing-library/svelte`. Tauri APIs stubbed via
  `@tauri-apps/api/mocks` (`mockIPC`).
- **Frontend browser smoke** — Playwright (browser mode), introduced in PR-30.
  Runs against the Vite dev server with `mockIPC`. Covers screen flows,
  keybindings, and IPC contract — **not** real Tauri runtime, PTY, or
  filesystem.
- **Manual smoke** — `scripts/manual-smoke.md` (added in PR-30) covers the
  pieces the automated suites can't: real Tauri startup, real PTY spawn, real
  filesystem persistence. Run before tagging a release.
- **Keychain-touching tests** — annotated `#[ignore]` and skipped in CI.
  Run locally with `cargo test -- --ignored`.

---

## Coverage targets

- End of Phase 1: Rust 60% / frontend 50%
- End of Phase 4: Rust 70% / frontend 60%
- End of Phase 6: Rust 75% / frontend 65% + Playwright covers 5 key flows +
  full manual smoke checklist

---

## Releasing

Tagged releases (`vX.Y.Z`) trigger a workflow that builds with
`pnpm tauri build` and uploads `.dmg` to GitHub Releases. The `.app` bundle
can optionally be zipped and attached.

Relay is distributed **unsigned**. The release notes link to the Gatekeeper
workaround in [README.md](./README.md#gatekeeper-on-first-launch).
