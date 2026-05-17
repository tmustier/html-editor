# Agent guide for html-editor

Concise orientation for AI coding agents working in this repo. Pair this with `README.md`.

## What this project is

`html-editor` is a little local editor for HTML your agent makes. A Python `http.server` injects a browser overlay into the served HTML; the overlay sends JSON mutations to the server, and the server rewrites the source file via BeautifulSoup. No build step, no framework. Native ES modules in the browser.

There is also an optional Pi extension (`extensions/html-editor-comments.ts`) that delivers in-browser comments back to the Pi session that launched the server.

## Repo layout

- `serve.py` — launcher that calls `server.app:main`.
- `server/` — Python server package:
  - `app.py`, `routes.py`, `document.py`, `history.py`, `comments.py`, `assets.py`
  - `document.py` is the **only** place that should mutate the BeautifulSoup tree.
- `client/*.js` — native ES modules, no bundler, no TypeScript. `main.js` is the entrypoint; the rest are pulled via `import`.
- `styles/*.css` — concatenated in filename order; served at `/__editor/main.css`.
- `extensions/html-editor-comments.ts` — Pi extension; do not import editor code from it.
- `skills/html-editor/SKILL.md` — short Agent Skill that makes the editor discoverable to Pi-loaded agents. Keep it short; if more detail is needed, agents should read the README/code.
- `tests/` — `unittest` for `server/`; Playwright e2e in `tests/e2e/`.
- `scripts/check.sh`, `scripts/test.sh` — the only test entrypoints you should use.

## How to run + test

```bash
python3 serve.py path/to/some.html --port 8765 --no-open
./scripts/check.sh            # syntax + unit tests
./scripts/test.sh             # unit + Playwright e2e
./scripts/test.sh --fast      # unit only
```

Always run `./scripts/check.sh` after edits; run `./scripts/test.sh` before committing user-visible changes.

## Conventions

- **Server mutations** live in `server/document.py` as pure functions returning `(ok: bool, payload: dict)`. Routes in `server/routes.py` are thin: read JSON, call the pure function, snapshot history, save, return JSON. Tests for new mutations go in `tests/test_document.py`.
- **Client architecture**: each `client/*.js` module owns one concern (see README "Client modules"). Cross-cutting helpers belong in `client/dom.js` (`flash`, `icon`) or `client/interaction.js` (locks, reload timing). Do not introduce a build step.
- **CSS files** are concatenated in filename order. Keep `00-base.css` minimal and group new rules into the matching numbered file.
- **Semantic target model** in `client/targets.js` is the source of truth for what is editable, draggable, commentable. Add new behaviours by extending the target model, not by checking tag names in callers.
- **Keyboard shortcuts**: when you add or change one, update the in-browser help table in `client/dom.js` and the keyboard table in `README.md`.

## Things to avoid

- Do **not** make tests depend on any specific user-supplied HTML file or absolute path on the developer's machine. Tests must build their own fixtures in `tests/e2e/fixtures/` or inline in `tests/test_document.py`.
- Do **not** reintroduce the shared `/tmp/html-editor-comments.jsonl` broadcast file as a fallback. Per-session bridges only. The `comments_bridge=none` mode is the no-pi default.
- Do **not** mutate the BeautifulSoup tree outside `server/document.py`.
- Do **not** add a JS bundler, transpiler, or framework to the client. Native ES modules only.
- Do **not** commit anything employer-specific, customer/account data, or local absolute paths beyond test fixtures.

## Pi integration notes

- The extension exports `HTML_EDITOR_COMMENTS_BRIDGE` per Pi session in `process.env`. Child processes (including `serve.py`) inherit it.
- The server picks it up via `HTML_EDITOR_COMMENTS_BRIDGE` env var unless `--comments-bridge` is passed.
- Pi-installed via `pi install git:github.com/tmustier/html-editor`; the package manifest lives in `package.json` under `"pi": { "extensions": [...] }`.
- Don't load two copies of the extension. If the global `~/.pi/agent/extensions/html-editor-comments.ts` exists, it shadows the package copy.

## Visual changes

When you change anything that renders (CSS, overlay DOM, toolbar, help table, editing affordances), screenshot the result and read it back before claiming done. Use a fixture, not a real user file. Keep screenshots in `/tmp/`.

## Releases

- Version lives in `package.json`.
- Tags follow `vMAJOR.MINOR.PATCH`.
- Release notes live in `CHANGELOG.md` and are mirrored to the GitHub release body.
- Bump the version, update `CHANGELOG.md`, commit, tag, push, then `gh release create`.

## Quick safety checklist before pushing

1. `./scripts/check.sh` ✅
2. `./scripts/test.sh` ✅ (run full e2e if anything user-visible changed)
3. No `/Users/...` or `/private/tmp/...` references in source files or tests
4. No new shared mutable global files under `/tmp`
5. README + help overlay match if shortcuts changed
6. New mutations have `tests/test_document.py` coverage and at least one e2e
