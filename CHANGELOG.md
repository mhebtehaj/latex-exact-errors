# Changelog

## 0.5.1 — Errata for LaTeX

- Rename the extension to **Errata for LaTeX**, a live, macro-aware LaTeX inspector.
- Use **Errata** in commands and messages, and **Errata Live** for live findings and output.
- Preserve the extension identity, `latexExact.*` settings, command identifiers, and build backups so existing installations can upgrade without reconfiguration.
- Document AI-assisted issue maintenance and the daily review schedule. AI proposals still require human review before merging or releasing.
- Inspection behavior is unchanged from 0.5.0.

## 0.5.0 — Public beta

- Standalone build and test dependencies, with a lockfile for reproducible installs.
- Portable editor test configuration and removal of personal installation paths.
- GitHub checks, downloadable build artifacts, and a tested-package draft release workflow.
- Installation, contribution and maintenance instructions, a bug-report form, and a small example project.
- The checker behavior from 0.4.4 is preserved.

## 0.4.4

- Recognize `thmtools` declarations when the package is loaded, including declarations in included files.

## 0.4.3

- Preserve unmatched-delimiter checks after macros with balanced explicit groups.
- Handle outer `\left` / `\right` pairs around nested matrices.

## 0.4.2

- Add `keepLiveHighlightsWhileTyping`, enabled by default, to retain and reposition untouched live findings while typing.

## 0.4.1

- Yellow live highlights with configurable color and typing delay; red squiggles for compiler-confirmed errors.

## 0.4.0

- Macro-aware live checking of unsaved documents and included project files.
- Command spelling suggestions, structural checks, exact ranges, and separate compiler-backed diagnostics.
