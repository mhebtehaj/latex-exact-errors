# LaTeX Exact Errors

**Public beta for Cursor and VS Code.** Catch likely LaTeX mistakes while typing, including commands defined in other project files. The checker provides two independent sources of feedback:

- **LaTeX Live** checks unsaved buffers after a 300 ms typing pause. A likely typo such as `\alhpa` gets a yellow background (configurable) on that command alone; the hover suggests `\alpha`. Its precise range also appears in Problems. Live findings appear as warnings or information, so red error squiggles remain reserved for compiler errors. Cursor may also draw its native warning/information underline.
- **Compiler-confirmed red squiggles** preserve the original source-validated compiler mapping, including errors reported at the end of `align`. They appear during compilation as complete error evidence arrives.

Live findings explicitly say they are not compiler-confirmed. Compiler results remain separate and cannot restore locations for edited source.

## Use

1. Download the `.vsix` file attached to a release in the [GitHub Releases page](https://github.com/mhebtehaj/latex-exact-errors/releases).
2. In Cursor or VS Code, open the Command Palette and choose **Extensions: Install from VSIX**, then select the downloaded file.
3. Reload the editor window if prompted, and open a trusted LaTeX project. Live checking works immediately; no build setup or save is needed.
4. For broader package recognition, keep LaTeX Workshop installed. The checker reads its installed completion metadata without requiring Workshop to build.
5. To enable the separate compiler mapping, install Node.js 20 or newer and run **LaTeX Exact: Enable for This Project** once. Existing managed compiler settings remain supported.

**Live checking needs no TeX installation or separate Node.js setup.** Compiler-confirmed feedback additionally needs a TeX distribution, Node.js, and a LaTeX Workshop build recipe.

If you used the earlier local prototype (`local.latex-exact-errors`), uninstall that copy before installing this public beta to avoid duplicate diagnostics.

To update a GitHub-installed copy, download the newer VSIX and install it the same way. To try the checker, open `examples/quickstart` from the source repository; it includes a deliberate typo and a macro defined in another file.

Setup wraps supported LaTeX Workshop compiler tools, preserves their arguments and environment, and enables TeX's file recorder. The original build remains responsible for the PDF. Extension upgrades update managed wrapper paths while retaining the original restore backup; later user edits to build settings are left intact. Failed builds still produce a report. Live diagnostics appear under **LaTeX Live** in Problems. Compiler diagnostics remain with the existing compiler integration; its precise decorations retain their compiler-confirmed hover.

**LaTeX Exact: Next Exact Error** jumps between confirmed locations. **LaTeX Exact: Show Build Details** explains uncertain locations, stale results, and build problems. **LaTeX Exact: Restore Original Build Tools** restores the configuration saved by setup, provided you have not subsequently edited those tools.

Live checks run after a short typing pause (300 ms by default) on the current editor buffer, including unsaved changes. Compiler-confirmed command errors still require compilation; editing clears those old confirmations. The wrapper checks compiler output every 80 ms and publishes completed error contexts while the recipe is running. It waits for the full context and a fresh recorder identifying the source files, rather than waiting for recipe termination. Compiler buffering and source verification can still add latency. The final report replaces the progressive result, and source changes or new uncaptured dependencies withdraw it.

**Keep Live Highlights While Typing** is enabled by default. Live highlights on untouched tokens stay visible and move with text inserted or deleted before them. Editing a highlighted token, including inserting at its edge, clears that finding immediately. The hover and Problems message say **Rechecking after edits** until the next check completes. A fix elsewhere, such as adding a macro definition or a missing closing delimiter, is reflected after the typing pause. Turn this setting off to clear live findings on every edit.

A LaTeX Problems-list change also triggers an immediate report refresh. A metadata check every 175 ms remains as a fallback even when the build directory is excluded from file watching. Unchanged reports do not clear and repaint existing highlights. An external dependency discovered for the first time may require a second build.

## What it supports

Command indexing recognizes standard commands, loaded package dependencies, definitions in open unsaved buffers and included `.tex`/`.sty`/`.cls` files, `\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareRobustCommand`, `\DeclareMathOperator`, `\def`/`\gdef`/`\edef`/`\xdef`, `\let`, xparse document commands/environments, custom environments, and common allocation declarations. Definitions take effect in source order, with ordinary group/environment scope. Stored macro bodies are not linted as if they were executed text.

Checks also cover unmatched `\left`/`\right`, a conservative set of math-only commands in text, stray alignment tabs, and excess tabs in `split`/`eqnarray`. Ordinary parentheses are ignored by default. Optional informational parenthesis hints exclude mixed square/round intervals and sized delimiter combinations.


Live structure checks highlight unmatched or mismatched literal `$`, `$$`, `\(` / `\)`, `\[` / `\]`, braces and environment boundaries, and blank lines or explicit `\par` inside common alignment environments. Missing-character warnings identify a suspicious opener or boundary; they do not claim to know the unique place where you intended to insert a character. Comments, escaped delimiters, known verbatim forms, macro definition bodies, and uncertain conditionals receive conservative handling. Literal inputs are followed in source order, including boundaries spanning included files. Turn off structural rules with `latexExact.liveStructure` or all live checking with `latexExact.liveCheck`.

- Direct undefined control sequences, with surrounding context to distinguish repeated commands.
- Errors inside common collected math environments, including `align`, `align*`, `gather`, and related forms.
- Straightforward named macro definitions and argument expansion when the compiler context identifies one source occurrence; invocation locations are retained when established.
- Included source files, file paths with spaces, comments, escaped percent signs, common verbatim forms, CRLF, and UTF-16 editor offsets.
- Failed builds, successful no-op builds, source edits during compilation, atomic file replacement, superseded reports, and overlapping builds sharing an output job.

An exact location requires one justified match. If macro redefinitions, dynamic `\csname` definitions, conditionals, changed category codes, truncated context, generated input, or missing dependency evidence prevent that, the tool keeps the error in build details without painting a guessed source token. Compiler syntax errors remain in the original diagnostics. Independent live checks can flag a likely structural cause even when the compiler only reports a downstream recovery point. This is not a complete TeX interpreter or a guarantee of source attribution for arbitrary TeX programs.

## Settings

Open Cursor Settings and search for **LaTeX Exact**. **Lint Delay** controls the typing pause (50–2000 ms), and **Live Highlight Color** controls the live background. For example, use `#ff555555` for translucent red or `#ffd54f55` for the default yellow. Both settings take effect without reloading. Set them under User for all projects or Workspace for this project.

| Setting | Default | Purpose |
| --- | --- | --- |
| `latexExact.liveCheck` | `true` | Enable all live checking. |
| `latexExact.liveCommands` | `true` | Check unknown commands and offer spelling suggestions. |
| `latexExact.additionalCommands` | `[]` | Recognized names for generated commands or unsupported declarations. |
| `latexExact.ordinaryParentheses` | `false` | Optional conservative informational parenthesis hints. |
| `latexExact.liveStructure` | `true` | Enable live structural warnings in open LaTeX documents. |
| `latexExact.lintDelay` | `300` | Typing-pause delay in milliseconds before a live check. |
| `latexExact.liveHighlightColor` | `#ffd54f55` | Live background color, as `#RRGGBB` or `#RRGGBBAA` with opacity. |
| `latexExact.keepLiveHighlightsWhileTyping` | `true` | Keep untouched live highlights visible during typing; clear edited tokens immediately. Changes apply without reloading. |
| `latexExact.background` | `false` | Optional background behind compiler-confirmed errors. Reload the window after changing it. |
| `latexExact.nodePath` | `node` | Node executable for setup; common macOS locations are detected. |
| `latexExact.reportPaths` | `[]` | Extra report paths, absolute or relative to the project folder. Useful for output directories outside the workspace. |

Reports are normally stored at `<output-directory>/.latex-exact/report.json`. Discovery includes hidden build folders and does not depend on Explorer or watcher exclusions. A fast metadata-only polling fallback checks reports when file watching is unavailable. Full source verification runs when results change and periodically as a safety check.

## Live analysis limits

The checker does not execute TeX. Generated command names, arbitrary expansion, conditional package options, catcode changes, and unfamiliar declaration mechanisms can remain uncertain. Missing metadata is disclosed, and generated names can be added to `latexExact.additionalCommands`. Macro argument specifications are indexed; general argument expansion and argument-dependent scope are not interpreted. Simple math/text wrappers and custom environment wrappers are recognized conservatively.

Roots are discovered from `\documentclass` and `% !TEX root = ...`; when a file belongs to several roots, the first discovered root is used unless a magic root selects one. Literal includes are resolved relative to the root, then the including file, within the workspace. `\includeonly`, arbitrary TEXINPUTS search paths, external symlink targets, and computed filenames are not evaluated. An edit rechecks open documents using cached parses and metadata, so dependent buffers update; very large multi-root workspaces can take longer than the measured fixture.

Live limits: 2 Mi UTF-16 code units per open buffer (2 MiB for a disk file), about 16 Mi code units total loaded source, 512 discovered files, include depth 40, and 500 findings per analyzed root. Full source snapshots cross to a persistent worker; results are discarded when any participating open-buffer version changes. Retained findings are provisional until rechecked, and touched ranges are removed immediately. Configuration, document lifecycle, and disk dependency changes clear the previous live results before reanalysis. Closed-file changes rely on file watcher events and are revalidated on the next analysis.

See `METADATA.md` for metadata coverage/licensing and `VALIDATION.md` for measured editor timing and test evidence.

## Manual build integration

The wrapper is also usable without automatic setup. Pass arguments as an argument array in your build system, or quote paths correctly in your shell:

```sh
node /absolute/path/to/latex-error-highlighter/bin/build.js \
  --root /absolute/path/to/project/main.tex \
  --project /absolute/path/to/project \
  --out-dir /absolute/path/to/project/build \
  -- latexmk -recorder -pdf -interaction=nonstopmode \
     -file-line-error -outdir=/absolute/path/to/project/build /absolute/path/to/project/main.tex
```

The output directory and optional `--jobname NAME` must match the compiler. `--cwd DIR` selects its working directory. `--report FILE` chooses a report location. Custom shell scripts and unsupported build tools are left untouched by automatic setup; wrap their actual compiler invocation explicitly.

## Reliability and privacy

The wrapper snapshots local source files and verifies their hashes and file identities before progressive publication and at the end of compilation. Partial error lines are never treated as complete contexts. The extension validates the report and all captured sources again, including open unsaved buffers, before displaying a location. A build with incomplete or stale input evidence is withheld. Wrapped builds sharing an output job are serialized; avoid simultaneously running an unrelated unwrapped compiler into that same output directory.

Source text and logs are processed locally. There is no telemetry or network service. Reports contain local paths, source hashes, error messages, and ranges, but do not embed the full source. TeX distribution files are excluded from the user-source index. Limits are 4 MiB per captured source, 32 MiB total source, 4096 files, and 16 MiB compiler output; unsupported inputs yield a visible explanation in build details.

## Development

Use Node.js 22 or newer for development:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run package
```

Runtime npm dependencies: none. Packaging and editor testing tools are declared development dependencies. The real-TeX tests require `pdflatex` and are explicitly skipped if it is unavailable. Editor tests download an isolated VS Code test installation by default. Set `LATEX_EXACT_HOST_EDITOR` to test a specific Cursor or VS Code executable:

```sh
npm run test:live-host
npm run test:host
# Set LATEX_EXACT_WORKSHOP_ROOT to the installed Workshop directory first:
npm run test:workshop-host
```

The tests exercise direct and delayed errors, macro definitions and arguments, repeated commands, included files, malformed input, dynamic definitions, stale sources, simultaneous builds, report validation, and editor lifecycle. The actual compiler fixtures include cases where a source occurrence looks plausible but must not be selected. The Workshop host test loads the actual installed LaTeX Workshop extension in an isolated profile, records real Problems events, and checks a recipe that continues running after TeX emits an error. The live host suite measures actual Cursor edits through publication in the real diagnostic collection, including the debounce, worker, and editor communication. It uses disposable source files and does not compile. The older basic host test uses a configuration stub and a simulated diagnostic, so it does not establish Workshop's event timing.

For test configuration and contribution instructions, see `CONTRIBUTING.md`; for versioned releases, see `RELEASING.md` and `CHANGELOG.md`. Report reproducible problems in [GitHub Issues](https://github.com/mhebtehaj/latex-exact-errors/issues) using the bug-report form.

The checker has a history of local Cursor tests on macOS. The 0.5.0 preparation also passed live and compiler host checks in VS Code on macOS; the current Cursor build closed its disposable test windows before completion. See `VALIDATION.md` for details. Other platform results depend on completed CI runs, not merely the presence of a workflow.

## Why a companion extension?

[Error Lens](https://github.com/usernamehw/vscode-error-lens) can color an existing diagnostic range. [LaTeX Workshop's range finder](https://github.com/James-Yu/LaTeX-Workshop/blob/master/src/parse/parser/parserutils.ts) and [TexLab's build-log resolver](https://github.com/latex-lsp/texlab/blob/master/crates/diagnostics/src/build_log.rs) use the reported line, which may be a closing environment or macro call. This companion retains the full TeX expansion context and resolves earlier source occurrences conservatively.
