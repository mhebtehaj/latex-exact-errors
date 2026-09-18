# Validation

The baseline below covers 0.4.0, tested locally on 2026-09-16 (UTC) with Cursor's VS Code API version 1.128.0. Subsequent updates are recorded at the end.

## Existing implementation and concurrency

The initial implementation was 0.3.0. Its compiler mapping, report/source validation, progressive reports, configuration commands, legacy structural scanner, and 188 passing tests were retained. Another task was completing the progressive compiler changes. This task worked in new `src/live/` modules while that task was active, then reread the shared entry point and integrated with small targeted changes after it finished. The compiler controller runs unchanged except that production activation delegates live rules to the new controller. The original scanner remains available to existing callers and exposes lexical primitives to the new parser.

No manuscript files or manuscript settings were changed. A saved manuscript snapshot was read to check realistic command coverage; all inserted errors, typing, undo/redo, and included-file mutations occurred in disposable fixtures.

## Automated coverage

- `npm test`: 214 tests passed, with no failures or skips.
- 26 project/parser/rule tests in `test/live-parser.test.js` cover inline/display/align typos; exact UTF-16 ranges; CRLF; comments, escapes and verbatim; declaration forms; order and scope; environment-local macros; package dependencies/cache/uncertainty; incomplete declarations; macro-created delimiters; uncertain conditionals; unmatched structure; valid intervals; alignment mistakes; unsaved includes; magic roots; changed disk dependencies; local packages; cross-file structural boundaries; and disabled buffers contributing unsaved definitions.
- The retained compiler tests cover real TeX, expanded-command attribution, streaming partial contexts, failed/successful builds, unsaved/changed sources, superseding builds, and late reports.
- `test/live-host/run.js` launches an actual Cursor extension host in an isolated profile and records its result. It does not compile or touch the live manuscript. It verifies real `TextEditor.edit` events, Problems diagnostics and severity, exact ranges shared with decorations, registered hover ranges, unsaved updates, undo/redo, rapid edits, untitled buffers, file switching, adding an unsaved included definition, stale worker results, and a late stale compiler report.
- `npm run check` checks JavaScript syntax and the extension entry point. The VSIX is built with the existing local packaging tool.

## Measured editor latency

The default debounce is 300 ms. Timings start immediately before an actual editor edit and end when the current document version has been analyzed and the new diagnostics are readable from Cursor's diagnostic collection. They include the edit, debounce, worker round trip, analysis, and diagnostic publication. Polling adds up to roughly 10 ms. These are extension-host integration timings, not parser-only timings or frame-paint measurements.

| Run | Samples | Median | Maximum | Fixture |
| --- | ---: | ---: | ---: | --- |
| Initial successful host run | 15 | 369.9 ms | 388.3 ms | 3 small cases plus 12 edits in 640,062 characters / about 10,005 lines |
| Host run during compiler regressions | 15 | 367.9 ms | 570.8 ms | Same large fixture; adds untitled-buffer coverage |
| Final host run | 15 | 369.0 ms | 407.2 ms | Same fixture; stale-report test additionally validates report schema and source-rejection reason |

The middle run overlapped the full compiler regression suite; 14 of its 15 samples were below 500 ms. All 15 samples in the final run were below 500 ms. This meets the target in typical measured edits but does **not** establish a hard 500 ms bound. Raw evidence is retained in `test/results/live-host-0.4.0.json` , `test/results/live-host-0.4.0-loaded.json`, and `test/results/live-host-0.4.0-final.json` (source checkout only).

A separate 440,085-character analysis benchmark measured about 61 ms cold and 20–26 ms warm. That justified using a persistent worker instead of spending those intervals on the extension host thread.

## Visual-verification limit

The real host verified diagnostic messages/severity/ranges and the hover provider's range. A separate disposable development window was opened for native visual inspection. The computer-use tool returned “Screenshot unavailable for /Applications/Cursor.app”; window selection also conflicted with concurrent use of the live Cursor window. Therefore pixel-level confirmation of the rendered red underline and hover text was not completed, and screen-paint latency is not claimed. The real Problems diagnostic collection and the decoration ranges were tested directly.

## Remaining limitations

TeX expansion, dynamic names, arbitrary catcode changes, conditional package options, argument-dependent macro behavior, and general alignment column specifications remain outside the static model. Metadata is incomplete and is disclosed as uncertainty. Source-order scope is tracked for common definitions, but this is not a proof of compiler acceptance. See `README.md` for configurable overrides and indexing limits and `METADATA.md` for source/license provenance.

## 0.4.1 appearance and settings update

Compiler-confirmed tokens use a red wavy underline; live findings use a configurable yellow background by default and warning/information diagnostics. The new `latexExact.liveHighlightColor` setting and existing `latexExact.lintDelay` apply without reloading.

- JavaScript syntax/entry-point checks and all 36 compiler-controller tests passed.
- The isolated Cursor host passed the live integration checks again, including changing the color while a finding is visible and changing/restoring workspace settings without reloading. Configured 800 ms and 50 ms delays measured 803.0 ms and 51.6 ms from the edit event to publication, respectively.
- With the default 300 ms delay, the final run measured median 355.6 ms and maximum 376.4 ms across the same 15 edit samples. An earlier successful run during this update measured median 528.9 ms and maximum 742.1 ms; these remain observations, not a latency guarantee.
- Raw final evidence is in `test/results/live-host-0.4.1.json`. These checks verify the live APIs and setting lifecycle; the pixel-level visual-verification limitation above still applies.

## 0.4.2 retain untouched highlights while typing

Tested on 2026-09-17 (UTC) with Cursor's VS Code API version 1.128.0. `latexExact.keepLiveHighlightsWhileTyping` defaults to true and takes effect without reloading. Untouched findings follow UTF-16 edits; touched tokens clear immediately. Retained findings are marked as pending until a fresh analysis replaces them. Compiler-confirmed marks retain their original invalidation behavior.

- All 68 targeted range-mapping, parser/project, and compiler-controller tests passed. Range tests cover multiline/Unicode shifts, insertions at token edges, overlaps, deletion, multiple simultaneous edits in either order, and preserving a second finding when one is edited.
- The real Cursor host passed the existing live checks plus rapid prefix edits with retained highlights, immediately clearing one corrected token while preserving another, retaining findings in another unsaved buffer, and toggling the Boolean setting off/on without reloading. Superseded worker results and stale compiler reports remain rejected.
- The 15 default-delay edit samples measured median 365.1 ms and maximum 409.4 ms. Raw evidence is in `test/results/live-host-0.4.2.json`.
- Two earlier host attempts exited without results during the focus-based untitled-document close step. The runner now leaves dirty untitled fixtures open until the isolated process exits; the complete rerun passed. No manuscript files were used for edits or tests. Pixel-level rendering was not measured.

## 0.4.3 unmatched delimiters after formatting macros

The checker incorrectly classified every macro containing `\begingroup` or `\bgroup` as structurally unsafe, even with a matching closer. Invoking such a macro suppressed later structural findings throughout the expanded project. Balanced explicit groups are now checked as pairs. Genuinely unbalanced macro bodies remain uncertain. A second correction preserves an outer `\left`/`\right` pair around a nested matrix while still rejecting pairs that cross the matrix boundary.

- `npm test`: all 224 tests passed; JavaScript syntax and entry-point checks passed.
- A disposable snapshot of the four manuscript source files reproduced the failure before the fix. Afterward, inserting a single `$` or `{` at either of two positions following an included formatting macro produced the exact one-character warning; the unchanged snapshot produced no findings. That project-specific snapshot is excluded from the public repository; the synthetic regression fixtures are included. The live manuscript was never edited.
- The isolated Cursor host passed all existing checks plus solitary `$`/`{` buffers and an included formatting-macro fixture. It verified exact live warning ranges and clearing after completing `$x$` or `{}`. Evidence is in `test/results/live-host-0.4.3.json`. The initial pairing-test assertion was corrected to use `$x$`, because adjacent `$$` opens display math.
- Pixel-level rendering was not inspected; the checks verify the real diagnostic collection and ranges used by the existing yellow decoration.

## 0.4.4 thmtools command recognition

The installed Workshop metadata had no `thmtools` command record, causing valid `\declaretheorem` declarations to be reported as informational unknown commands. The package-specific fallback now recognizes `\declaretheorem`, `\declaretheoremstyle`, and `\listoftheorems` when `thmtools` is loaded. Misspellings still report, and the commands are not added to the global vocabulary.

- All 32 parser/project tests passed, including package gating, typo suggestions, and declarations in an included settings file; syntax checks passed.
- Comparing the supplied settings source using installed 0.4.3 versus the fix reduced findings on `\declaretheorem` from 12 to zero. The settings file was only read.
- The isolated Cursor host passed with a `thmtools` declaration fixture added to its package checks. Raw evidence is in `test/results/live-host-0.4.4.json`. An earlier host attempt closed without a result; the retry passed.
- A separate disposable TeX build confirmed that `style=theorem` produces the reported `amsthm` warning and `style=plain` clears it. This compiler warning is independent of live command recognition; the user's journal was not edited.

## 0.5.0 public beta preparation

Tested on 2026-09-18. The runtime checking behavior is unchanged from 0.4.4; release preparation adds standalone development dependencies, a lockfile, portable editor test configuration, documentation and GitHub workflows. The public extension identity is `mhebtehaj.latex-exact-errors`.

- All 226 unit and real-TeX tests passed, with no failures or skips. Syntax checks and VSIX packaging passed.
- The public VSIX installed successfully in a disposable VS Code profile and its publisher/version were verified.
- A clean export installed its development tools with `npm ci --ignore-scripts` using the lockfile and successfully ran syntax checks and packaging, with no sibling-project dependency.
- Live tests passed in isolated VS Code 1.138.0 on macOS, including exact diagnostic and hover ranges, unsaved included macros, undo/redo, retained highlights, settings changes, and stale-result rejection. Evidence is in `test/results/vscode-live-host-0.5.0.json`. This verifies editor APIs and decoration ranges, not screenshot pixels.
- The compiler host suite also passed in isolated VS Code: real pdfLaTeX output, exact mapping, configuration setup/restore, edits and report invalidation. Evidence is in `test/results/vscode-compiler-host-0.5.0.json`.
- The editor testing dependency was updated to support the current macOS VS Code executable layout. Undo/redo tests now focus the source editor and await its document-change event before checking results.
- Three fresh-profile Cursor attempts closed the renderer before a complete test result. These are incomplete validation runs, not passing tests. Previous Cursor evidence remains under the earlier version sections. Default contributor tests now download isolated VS Code; testing Cursor requires selecting its executable explicitly.
- GitHub workflow execution is tracked in the repository Actions tab; the local checks above do not substitute for a completed Linux CI run.
