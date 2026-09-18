'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { completedErrorLog } = require('../src/stream');
const { resolveErrors } = require('../src/core');

const HEADER = './main.tex:1: Undefined control sequence.\n';
const CONTEXT = '<recently read> \\alhpa\n                       \nl.1 $\\alhpa\n           +1$\n';
const PREFIX = '(./main.tex\n';
const RECORD = HEADER + CONTEXT;

test('withholds every partial context and waits for a completed boundary line', () => {
  for (let cut = 0; cut <= RECORD.length; cut++) assert.equal(completedErrorLog(PREFIX + RECORD.slice(0, cut)), '');
  assert.equal(completedErrorLog(PREFIX + RECORD + '\n'), PREFIX + RECORD);
  assert.equal(completedErrorLog(PREFIX + RECORD + 'The control sequence at the end'), '');
  assert.equal(completedErrorLog(PREFIX + RECORD + 'The control sequence at the end of the top line\n'), PREFIX + RECORD);
});

test('keeps earlier completed errors while the newest context is still arriving', () => {
  const completed = PREFIX + RECORD;
  const middle = '\n(./included.tex\n';
  for (let cut = 0; cut <= RECORD.length; cut++) assert.equal(completedErrorLog(completed + middle + RECORD.slice(0, cut)), completed);
  assert.equal(completedErrorLog(completed + middle + RECORD + '\n'), completed + middle + RECORD);
});

test('preserves source-file stack text before and between complete errors', () => {
  const log = PREFIX + '(./parts/first.tex\n' + RECORD + '\n)\n(./parts/second.tex\n' + RECORD + '\n';
  const safe = completedErrorLog(log);
  assert.equal(safe, log.slice(0, -1));
  assert.ok(safe.includes(')\n(./parts/second.tex'));
});

test('waits across hard-wrapped source prefix and suffix lines', () => {
  const prefix = HEADER + 'l.1 ' + 'x'.repeat(70) + '\n' + 'continued \\alhpa\n';
  const suffix = ' '.repeat(50) + 'right-hand-side-that-wraps'.repeat(3) + '\n';
  assert.equal(completedErrorLog(prefix + suffix), '');
  assert.equal(completedErrorLog(prefix + suffix + 'continued source text\n'), '');
  assert.equal(completedErrorLog(prefix + suffix + 'continued source text\n\n'), prefix + suffix + 'continued source text\n');
});

test('a whitespace-only physical continuation is not mistaken for a record boundary', () => {
  const log = HEADER + 'l.1 \\alhpa\n' + ' '.repeat(79) + '\n' + ' '.repeat(79) + '\n';
  assert.equal(completedErrorLog(log), '');
  assert.equal(completedErrorLog(log + 'right side\n\n'), log + 'right side\n');
});

test('a later expansion frame invalidates a purported source-frame fragment', () => {
  const log = RECORD + '\\foo -> further expansion\n                            text\n\n';
  assert.equal(completedErrorLog(log), '');
});

test('non-error source-like output never starts a record', () => {
  assert.equal(completedErrorLog('l.1 $\\alhpa\n            $\n\n'), '');
  assert.equal(completedErrorLog('Package demo Warning: text\nl.1 $\\alhpa\n            $\n\n'), '');
});

test('traditional and wrapped file-line headers can start complete contexts', () => {
  for (const header of ['! Undefined control sequence.\n', '/very/long/source/ma\nin.tex:1: Undefined contr\nol sequence.\n']) {
    const record = PREFIX + header + CONTEXT;
    assert.equal(completedErrorLog(record + '\n'), record);
  }
});

test('fatal halt-on-error header confirms the preceding error without including an incomplete fatal record', () => {
  const fatal = './main.tex:1:  ==> Fatal error occurred, no output PDF file produced!\n';
  assert.equal(completedErrorLog(PREFIX + RECORD + fatal), PREFIX + RECORD);
});

test('split CRLF and split UTF-8 bytes remain incomplete until decoded line boundaries arrive', () => {
  const input = (PREFIX + RECORD.replace('$\\alhpa', '😀$\\alhpa') + '\n').replace(/\n/g, '\r\n');
  const decoder = new StringDecoder('utf8');
  let decoded = '';
  let previous = '';
  for (const byte of Buffer.from(input)) {
    decoded += decoder.write(Buffer.from([byte]));
    const safe = completedErrorLog(decoded);
    assert.ok(safe.startsWith(previous));
    assert.ok(!safe.includes('\ufffd'));
    if (decoded.endsWith('\r')) assert.equal(safe, previous);
    previous = safe;
  }
  assert.equal(previous, input.slice(0, -2));
});

test('empty, newline-free, and invalid inputs fail safely', () => {
  assert.equal(completedErrorLog(''), '');
  assert.equal(completedErrorLog(HEADER.trimEnd()), '');
  assert.throws(() => completedErrorLog(null), TypeError);
});

const engine = process.env.LATEX_HIGHLIGHTER_TEST_ENGINE ||
  (fs.existsSync('/Library/TeX/texbin/pdflatex') ? '/Library/TeX/texbin/pdflatex' : 'pdflatex');
const probe = spawnSync(engine, ['--version'], { encoding: 'utf8', timeout: 10000 });

test('chunked real TeX output never introduces an exact range absent from the full transcript', {
  skip: Boolean(probe.error || probe.status !== 0), timeout: 30000,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-stream-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtureRoot = path.join(__dirname, 'fixtures', 'real-tex');
  for (const name of ['inline', 'align-repeated', 'macro-definition', 'unicode-and-tabs']) {
    const cwd = path.join(root, name);
    fs.mkdirSync(cwd);
    const rootFile = path.join(cwd, 'main.tex');
    const source = fs.readFileSync(path.join(fixtureRoot, name, 'main.tex'), 'utf8');
    fs.writeFileSync(rootFile, source);
    const result = spawnSync(engine, ['-interaction=nonstopmode', '-file-line-error', '-no-shell-escape', 'main.tex'],
      { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    const input = { rootFile, cwd, sources: { [rootFile]: source } };
    for (const transcript of [result.stdout, fs.readFileSync(path.join(cwd, 'main.log'), 'utf8')]) {
      const final = resolveErrors({ ...input, log: transcript });
      const expected = new Set(final.errors.filter(e => e.status === 'exact').map(e => `${e.range.file}:${e.range.start}:${e.range.end}`));
      assert.ok(expected.size > 0);
      const observed = new Set();
      let previous = '';
      // Fixed small chunks plus every byte around source-frame ends exercise
      // mid-token, mid-CRLF, and mid-context cuts without quadratic test work.
      const cuts = new Set([transcript.length]);
      for (let cut = 0; cut < transcript.length; cut += 17) cuts.add(cut);
      for (const match of transcript.matchAll(/^l\.\d+.*\n.*\n/gm)) {
        for (let cut = match.index; cut <= match.index + match[0].length; cut++) cuts.add(cut);
      }
      for (const cut of [...cuts].sort((a, b) => a - b)) {
        const safe = completedErrorLog(transcript.slice(0, cut));
        assert.ok(safe.startsWith(previous), `${name}: prefix must grow monotonically`);
        if (safe === previous) continue;
        previous = safe;
        for (const error of resolveErrors({ ...input, log: safe }).errors) {
          if (error.status !== 'exact') continue;
          const key = `${error.range.file}:${error.range.start}:${error.range.end}`;
          assert.ok(expected.has(key), `${name}: progressive exact range differs from final evidence`);
          observed.add(key);
        }
      }
      assert.deepEqual(observed, expected, `${name}: complete records should publish all final exact locations`);
    }
  }
});
