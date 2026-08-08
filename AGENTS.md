# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. Keep Electron lifecycle, PTY management, settings, and Claude hook integration in `src/main/`; expose only safe renderer APIs from `src/preload/`; place browser UI code and CSS in `src/renderer/`; and keep IPC contracts and shared types in `src/shared/`. Build tooling and smoke checks live in `scripts/`. Static packaging assets are under `build/`, while user-facing images belong in `docs/`. Treat `dist/`, `dist-test/`, and `release/` as generated output.

## Build, Test, and Development Commands

- `npm install` installs pinned dependencies from `package-lock.json`.
- `npm start` builds the project and launches Electron in development mode.
- `npm run build` bundles the main, preload, and renderer entry points into `dist/` with esbuild.
- `npm run check` runs strict TypeScript checks without emitting files.
- `npm run smoke` exercises `SessionManager` snapshot, attach, resize, and shutdown behavior without a GUI.
- `node scripts/smoke-hooks.mjs` verifies hook merging, idempotency, and preservation of existing Claude settings.
- `npm run package` creates an Apple Silicon macOS app and DMG in `release/`.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, single quotes, and no semicolons, matching existing sources. Prefer `camelCase` for variables and functions, `PascalCase` for classes and interfaces, and descriptive IPC names grouped in `src/shared/types.ts`. Keep main/preload/renderer boundaries explicit. The project has no formatter or linter configuration; `npm run check` is the required static validation. Add short comments for terminal protocol, lifecycle, or macOS-specific behavior that is not obvious from the code.

## Testing Guidelines

Tests are executable Node smoke scripts named `scripts/smoke-*.mjs`. Extend the relevant script when changing PTY streaming, session state, hooks, or settings. Tests must be deterministic, clean up spawned sessions, preserve user configuration, and exit nonzero on failure. Before submitting, run `npm run check`, `npm run smoke`, and the hooks smoke script. For UI changes, also launch `npm start` and verify session switching, resizing, and keyboard input on macOS.

## Commit & Pull Request Guidelines

Recent commits use concise Japanese summaries that state the user-visible change or fixed failure; Conventional Commit prefixes are not required. Keep each commit focused. Pull requests should explain the problem and solution, list verification commands, link relevant issues, and include before/after screenshots for visible UI changes. Call out changes to `~/.claude/settings.json`, hook behavior, IPC contracts, or packaging because they carry compatibility or security implications.
