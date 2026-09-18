'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fixtureRoot = path.join(__dirname, 'fixtures', 'real-tex');
const fixtures = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const engine = process.env.LATEX_HIGHLIGHTER_TEST_ENGINE ||
  (fs.existsSync('/Library/TeX/texbin/pdflatex') ? '/Library/TeX/texbin/pdflatex' : 'pdflatex');
const engineProbe = spawnSync(engine, ['--version'], { encoding: 'utf8', timeout: 10000 });
const engineAvailable = !engineProbe.error && engineProbe.status === 0;

function rangeKey(range) {
  return `${path.resolve(range.file)}:${range.start}:${range.end}`;
}

function assertResolved(result, fixture, sources, directory) {
  assert.ok(result && Array.isArray(result.errors), 'resolver must return an errors array');
  if (!fixture.expectCompilerError) {
    assert.deepEqual(result.errors, [], 'successful compilation must not invent errors from source tokens');
    return;
  }
  assert.ok(result.errors.length > 0, 'a failed compilation must retain its compiler error');
  const allowed = new Set(fixture.allowedExact.map(r => rangeKey({ ...r, file: path.join(directory, r.file) })));
  const exact = [];
  for (const error of result.errors) {
    assert.ok(['exact', 'candidate', 'unresolved'].includes(error.status), `unexpected status: ${error.status}`);
    if (error.status !== 'exact') continue;
    assert.ok(!fixture.noExact, `fixture requires abstention, but resolver returned exact: ${JSON.stringify(error)}`);
    assert.ok(error.range, 'exact errors must carry a source range');
    const range = error.range;
    assert.ok(path.isAbsolute(range.file), 'range filenames must be absolute');
    assert.ok(Object.hasOwn(sources, range.file), 'exact source must belong to the supplied snapshots');
    assert.ok(Number.isInteger(range.start) && Number.isInteger(range.end), 'offsets must be integers');
    assert.ok(range.start >= 0 && range.end > range.start && range.end <= sources[range.file].length, 'range must be nonempty and within the source');
    assert.equal(sources[range.file].slice(range.start, range.end), error.command, 'only the failing command may be highlighted');
    assert.ok(allowed.has(rangeKey(range)), `confident wrong location: ${JSON.stringify(error)}`);
    exact.push(rangeKey(range));
  }
  for (const required of fixture.requiredExact) {
    const key = rangeKey({ ...required, file: path.join(directory, required.file) });
    assert.ok(exact.includes(key), `missing required exact range ${key}; results: ${JSON.stringify(result.errors)}`);
  }
}

test('real pdfLaTeX compiler evidence maps to source without confident false positives', {
  skip: !engineAvailable && `pdfLaTeX is unavailable: ${engineProbe.error?.message || engineProbe.status}`,
  timeout: 180000,
}, async t => {
  const { resolveErrors } = require('../src/core.js');
  assert.equal(typeof resolveErrors, 'function');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-highlighter-real-'));
  let retainLogs = Boolean(process.env.LATEX_HIGHLIGHTER_KEEP_TEST_LOGS);
  t.after(() => {
    if (retainLogs) t.diagnostic(`Real TeX fixtures and logs retained at ${temporaryRoot}`);
    else fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  for (const fixture of fixtures) {
    if (process.env.LATEX_HIGHLIGHTER_FIXTURE && !fixture.name.includes(process.env.LATEX_HIGHLIGHTER_FIXTURE)) continue;
    await t.test(fixture.name, { timeout: 30000 }, () => {
      const directory = path.join(temporaryRoot, fixture.name);
      fs.mkdirSync(directory, { recursive: true });
      const sources = {};
      for (const relative of fixture.files) {
        const destination = path.join(directory, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const content = fs.readFileSync(path.join(fixtureRoot, fixture.name, relative));
        fs.writeFileSync(destination, content);
        sources[destination] = content.toString('utf8');
      }
      try {
        const compilation = spawnSync(engine, [
          '-interaction=nonstopmode', ...(fixture.fileLineError === false ? [] : ['-file-line-error']), '-recorder',
          '-no-shell-escape', fixture.rootFile,
        ], { cwd: directory, encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
        fs.writeFileSync(path.join(directory, 'stdout.txt'), `${compilation.stdout || ''}${compilation.stderr || ''}`);
        assert.ifError(compilation.error);
        assert.equal(compilation.signal, null, 'compiler must exit normally');
        assert.equal(compilation.status !== 0, fixture.expectCompilerError, `fixture did not produce expected compiler outcome: ${compilation.stdout}`);
        const log = fs.readFileSync(path.join(directory, fixture.rootFile.replace(/\.tex$/i, '.log')), 'utf8');
        const input = { log, rootFile: path.join(directory, fixture.rootFile), cwd: directory, sources };
        const result = resolveErrors(input);
        fs.writeFileSync(path.join(directory, 'resolved.json'), JSON.stringify(result, null, 2));
        assertResolved(result, fixture, sources, directory);
        if (fixture.recordExactCycle) {
          // A union of correct ranges can hide two records mapped in reverse.
          // Check each real compiler record independently, retaining its log prefix.
          const headers = [...log.matchAll(/^.*\.tex:\d+: Undefined control sequence\.\r?$/gm)];
          assert.ok(headers.length >= fixture.recordExactCycle.length, 'repeated-token fixture must emit both failures');
          for (let index = 0; index < headers.length; index++) {
            const expected = fixture.requiredExact[fixture.recordExactCycle[index % fixture.recordExactCycle.length]];
            const recordLog = log.slice(0, headers[0].index) + log.slice(headers[index].index, headers[index + 1]?.index);
            assertResolved(resolveErrors({ ...input, log: recordLog }), {
              ...fixture, requiredExact: [expected], allowedExact: [expected],
            }, sources, directory);
          }
        }
      } catch (error) {
        retainLogs = true;
        error.message += `\nFixture: ${directory}\n${fixture.note || ''}`;
        throw error;
      }
    });
  }
});
