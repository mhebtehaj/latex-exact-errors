# Contributing

Use Node.js 22 or newer for development. The installed extension has no runtime npm dependencies; its optional compiler wrapper requires Node.js 20 or newer.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run package
```

Install a TeX distribution with `pdflatex` for compiler tests. Without it, those tests are explicitly skipped; this is not a full validation run. `LATEX_HIGHLIGHTER_TEST_ENGINE` can select an absolute compiler path.

## Editor integration tests

```sh
npm run test:live-host
npm run test:host
```

These launch disposable workspaces in isolated editor profiles. By default they download VS Code through `@vscode/test-electron`. To test Cursor on macOS, set `LATEX_EXACT_HOST_EDITOR=/Applications/Cursor.app/Contents/MacOS/Cursor`. The first download requires internet access. On headless Linux, prefix each command with `xvfb-run -a`.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `LATEX_EXACT_HOST_EDITOR` | Absolute editor executable path. |
| `LATEX_EXACT_HOST_CURSOR` | Older alias for the editor executable. |
| `LATEX_EXACT_HOST_VERSION` | Select a VS Code version to download; default `stable`. An explicit editor executable still takes precedence. |
| `LATEX_EXACT_HOST_ENGINE` | Compiler executable for compiler host tests; defaults to detected `pdflatex`. |
| `LATEX_EXACT_HOST_KEEP=1` | Retain disposable fixtures after a successful host test. |
| `LATEX_EXACT_WORKSHOP_ROOT` | Installed LaTeX Workshop extension directory for `npm run test:workshop-host`. |

The live host tests require no TeX installation. The compiler host suite uses a settings stub; the separate Workshop suite tests the actual installed Workshop extension. Neither suite edits an existing manuscript.

## Fixes and bug reports

For a false warning or missed error, start with a small shareable LaTeX example containing the necessary package imports and macro definitions. Include editor, extension, OS and Workshop versions, the exact message, and steps to reproduce it. Do not upload a private manuscript just to reproduce a small error.

Add a regression test for changed checking behavior. Keep UTF-16 ranges exact, preserve source order and scope, and report uncertainty when a source location cannot be justified. Live findings must remain distinct from compiler-confirmed errors.

GitHub checks run syntax, unit, real-TeX and editor host tests on Linux, then package the extension. The workflow configuration is not evidence of platform support until a run has passed. Local validation history and limits are in `VALIDATION.md`.

Reports may be examined by an AI coding assistant. It can prepare a draft pull request, but merging and publishing are manual maintainer decisions. See [the issue-fix workflow](docs/ISSUE_FIX_ASSISTANT.md) for scheduling, review, and privacy details.
