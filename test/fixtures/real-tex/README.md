# Real TeX integration corpus

Each case is compiled in an isolated temporary directory by `test/real-tex.test.js`, using the installed pdfLaTeX with file-and-line errors and `errorcontextlines=50`. No TeX installation is downloaded; the integration test explicitly skips when no engine is available. All dependencies are standard TeX Live packages (`article`, `amsmath`). Shell escape is disabled.

`manifest.json` records UTF-16, end-exclusive expected ranges in the original source snapshots. Required exact ranges are positive acceptance cases. Allowed exact ranges constrain every confident answer, including optional support. Cases marked `noExact` must abstain because source presence alone does not establish the executed origin. Clean compilations must produce no resolver errors even when comments, verbatim text, or inactive branches contain apparent misspellings.

Run with `node --test test/real-tex.test.js`. `LATEX_HIGHLIGHTER_FIXTURE` filters by case-name substring, `LATEX_HIGHLIGHTER_TEST_ENGINE` selects the pdfLaTeX executable, and `LATEX_HIGHLIGHTER_KEEP_TEST_LOGS=1` preserves all compilation artifacts. Failures always preserve logs and print their directory.

The corpus tests direct and delayed alignment failures, gather and multline, repeated spellings, included and nested macro definitions, filenames containing spaces, Unicode and CRLF offsets, wrapped context, escaped percent signs, unused macro arguments, verbatim and conditional decoys, duplicate definitions, generated command names, category-code changes, and structural errors. Correctness of arbitrary TeX expansion is not claimed.
