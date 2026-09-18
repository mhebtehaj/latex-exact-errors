'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeStructure } = require('../src/structure');

test('marks an unclosed dollar opener as suspected, without inventing an insertion point', () => {
  const source = 'Before $x+1';
  const hints = analyzeStructure(source);
  assert.equal(hints.length, 1);
  assert.deepEqual({ code: hints[0].code, start: hints[0].start, end: hints[0].end, confidence: hints[0].confidence },
    { code: 'math-unclosed', start: 7, end: 8, confidence: 'suspected' });
  assert.match(hints[0].message, /earlier missing delimiter/);
});

test('supports balanced inline, display, explicit delimiters and nested text math', () => {
  const source = String.raw`$x+\text{for $n>0$}$
$$x+1$$
\(x+1\) \[x+1\]
\begin{align*}
x &= \text{for $n>0$} \\
y &= 2
\end{align*}`;
  assert.deepEqual(analyzeStructure(source), []);
});

test('explicit delimiter mismatches retain related opener information', () => {
  const hints = analyzeStructure(String.raw`\(x+1\]`);
  assert.equal(hints[0].code, 'math-mismatched');
  assert.equal(hints[0].start, 5);
  assert.deepEqual(hints[0].related[0], { start: 0, end: 2, message: 'The apparent opener is here.' });
});

test('a paragraph reached inside inline math marks the earlier opener', () => {
  const source = '$x+1\n  \nmore text$';
  const hint = analyzeStructure(source).find(e => e.code === 'math-paragraph');
  assert.ok(hint);
  assert.equal(hint.start, 0);
  assert.equal(hint.confidence, 'suspected');
  assert.equal(hint.related[0].start, 5);
});

test('shifted dollar parity before a display gives a useful suspected context', () => {
  const source = String.raw`First $unclosed formula
Then $second formula$ followed by
\begin{align*}
x &= 1
\end{align*}`;
  const hints = analyzeStructure(source);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].code, 'math-display-inside-inline');
  assert.equal(hints[0].confidence, 'suspected');
  assert.equal(source.slice(hints[0].start, hints[0].end), '$');
  assert.match(hints[0].message, /earlier missing/);
});

test('ordinary single newlines within math do not imply missing dollars', () => {
  assert.deepEqual(analyzeStructure('$x+\ny+z$'), []);
});

test('blank and whitespace-only alignment lines are highlighted and fixing clears them', () => {
  for (const gap of ['\n', '  \n', '\t\r\n']) {
    const before = '\\begin{align*}\na &= 1\n';
    const after = 'b &= 2\n\\end{align*}\n';
    const hints = analyzeStructure(before + gap + after);
    assert.equal(hints.length, 1);
    assert.equal(hints[0].code, 'alignment-paragraph');
    assert.equal(hints[0].start, before.length);
    assert.equal(hints[0].end, before.length + gap.length);
    assert.equal(hints[0].confidence, 'certain');
    assert.deepEqual(analyzeStructure(before + after), []);
  }
});

test('explicit par and blank lines inside intertext remain invalid collected alignment paragraphs', () => {
  for (const body of [String.raw`a&=1\par b&=2`, '\\intertext{first\n\nsecond}']) {
    assert.ok(analyzeStructure('\\begin{align*}\n' + body + '\n\\end{align*}').some(e => e.code === 'alignment-paragraph'));
  }
});

test('comment-only alignment lines are not paragraph breaks', () => {
  assert.deepEqual(analyzeStructure('\\begin{gather*}\na=1\n % comment\nb=2\n\\end{gather*}'), []);
});

test('environment mismatches point at the wrong closing name and its opening', () => {
  const source = String.raw`\begin{align*}x&=1\end{gather*}`;
  const hints = analyzeStructure(source);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].code, 'environment-mismatched');
  assert.equal(source.slice(hints[0].start, hints[0].end), '\\end{gather*}');
  assert.equal(source.slice(hints[0].related[0].start, hints[0].related[0].end), '\\begin{align*}');
});

test('unmatched braces and environments have bounded nonempty ranges', () => {
  const source = String.raw`}\begin{align*}{x`;
  const hints = analyzeStructure(source);
  assert.deepEqual(new Set(hints.map(e => e.code)), new Set(['brace-unexpected-close', 'brace-unclosed', 'environment-unclosed']));
  for (const hint of hints) assert.ok(hint.start >= 0 && hint.end > hint.start && hint.end <= source.length);
});

test('comments, escaped special characters, verb and code environments are opaque', () => {
  const source = String.raw`% $ { \begin{align}
\$ \{ \} \verb|$ { } \end{align}| \verb*+$$ {+
\begin{minted}{tex}
$ { \end{align}
\end{minted}
\begin{verbatim}
$ {
\end{verbatim}`;
  assert.deepEqual(analyzeStructure(source), []);
});

test('macro and environment definition bodies may deliberately store unmatched syntax', () => {
  const source = String.raw`\newcommand{\openmath}{$}
\def\closemath{$}
\newcommand{\withoption}[2][{]}]{\begin{align}#1}
\NewDocumentCommand{\test}{m}{\ifunknown $ \fi}
\newenvironment{boxedmath}{\begin{equation}}{\end{equation}}
\begin{boxedmath}x=1\end{boxedmath}`;
  assert.deepEqual(analyzeStructure(source), []);
});

test('macros supplying opening syntax require abstention when the closing token is literal', () => {
  assert.deepEqual(analyzeStructure(String.raw`\def\startinline{$}\startinline x+1$`), []);
  assert.deepEqual(analyzeStructure(String.raw`\def\startequation{\begin{equation}}\begin{document}\startequation x=1\end{equation}\end{document}`), []);
});

test('literal inactive branches are skipped and known active branches are checked', () => {
  assert.deepEqual(analyzeStructure(String.raw`\iffalse $ { \iftrue } \fi \else $x$ \fi`), []);
  assert.ok(analyzeStructure(String.raw`\iftrue { \else $ \fi`).some(e => e.code === 'brace-unclosed'));
});

test('unknown conditionals and changed tokenization abstain instead of guessing semantics', () => {
  for (const source of [String.raw`\ifcustom $ \else { \fi`, String.raw`\catcode\$=12 $ {`, String.raw`\csname foo\endcsname {`]) {
    assert.deepEqual(analyzeStructure(source), []);
  }
});

test('ordinary logical iff is not treated as a TeX conditional', () => {
  const hints = analyzeStructure(String.raw`$x\iff y$ {`);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].code, 'brace-unclosed');
});

test('UTF-16 source positions survive astral characters, tabs and CRLF', () => {
  const source = '😀\ttext\r\n$broken';
  const hint = analyzeStructure(source)[0];
  assert.equal(hint.start, source.indexOf('$'));
  assert.equal(hint.end, source.indexOf('$') + 1);
});

test('large ordinary manuscripts and long physical lines stay linear enough for live checks', () => {
  const source = ('Text with $x+1$ and \\begin{quote}words\\end{quote}. ').repeat(4000);
  const start = performance.now();
  assert.deepEqual(analyzeStructure(source), []);
  assert.ok(performance.now() - start < 1000, 'A 200KB long-line document should not trigger quadratic scanning.');
  assert.deepEqual(analyzeStructure('x'.repeat(2 * 1024 * 1024 + 1)), []);
  assert.deepEqual(analyzeStructure('{'.repeat(513)), []);
  assert.deepEqual(analyzeStructure('\\begin{x}'.repeat(513)), []);
});

test('empty buffers return no hints and invalid input fails explicitly', () => {
  assert.deepEqual(analyzeStructure(''), []);
  assert.throws(() => analyzeStructure(null), TypeError);
});
