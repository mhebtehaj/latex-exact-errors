# Parser and command metadata

The live parser extends the project's existing tolerant scanner (`src/structure.js`), reusing its balanced-argument scanner, whitespace/comment handling, verbatim support, definition families, and stored-structure analysis. `src/live/parser.js` produces one position-preserving event stream consumed by both command indexing and structural rules. Normal control words stop before `_` and `:`; expl3 syntax is tracked separately. Malformed declarations recover at a physical line boundary. This is a tolerant source parser, not a TeX expansion engine.

[unified-latex](https://github.com/siefkenj/unified-latex) was considered as an external AST parser. Extending the existing scanner keeps the established offset/recovery conventions and avoids introducing a complete-document grammar into the typing path. No code from unified-latex is bundled.

When LaTeX Workshop is installed in the same extension host, this extension reads its installed `data/packages/*.json`, including `tex`, `latex-document`, loaded packages, classes, and recursive `deps`. It does not activate Workshop or use its private runtime APIs. Metadata and parsed unchanged files are cached in the analysis worker. Reload after upgrading Workshop to refresh its metadata cache.

The inspected installation was LaTeX Workshop 10.18.0 and contained 247 top-level package/class metadata entries. Coverage is incomplete: missing direct packages and missing dependency records are recorded as uncertainty, exposed by `getLiveState()` and disclosed in affected unknown-command messages. The independent built-in fallback covers common TeX/LaTeX commands and selected common packages, including AMS packages, thmtools, physics, hyperref, cleveref, graphicx, mathtools, dsfont and bbm. It is intentionally not advertised as exhaustive.

## Licensing decision

- LaTeX Workshop's installed `LICENSE.txt` identifies its code as MIT, copyright James Yu.
- Its [data documentation](https://github.com/James-Yu/LaTeX-Workshop/blob/master/data/README.md) says package JSON is generated from TeXstudio CWL completion files. The [TeXstudio repository license](https://github.com/texstudio-org/texstudio/blob/master/COPYING) is GPL v3; that is not enough to assume every derived completion file has the same terms as Workshop's application code.
- Workshop also documents LPPL terms for its Unicode symbol data. This extension does not read or redistribute `unimathsymbols.json`.
- No Workshop or TeXstudio data/code is copied into this VSIX. Reading already-installed metadata is optional. The fallback vocabulary and adapter are independently implemented here. Any future vendored metadata snapshot needs a separate per-file provenance/license review, with its notices retained.

## Confidence

A likely misspelling with a nearby recognized name is presented as a live warning with a yellow background by default. It is explicitly labelled **LaTeX Live**, and the message states that it is not compiler-confirmed. Other unknown commands use the same configurable background and are warnings, or informational findings when the index is incomplete or dynamic execution is involved. An unrecognized name is never represented as evidence that TeX compilation failed.
