'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parse } = require('../src/live/parser');
const { Metadata } = require('../src/live/metadata');
const { analyze } = require('../src/live/rules');
const { Project } = require('../src/live/project');
const R = String.raw;
async function check(text, options = {}) {
  const file = '/tmp/main.tex', parsed = parse(text), metadata = new Metadata();
  const events = [];
  for (const e of parsed.events) {
    if (e.kind === 'package' || e.kind === 'class') {
      const m = await metadata.load(e.kind === 'class' ? 'class-' + e.value : e.value);
      events.push({ ...e, ...m, file });
    } else events.push({ ...e, file });
  }
  return analyze(events, { base: await metadata.base(), sources: new Map([[file, parsed]]), ...options }).findings;
}
for (const text of [R`$\alhpa$`, R`\[\alhpa\]`, R`\begin{align} a &= \alhpa \\ b &= 2 \end{align}`]) {
  test('exact unknown token: ' + text, async () => {
    const f = await check(text); assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(text.slice(f[0].start, f[0].end), R`\alhpa`);
    assert.equal(f[0].severity, 'error'); assert.ok(f[0].suggestions.includes('alpha'));
  });
}
test('comments, verbatim and macro declarations do not cause unknown-use findings', async () => {
  assert.deepEqual(await check(R`% \alhpa
\newcommand{\thing}[1]{\later{#1}}
\verb|\alhpa{$| \begin{verbatim}\alhpa $ {\end{verbatim}
$\thing{1}$`), []);
});
test('definition forms and custom environment introduced commands', async () => {
  const text = R`\newcommand{\one}[1]{#1}\renewcommand\one[1]{#1}\providecommand{\two}{}\DeclareRobustCommand{\three}{}
\DeclareMathOperator*{\four}{four}\def\five#1{#1}\let\six=\five\NewDocumentCommand{\seven}{O{x}m}{#2}
\newenvironment{custom}{\def\inside{1}\begin{align}}{\end{align}}
\newtheorem{claim}{Claim}\newif\iffoo
\one \two \three $\four\five{1}\six{2}\seven{3}$\footrue\theclaim
\begin{custom}\inside & \alpha\end{custom}`;
  assert.deepEqual(await check(text), []);
});
test('order and local scopes are respected', async () => {
  const text = R`\local {\newcommand{\local}{} \local} \local \newcommand{\after}{} \after`;
  const f = await check(text); assert.equal(f.length, 2); assert.ok(f.every(f => f.code === 'unknown-command'));
});
test('global definitions and let targets are recognized without linting declaration names', async () => {
  assert.deepEqual(await check(R`{\gdef\glob#1{#1}\global\let\als=\glob}\glob{x}\als{x}`), []);
});
test('math versus text arguments, ensuremath, custom math wrapper', async () => {
  const f = await check(R`\alpha \ensuremath{\alpha} $\text{\alpha $\beta$}$ \newcommand{\wrap}[1]{\ensuremath{#1}}\wrap{\gamma}`);
  assert.equal(f.length, 2, JSON.stringify(f)); assert.ok(f.every(f => f.code === 'math-only'));
});
test('all delimiter families and missing braces highlight existing openers', async () => {
  for (const [text, token] of [[R`$\alpha`, '$'], [R`$$x`, '$$'], [R`\(x`, R`\(`], [R`\[x`, R`\[`], [R`abc {x`, '{'], [R`\begin{align}x&=1`, R`\begin{align}`]]) {
    const f = await check(text); assert.equal(f.length, 1, JSON.stringify(f)); assert.equal(text.slice(f[0].start, f[0].end), token);
  }
});
test('mismatched environment and unmatched right are local', async () => {
  assert.equal((await check(R`\begin{align}x&=1\end{equation}`))[0].code, 'environment-mismatched');
  assert.equal((await check(R`$\right)$`))[0].code, 'right-unmatched');
  assert.equal((await check(R`$\left(x$`))[0].code, 'left-unclosed');
});
test('half-open intervals and arbitrary sized pairs remain valid', async () => {
  assert.deepEqual(await check(R`$(0,1] [0,1) \left(0,1\right] \left.\alpha\right|$`, { ordinaryParentheses: true }), []);
});
test('paragraph and alignment mistakes, nested aligned and text dollar', async () => {
  assert.equal((await check('\\begin{align}\nx&=1\n\ny&=2\n\\end{align}'))[0].code, 'alignment-paragraph');
  assert.equal((await check(R`\begin{gather}x&=1\end{gather}`))[0].code, 'alignment-tab');
  assert.equal((await check(R`\begin{split}x&=1&2\end{split}`))[0].code, 'alignment-tabs');
  assert.deepEqual(await check(R`\begin{equation}\begin{aligned}x&=1\end{aligned}\end{equation}`), []);
});
test('Unicode offset and recovery after incomplete definition', async () => {
  const text = 'é😀 \\newcommand{\\x}{oops\n$\\alhpa$';
  const f = await check(text); assert.ok(f.some(f => f.code === 'brace-unclosed'));
  const typo = f.find(f => f.code === 'unknown-command'); assert.ok(typo); assert.equal(text.slice(typo.start, typo.end), R`\alhpa`);
});
test('uncertain definitions do not become alleged compiler errors; known false branches skipped', async () => {
  const f = await check(R`\csname foo\endcsname $\alhpa$`);
  assert.equal(f[0].severity, 'information');
  assert.deepEqual(await check(R`\iffalse \alhpa { $ \fi $\alpha$`), []);
});
test('package metadata follows dependencies, caches and uses uncertainty for missing coverage', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-metadata-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'packages'));
  await fs.writeFile(path.join(dir, 'packages', 'p.json'), JSON.stringify({ deps: [{ name: 'q' }], macros: [{ name: 'pkgcmd' }] }));
  await fs.writeFile(path.join(dir, 'packages', 'q.json'), JSON.stringify({ macros: [{ name: 'depcmd' }] }));
  const m = new Metadata(dir); const info = await m.load('p');
  assert.deepEqual(info.names.sort(), ['depcmd', 'pkgcmd']); assert.deepEqual(info.missing, []); assert.equal(await m.load('p'), info);
  assert.ok((await m.load('unknown')).missing.length);
});
test('thmtools declarations are recognized only when the package is loaded, while misspellings still report', async () => {
  const declarations = R`\declaretheoremstyle[headfont=\bfseries]{custom}\declaretheorem[style=custom]{claim}\listoftheorems`;
  assert.deepEqual(await check(R`\usepackage{thmtools}` + declarations), []);
  assert.deepEqual((await check(declarations)).map(f => f.code), ['unknown-command', 'unknown-command', 'unknown-command']);
  const typo = await check(R`\usepackage{thmtools}\declaretheorm{claim}`);
  assert.equal(typo.length, 1); assert.ok(typo[0].suggestions.includes('declaretheorem'));
});
test('thmtools loaded in an included settings file resolves its declarations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-thmtools-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const setting = path.join(root, 'setting.tex'), main = path.join(root, 'main.tex');
  const text = R`\usepackage{amsmath,amsthm,thmtools}\declaretheorem[name=Theorem]{theorem}\declaretheorem[sibling=theorem]{lemma}`;
  await fs.writeFile(setting, text);
  const documents = [{ file: main, version: 1, text: R`\documentclass{article}\input{setting}\begin{document}\begin{lemma}$x$\end{lemma}\end{document}` }, { file: setting, version: 1, text }];
  const results = (await new Project().run({ roots: [root], documents })).documents;
  assert.ok(results.every(r => r.findings.length === 0), JSON.stringify(results));
});
test('project uses unsaved includes, updates dependents, and isolates unrelated roots', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-project-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'main.tex'), defs = path.join(root, 'defs.tex'), other = path.join(root, 'other.tex');
  const mainText = R`\documentclass{article}\input{defs}\begin{document}\mycmd\end{document}`;
  await fs.writeFile(main, mainText); await fs.writeFile(defs, ''); await fs.writeFile(other, R`\documentclass{article}\newcommand{\foreign}{}\foreign`);
  const p = new Project();
  const req = { roots: [root], candidates: [main, defs, other], documents: [{ file: main, version: 1, text: mainText }] };
  assert.ok((await p.run(req)).documents[0].findings.some(f => f.code === 'unknown-command'));
  req.documents.push({ file: defs, version: 2, text: R`\newcommand{\mycmd}{}` });
  assert.deepEqual((await p.run(req)).documents[0].findings, []);
  req.documents[0].text += R`\foreign`; req.documents[0].version++;
  assert.ok((await p.run(req)).documents[0].findings.some(f => f.message.includes('foreign')));
});

test('subscripts and colons do not become part of normal control words', async () => {
  assert.deepEqual(await check(R`$\rho_x + \Sigma_n + \mu: \alpha_{i}$`), []);
});
test('sized delimiters cannot cross braces', async () => {
  const f = await check(R`$\left( { x \right) }$`);
  assert.deepEqual(f.map(f => f.code).sort(), ['left-unclosed', 'right-unmatched']);
});
test('a nested matrix preserves the surrounding left/right pair', async () => {
  assert.deepEqual(await check(R`$\left\langle\begin{bmatrix}0&1\\1&0\end{bmatrix},\frac12\begin{bmatrix}1&0\\0&1\end{bmatrix}\right\rangle$`), []);
});
test('sized delimiters within a matrix cannot pair across the environment boundary', async () => {
  const f = await check(R`$\begin{matrix}\left(x\end{matrix}\right)$`);
  assert.deepEqual(f.map(f => f.code).sort(), ['left-unclosed', 'right-unmatched']);
  const extra = await check(R`$\left(\begin{matrix}x\right)\end{matrix}\right)$`);
  assert.deepEqual(extra.map(f => f.code), ['right-unmatched']);
});
test('unknown package coverage is disclosed on strong typo suggestions', async () => {
  const f = await check(R`\usepackage{unindexed}$\alhpa$`);
  assert.equal(f.length, 1); assert.match(f[0].message, /incomplete/); assert.match(f[0].message, /not compiler-confirmed/);
});

test('custom environment-local definitions expire at the end', async () => {
  const f = await check(R`\newenvironment{foo}{\def\inside{ok}}{}\begin{foo}\inside\end{foo}\inside`);
  assert.equal(f.length, 1); assert.equal(f[0].code, 'unknown-command');
});
test('definition of macro delimiters suppresses uncertain structure only when invoked', async () => {
  assert.equal((await check(R`\newcommand{\openmath}{$} {x`))[0].code, 'brace-unclosed');
  assert.deepEqual(await check(R`\newcommand{\openmath}{$}\openmath \alpha $`), []);
});
test('balanced grouping inside a formatting macro does not disable later delimiter checks', async () => {
  const prefix = R`\NewDocumentCommand{\boxmath}{m}{\begingroup\ensuremath{\begin{array}{c}#1\end{array}}\endgroup}
\begin{document}\[\boxmath{x}\] `;
  assert.deepEqual(await check(prefix + R`\end{document}`), []);
  for (const [token, code] of [['$', 'math-unclosed'], ['{', 'brace-unclosed']]) {
    const source = prefix + token + R`\end{document}`;
    const f = await check(source);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].code, code); assert.equal(f[0].start, prefix.length);
    assert.equal(source.slice(f[0].start, f[0].end), token);
  }
});
test('nested balanced explicit groups are safe, but unmatched and mismatched groups remain uncertain', async () => {
  const safe = R`\newcommand{\grouped}{\begingroup\bgroup x\egroup\endgroup}\grouped {`;
  assert.equal((await check(safe))[0].code, 'brace-unclosed');
  for (const body of [R`\begingroup`, R`\endgroup`, R`\bgroup`, R`\egroup`, R`\begingroup x\egroup`]) {
    assert.deepEqual(await check(R`\newcommand{\unsafe}{` + body + R`}\unsafe {`), []);
  }
});
test('uncertain branches do not corrupt structure outside the conditional', async () => {
  const f = await check(R`\ifnum 1=1 { \else } \fi $\alpha$`);
  assert.deepEqual(f, []);
});
test('comments and escaped delimiters, CRLF, no math-only false positives', async () => {
  assert.deepEqual(await check('Text \\% \\$ \\{ \\} % { $\r\n$\\alpha_{i}$\r\n'), []);
});
test('project follows a magic root and reads disk edits after caching', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-root-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'main.tex'), child = path.join(root, 'child.tex'), defs = path.join(root, 'defs.tex');
  await fs.writeFile(main, R`\documentclass{article}\input{defs}\begin{document}\input{child}\end{document}`);
  await fs.writeFile(defs, '');
  const text = '% !TEX root = main.tex\n\\xyzzy';
  await fs.writeFile(child, text);
  const p = new Project(), req = { roots: [root], documents: [{ file: child, version: 1, text }] };
  assert.equal((await p.run(req)).documents[0].findings.length, 1);
  await fs.writeFile(defs, R`\newcommand{\xyzzy}{yes}`);
  assert.equal((await p.run(req)).documents[0].findings.length, 0);
});
test('local packages are indexed and includes can span structural boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-local-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, 'main.tex');
  await fs.writeFile(path.join(root, 'local.sty'), R`\newcommand{\localcmd}{ok}`);
  await fs.writeFile(path.join(root, 'body.tex'), R`\localcmd\end{document}`);
  const text = R`\documentclass{article}\usepackage{local}\begin{document}\input{body}`;
  const result = await new Project().run({ roots: [root], documents: [{ file: main, version: 1, text }] });
  assert.deepEqual(result.documents[0].findings, []);
});
test('disabled dependent buffer still supplies its unsaved definitions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-disabled-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const docs = [{ file: path.join(root, 'main.tex'), version: 1, text: R`\documentclass{article}\input{defs}\custom` },
    { file: path.join(root, 'defs.tex'), version: 2, text: R`\newcommand{\custom}{}`, options: { enabled: false } }];
  const r = await new Project().run({ roots: [root], documents: docs });
  assert.equal(r.documents.length, 1); assert.deepEqual(r.documents[0].findings, []);
});
