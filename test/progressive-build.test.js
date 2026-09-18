'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runBuild } = require('../bin/build');

const source = '\\documentclass{article}\n\\begin{document}\n$\\alhpa+1$\n\\end{document}\n';
const errorLog = './main.tex:3: Undefined control sequence.\n<recently read> \\alhpa\n                 \nl.3 $\\alhpa\n             +1$\n\n';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latex-exact-progress-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'main.tex'), source);
  await fs.mkdir(path.join(dir, 'out'));
  const opts = { cwd: dir, projectRoot: dir, rootFile: path.join(dir, 'main.tex'),
    outDir: path.join(dir, 'out'), reportPath: path.join(dir, 'out', '.latex-exact', 'report.json'), jobname: 'main' };
  return { dir, opts };
}

async function waitForReport(opts, predicate, timeout = 2500) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { last = JSON.parse(await fs.readFile(opts.reportPath, 'utf8')); if (predicate(last)) return last; } catch {}
    await pause(15);
  }
  throw new Error(`Expected progressive report; last report: ${JSON.stringify(last)}`);
}

function command(body) {
  return [process.execPath, '-e', `const fs=require('fs');${body}`];
}
const recorder = "fs.writeFileSync('out/main.fls','PWD '+process.cwd()+'\\nINPUT main.tex\\n');";

test('publishes a confirmed error while the compiler is still running', async t => {
  const { opts } = await fixture(t);
  let finished = false;
  const build = runBuild({ ...opts, command: command(`${recorder}fs.writeFileSync('out/main.log',${JSON.stringify(errorLog)});setTimeout(()=>{process.exitCode=1},1000);`) })
    .then(result => { finished = true; return result; });
  t.after(() => build);
  const report = await waitForReport(opts, report => report.phase === 'streaming');
  assert.equal(finished, false, 'must not wait for compiler exit');
  assert.equal(report.exitCode, null);
  assert.equal(report.completedAt, null);
  assert.ok(Number.isFinite(Date.parse(report.observedAt)));
  assert.equal(report.stale, false);
  const exact = report.errors.find(error => error.status === 'exact');
  assert.equal(source.slice(exact.range.start, exact.range.end), '\\alhpa');
  const final = await build;
  assert.equal(final.report.buildId, report.buildId);
  assert.equal(final.report.phase, 'complete');
  assert.equal(final.exitCode, 1);
});

test('stdout can publish before the compiler flushes its log file', async t => {
  const { opts } = await fixture(t);
  const build = runBuild({ ...opts, command: command(`${recorder}process.stdout.write(${JSON.stringify(errorLog)});setTimeout(()=>{process.exitCode=1},900);`) });
  t.after(() => build);
  const report = await waitForReport(opts, report => report.phase === 'streaming');
  assert.equal(report.errors.find(error => error.status === 'exact')?.command, '\\alhpa');
  await assert.rejects(fs.stat(path.join(opts.outDir, 'main.log')));
  await build;
});

test('partial error context is withheld until its boundary is received', async t => {
  const { opts } = await fixture(t);
  const prefix = errorLog.slice(0, errorLog.indexOf('+1$'));
  const suffix = errorLog.slice(prefix.length);
  const build = runBuild({ ...opts, command: command(`${recorder}fs.writeFileSync('out/main.log',${JSON.stringify(prefix)});setTimeout(()=>fs.appendFileSync('out/main.log',${JSON.stringify(suffix)}),450);setTimeout(()=>{process.exitCode=1},1050);`) });
  t.after(() => build);
  await pause(300);
  assert.equal(JSON.parse(await fs.readFile(opts.reportPath, 'utf8')).phase, 'running');
  assert.equal((await waitForReport(opts, report => report.phase === 'streaming')).errors[0].command, '\\alhpa');
  await build;
});

test('source edits withdraw progressive highlights before compiler termination', async t => {
  const { opts } = await fixture(t);
  const build = runBuild({ ...opts, command: command(`${recorder}fs.writeFileSync('out/main.log',${JSON.stringify(errorLog)});setTimeout(()=>{process.exitCode=1},1300);`) });
  t.after(() => build);
  await waitForReport(opts, report => report.phase === 'streaming');
  await fs.appendFile(opts.rootFile, '% edited while compiling\n');
  const withdrawn = await waitForReport(opts, report => report.phase === 'streaming' && report.stale && report.issues.length);
  assert.equal(withdrawn.stale, true);
  assert.deepEqual(withdrawn.errors, []);
  assert.equal((await build).report.stale, true);
});

test('a missing or previous-build recorder never permits progressive highlights', async t => {
  const { opts } = await fixture(t);
  await fs.writeFile(path.join(opts.outDir, 'main.fls'), `PWD ${opts.cwd}\nINPUT main.tex\n`);
  const build = runBuild({ ...opts, command: command(`fs.writeFileSync('out/main.log',${JSON.stringify(errorLog)});setTimeout(()=>{process.exitCode=1},600);`) });
  t.after(() => build);
  await pause(400);
  assert.equal(JSON.parse(await fs.readFile(opts.reportPath, 'utf8')).phase, 'running');
  assert.equal((await build).report.stale, true);
});

test('a newly recorded external dependency withdraws a progressive confirmation', async t => {
  const { opts } = await fixture(t);
  const external = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latex-exact-progress-dep-')));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const dependency = path.join(external, 'macro.tex');
  await fs.writeFile(dependency, '\\newcommand{\\foo}{1}\n');
  const build = runBuild({ ...opts, command: command(`${recorder}fs.writeFileSync('out/main.log',${JSON.stringify(errorLog)});setTimeout(()=>{process.exitCode=1},1100);`) });
  t.after(() => build);
  await waitForReport(opts, report => report.phase === 'streaming');
  await fs.appendFile(path.join(opts.outDir, 'main.fls'), `INPUT ${dependency}\n`);
  const withdrawn = await waitForReport(opts, report => report.phase === 'streaming' && report.stale && report.issues.length);
  assert.match(withdrawn.issues.join(' '), /new dependency/);
  assert.equal((await build).report.stale, true);
});

test('final success replaces errors from an earlier compiler pass', async t => {
  const { opts } = await fixture(t);
  const build = runBuild({ ...opts, command: command(`${recorder}fs.writeFileSync('out/main.log',${JSON.stringify(errorLog)});setTimeout(()=>fs.writeFileSync('out/main.log','Successful final pass.\\n'),650);`) });
  t.after(() => build);
  await waitForReport(opts, report => report.phase === 'streaming');
  const final = await build;
  assert.equal(final.exitCode, 0);
  assert.deepEqual(final.report.errors, []);
  assert.equal(JSON.parse(await fs.readFile(opts.reportPath, 'utf8')).phase, 'complete');
});
