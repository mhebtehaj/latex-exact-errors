# Try the live checker

Open this folder in Cursor or VS Code with LaTeX Exact Errors installed. Open `main.tex` and wait briefly. The intentional `\alhpa` typo should be highlighted yellow, while `\customsymbol`, defined in `macros.tex`, is recognized.

Fix the typo to `\alpha` and the highlight clears. Insert an unmatched `$` or `{` in the document, pause, and complete the pair to try the structural checks. These checks require neither saving nor compiling.

The intentional typo makes the initial document fail compilation. For compiler red squiggles, install TeX, Node.js and LaTeX Workshop, run **LaTeX Exact: Enable for This Project**, and compile it.
