'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runBuild } = require('../bin/build');

const source = '\\documentclass{article}\n\\begin{document}\n$\\alhpa+1$\n\\end{document}\n';
const errorLog = './main.tex:3: Undefined control sequence.\n<recently read> \\alhpa\n                 \nl.3 $\\alhpa\n             +1$\n\n';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latex-progress-review-')));
  const project = path.join(base, 'project');
  const out = path.join(project, 'out');
  await fs.mkdir(out, { recursive: true });
  const root = path.join(project, 'main.tex');
  const logFile = path.join(out, 'main.log');
  const recorderFile = path.join(out, 'main.fls');
  const recorder = `PWD ${project}\nINPUT main.tex\n`;
  await fs.writeFile(root, source);
  const opts = { cwd: project, projectRoot: project, rootFile: root, outDir: out,
    reportPath: path.join(out, '.latex-exact', 'report.json'), jobname: 'main' };
  const builds = [];
  t.after(async () => { await Promise.allSettled(builds); await fs.rm(base, { recursive: true, force: true }); });
  function start({ writeLog = true, duration = 1300 } = {}) {
    const body = `const fs=require('fs');fs.writeFileSync('out/main.fls',${JSON.stringify(recorder)});` +
      (writeLog ? `fs.writeFileSync('out/main.log',${JSON.stringify(errorLog)});` : '') +
      `setTimeout(()=>{process.exitCode=1},${duration});`;
    const build = runBuild({ ...opts, command: [process.execPath, '-e', body] });
    builds.push(build);
    return build;
  }
  async function report() { return JSON.parse(await fs.readFile(opts.reportPath, 'utf8')); }
  async function waitFor(predicate, timeout = 2200) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await report(); if (predicate(last)) return last; } catch { /* Publication is atomic but may not have started yet. */ }
      await pause(15);
    }
    assert.fail(`Progressive report condition did not hold: ${JSON.stringify(last)}`);
  }
  return { base, opts, logFile, recorderFile, recorder, start, report, waitFor };
}

test('an uncaptured dependency stays disqualifying when a later pass omits it from the recorder', { timeout: 5000 }, async t => {
  const h = await fixture(t);
  const dependency = path.join(h.base, 'external-macro.tex');
  await fs.writeFile(dependency, '\\newcommand{\\foo}{1}\n');
  const build = h.start();
  await h.waitFor(report => report.phase === 'streaming' && !report.stale);
  await fs.appendFile(h.recorderFile, `INPUT ${dependency}\n`);
  await h.waitFor(report => report.phase === 'streaming' && report.stale);
  // A subsequent TeX pass replaces .fls, so the original unsafe entry is absent.
  await fs.writeFile(h.recorderFile, h.recorder + 'OUTPUT main.aux\n');
  await pause(260);
  const during = await h.report();
  assert.equal(during.stale, true, 'removing a recorded dependency must not restore old evidence');
  assert.deepEqual(during.errors, []);
  const final = await build;
  assert.equal(final.report.stale, true);
  assert.match(final.report.issues.join('\n'), /New dependency requires another build/);
  await pause(100);
  assert.equal((await h.report()).phase, 'complete', 'an in-flight progressive write must not overwrite final completion');
});

test('deleting a live recorder withdraws highlights and verified recorder restoration can recover', { timeout: 5000 }, async t => {
  const h = await fixture(t);
  const build = h.start();
  await h.waitFor(report => report.phase === 'streaming' && !report.stale);
  await fs.unlink(h.recorderFile);
  const withdrawn = await h.waitFor(report => report.phase === 'streaming' && report.stale);
  assert.deepEqual(withdrawn.errors, []);
  assert.match(withdrawn.issues.join('\n'), /recorder/i);
  await fs.writeFile(h.recorderFile, h.recorder);
  const restored = await h.waitFor(report => report.phase === 'streaming' && !report.stale);
  assert.equal(restored.errors.find(error => error.status === 'exact')?.command, '\\alhpa');
  const final = await build;
  assert.equal(final.report.stale, false, JSON.stringify(final.report.issues));
  assert.equal((await h.report()).phase, 'complete');
});

test('fresh recorder output cannot make an untouched previous-build error log progressive evidence', { timeout: 5000 }, async t => {
  const h = await fixture(t);
  await fs.writeFile(h.logFile, errorLog);
  const build = h.start({ writeLog: false, duration: 650 });
  await h.waitFor(report => report.phase === 'running');
  await pause(300);
  assert.equal((await h.report()).phase, 'running');
  const final = await build;
  assert.deepEqual(final.report.errors, []);
  assert.equal(final.report.stale, true);
  assert.match(final.report.issues.join('\n'), /without a recoverable TeX error context/);
});
