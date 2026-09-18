'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveErrors } = require('../src/core');

const ROOT = '/project/main.tex';
const resolve = (source, log, extra = {}) => resolveErrors({ rootFile: ROOT, cwd: '/project', sources: { [ROOT]: source }, log, ...extra });
const errorLog = (context, line = 1, file = './main.tex') => `${file}:${line}: Undefined control sequence.\n${context}\n`;
const sourceContext = (before, after, line = 1) => `l.${line} ${before}\n${' '.repeat(line.toString().length + 3 + before.length)}${after}`;
const exactAt = (result, source, occurrence = 0, file = ROOT) => {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = source.indexOf('\\alhpa', start + 1);
  assert.ok(start >= 0);
  assert.equal(result.errors[0].status, 'exact', JSON.stringify(result.errors));
  assert.deepEqual(result.errors[0].range, { file, start, end: start + 6 });
};

test('source-only compiler context identifies the token rather than its line', () => {
  const source = '$x+\\alhpa+y$';
  const result = resolve(source, errorLog(sourceContext('$x+\\alhpa', '+y$')));
  exactAt(result, source);
  assert.equal(result.errors[0].command, '\\alhpa');
});

test('offsets count UTF-16 code units and preserve CRLF and tabs', () => {
  const source = '% 😀\r\n😀\t$\\alhpa+1$\r\n';
  const result = resolve(source, errorLog(`<recently read> \\alhpa\n                       \n${sourceContext('😀\t$\\alhpa', '+1$', 2)}`, 2));
  exactAt(result, source);
});

test('two errors on one line stay distinct and duplicate passes collapse', () => {
  const source = '$a=\\alhpa+b+\\alhpa$';
  const one = errorLog(sourceContext('$a=\\alhpa', '+b+\\alhpa$'));
  const two = errorLog(sourceContext('$a=\\alhpa+b+\\alhpa', '$'));
  const result = resolve(source, one + two + one);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map(e => e.range.start), [3, 12]);
  assert.equal(result.stats.duplicates, 1);
});

test('an alignment context selects the matching occurrence before the closing line', () => {
  const source = '\\begin{align*}\na&=\\alhpa+1\\\\\nb&=\\alhpa+2\n\\end{align*}';
  const log = errorLog(`<argument> a&=\\alhpa+1\\\\b&=\\alhpa\n                                            +2\n${sourceContext('\\end{align*}', '', 4)}`, 4);
  exactAt(resolve(source, log), source, 1);
});

test('short context with repeated occurrences remains a candidate set', () => {
  const source = '\\begin{align*}\na&=\\alhpa+1\\\\\nb&=\\alhpa+1\n\\end{align*}';
  const log = errorLog(`<argument> ...\\alhpa\n                       +1...\n${sourceContext('\\end{align*}', '', 4)}`, 4);
  const result = resolve(source, log);
  assert.equal(result.errors[0].status, 'candidate');
  assert.equal(result.errors[0].candidates.length, 2);
  assert.equal(result.errors[0].range, undefined);
});

test('comments and verbatim text are not candidates', () => {
  const source = '% \\alhpa\n\\verb|\\alhpa| $\\alhpa$';
  const log = errorLog(sourceContext('\\verb|\\alhpa| $\\alhpa', '$', 2), 2);
  exactAt(resolve(source, log), source, 2);
});

test('inactive literal branches are excluded from candidate locations', () => {
  const source = '\\begin{align*}\n\\iffalse\\alhpa\\fi\n x=\\alhpa\n\\end{align*}';
  const log = errorLog(`<argument> ...x=\\alhpa\n                          \n${sourceContext('\\end{align*}', '', 4)}`, 4);
  exactAt(resolve(source, log), source, 1);
});

test('unknown conditionals preserve uncertainty instead of choosing a branch', () => {
  const source = '\\ifnum1=1 $\\alhpa$\\fi';
  const log = errorLog(sourceContext('\\ifnum1=1 $\\alhpa', '$\\fi'));
  assert.equal(resolve(source, log).errors[0].status, 'candidate');
});

test('macro-body failure finds an included definition and retains the call site', () => {
  const source = '$\\foo$';
  const definition = '\\newcommand{\\foo}{\\alhpa+1}';
  const log = errorLog(`\\foo ->\\alhpa\n              +1\n${sourceContext('$\\foo', '$')}`);
  const result = resolve(source, log, { sources: { [ROOT]: source, '/project/macros.tex': definition } });
  exactAt(result, definition, 0, '/project/macros.tex');
  assert.deepEqual(result.errors[0].related, [{ file: ROOT, start: 1, end: 5, label: 'Macro invoked here' }]);
});

test('identical redefinitions cannot identify the executed definition', () => {
  const source = '\\def\\foo{\\alhpa}\n\\def\\foo{\\alhpa}\n$\\foo$';
  const log = errorLog(`\\foo ->\\alhpa\n              \n${sourceContext('$\\foo', '$', 3)}`, 3);
  const result = resolve(source, log);
  assert.equal(result.errors[0].status, 'candidate');
  assert.equal(result.errors[0].candidates.length, 2);
});

test('an expanded macro parameter selects the argument that actually executes', () => {
  const source = '\\newcommand{\\second}[2]{#2}\n$\\second{\\alhpa}{\\alhpa}$';
  const log = errorLog(`<argument> \\alhpa\n                  \n\\second #1#2->#2\n                 \n${sourceContext('$\\second{\\alhpa}{\\alhpa}', '$', 2)}`, 2);
  exactAt(resolve(source, log), source, 1);
});

test('a generated argument failure never chooses a same-spelled discarded token', () => {
  const source = '\\newcommand{\\second}[2]{#2}\n$\\second{\\alhpa}{\\csname alhpa\\endcsname}$';
  const log = errorLog(`<argument> \\alhpa\n                  \n\\second #1#2->#2\n                 \n${sourceContext('$\\second{\\alhpa}{\\csname alhpa\\endcsname}', '$', 2)}`, 2);
  assert.notEqual(resolve(source, log).errors[0].status, 'exact');
});

test('a partial log never converts a missing split line into an exact location', () => {
  for (const context of ['<recently read> \\alhpa', 'l.1 $\\alhpa', '<argument> ...', '<to be read again> \\alhpa']) {
    const log = './main.tex:1: Undefined control sequence.\n' + context;
    assert.equal(resolve('$\\alhpa$', log).errors[0].status, 'unresolved', context);
  }
});

test('structural errors retain their compiler message without inventing a command', () => {
  const result = resolve('$\\alhpa$', './main.tex:1: Missing } inserted.\n<inserted text> }\nl.1 abc\n');
  assert.equal(result.errors[0].kind, 'compiler-error');
  assert.equal(result.errors[0].status, 'unresolved');
  assert.equal(result.errors[0].command, undefined);
  assert.equal(result.errors[0].message, 'Missing } inserted.');
});

test('a filename from outside the snapshots never falls back to the root basename', () => {
  const log = errorLog(sourceContext('$\\alhpa', '$'), 1, '/external/main.tex');
  const result = resolve('$\\alhpa$', log);
  assert.equal(result.errors[0].status, 'unresolved');
  assert.equal(result.errors[0].reported.file, '/external/main.tex');
});

test('wrapped source paths are reconstructed from known snapshot paths', () => {
  const file = '/project/subdirectory/' + 'very-long-name-'.repeat(7) + 'included.tex';
  const source = '$\\alhpa$';
  const header = file.slice(0, 79) + '\n' + file.slice(79) + ':1: Undefined control sequence.';
  const result = resolve('', header + '\n' + sourceContext('$\\alhpa', '$'), { sources: { [ROOT]: '', [file]: source } });
  exactAt(result, source, 0, file);
});

test('a wrapped path wins over an unrelated same-basename project file', () => {
  const directory = '/external/' + 'long-directory-name'.repeat(4) + '/';
  const log = directory + '\nmain.tex:1: Undefined control sequence.\n' + sourceContext('$\\alhpa', '$');
  const result = resolve('$\\alhpa$', log);
  assert.equal(result.errors[0].reported.file, directory + 'main.tex');
  assert.notEqual(result.errors[0].status, 'exact');
});

test('print-width wrapping may split the error message itself', () => {
  const source = '$\\alhpa$';
  const log = './main.tex:1: Undefined contr\nol sequence.\n' + sourceContext('$\\alhpa', '$');
  exactAt(resolve(source, log), source);
});

test('a nested macro argument cannot be mistaken for an entire environment body', () => {
  const source = '\\begin{align*}\n\\discard{\\alhpa}\\other{generated}\n\\end{align*}';
  const log = errorLog(`<argument> \\alhpa\n                  \n\\other #1->#1\n              \n${sourceContext('\\end{align*}', '', 3)}`, 3);
  assert.notEqual(resolve(source, log).errors[0].status, 'exact');
});

test('a truncated macro stack without its source frame cannot be exact', () => {
  const source = '\\def\\foo{\\alhpa}\n$\\foo$';
  const log = errorLog('\\foo ->\\alhpa\n              ', 2);
  assert.notEqual(resolve(source, log).errors[0].status, 'exact');
});

test('inconsistent header and context line numbers cannot be exact', () => {
  const source = 'first line\n$\\alhpa$';
  const log = errorLog(sourceContext('$\\alhpa', '$', 2), 1);
  assert.notEqual(resolve(source, log).errors[0].status, 'exact');
});

test('traditional log context must not choose between identical lines in different files', () => {
  const source = '$\\alhpa$';
  const log = '(./main.tex\n(./part.tex\n! Undefined control sequence.\n' + sourceContext('$\\alhpa', '$');
  const result = resolve(source, log, { sources: { [ROOT]: source, '/project/part.tex': source } });
  assert.notEqual(result.errors[0].status, 'exact');
});

test('the source split must describe the whole line unless it is explicitly truncated', () => {
  const source = '\\AtBeginDocument{$\\alhpa$}';
  const log = '! Undefined control sequence.\n' + sourceContext('$\\alhpa', '$');
  assert.notEqual(resolve(source, log).errors[0].status, 'exact');
});

test('catcode changes downgrade even a matching command to a candidate', () => {
  const source = '\\catcode`@=11\n$\\alhpa$';
  const log = errorLog(sourceContext('$\\alhpa', '$', 2), 2);
  assert.equal(resolve(source, log).errors[0].status, 'candidate');
});

test('success and empty logs produce no diagnostics', () => {
  assert.deepEqual(resolve('\\alhpa', 'Output written on main.pdf (1 page).').errors, []);
  assert.deepEqual(resolve('', '').stats, { total: 0, exact: 0, candidate: 0, unresolved: 0, duplicates: 0 });
});
