'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runBuild, parseArgs } = require('../bin/build');

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latex-exact-build-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = '\\documentclass{article}\n\\begin{document}\n$\\alhpa+1$\n\\end{document}\n';
  await fs.writeFile(path.join(dir, 'main.tex'), source);
  await fs.mkdir(path.join(dir, 'out'));
  const opts = { cwd: dir, projectRoot: dir, rootFile: path.join(dir, 'main.tex'), outDir: path.join(dir, 'out'), reportPath: path.join(dir, 'out', '.latex-exact', 'report.json'), jobname: 'main' };
  return { dir, source, opts };
}
const errorLog = './main.tex:3: Undefined control sequence.\n<recently read> \\alhpa\n                 \nl.3 $\\alhpa\n             +1$\n';
function fakeCompiler(extra = '', code = 1) {
  return [process.execPath, '-e', `const fs=require('fs');fs.writeFileSync('out/main.fls','PWD '+process.cwd()+'\\nINPUT main.tex\\n');${extra};fs.writeFileSync('out/main.log',${JSON.stringify(errorLog)});process.exitCode=${code}`];
}
test('a failed compiler still publishes complete exact report and preserves exit status', async (t) => {
  const { opts, source } = await fixture(t);
  const result = await runBuild({ ...opts, command: fakeCompiler() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.phase, 'complete');
  assert.equal(result.report.stale, false, JSON.stringify(result.report.issues));
  const exact = result.report.errors.find((e) => e.status === 'exact');
  assert.ok(exact, JSON.stringify(result.report.errors));
  assert.equal(source.slice(exact.range.start, exact.range.end), '\\alhpa');
});
test('successful no-op build clears previous errors instead of reusing old log', async (t) => {
  const { opts } = await fixture(t);
  await runBuild({ ...opts, command: fakeCompiler() });
  const result = await runBuild({ ...opts, command: [process.execPath, '-e', 'process.exit(0)'] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.stale, false);
  assert.deepEqual(result.report.errors, []);
});
test('source change while the compiler runs invalidates its result', async (t) => {
  const { opts } = await fixture(t);
  const result = await runBuild({ ...opts, command: fakeCompiler("fs.appendFileSync('main.tex','%changed\\n')") });
  assert.equal(result.report.stale, true);
  assert.match(result.report.issues.join(' '), /changed during compilation/);
});
test('edit and restore source during build is still considered stale', async (t) => {
  const { opts } = await fixture(t);
  const result = await runBuild({ ...opts, command: fakeCompiler("const old=fs.readFileSync('main.tex');fs.appendFileSync('main.tex','%temporary');fs.writeFileSync('main.tex',old)") });
  assert.equal(result.report.stale, true);
});
test('new external user dependency abstains until a subsequent captured build', async (t) => {
  const { opts } = await fixture(t);
  const external = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latex-exact-external-')));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const macro = path.join(external, 'macros.tex');
  await fs.writeFile(macro, '\\newcommand{\\foo}{1}');
  const compiler = fakeCompiler(`fs.writeFileSync('out/main.fls',${JSON.stringify(`INPUT ${macro}\n`)})`);
  assert.equal((await runBuild({ ...opts, command: compiler })).report.stale, true);
  assert.equal((await runBuild({ ...opts, command: compiler })).report.stale, false);
});
test('an older build finishing last cannot replace a newer build report', async (t) => {
  const { opts } = await fixture(t);
  const older = runBuild({ ...opts, command: [process.execPath, '-e', 'setTimeout(()=>process.exit(0),300)'] });
  await new Promise((r) => setTimeout(r, 80));
  const newer = await runBuild({ ...opts, command: [process.execPath, '-e', 'process.exit(0)'] });
  await older;
  const persisted = JSON.parse(await fs.readFile(opts.reportPath, 'utf8'));
  assert.equal(persisted.buildId, newer.report.buildId);
});
test('missing compiler publishes failure, never a hanging running report', async (t) => {
  const { opts } = await fixture(t);
  const result = await runBuild({ ...opts, command: [path.join(opts.cwd, 'does-not-exist')] });
  assert.equal(result.exitCode, 127);
  assert.equal(result.report.phase, 'complete');
  assert.equal(result.report.stale, true);
});
test('command arguments are passed literally without shell expansion', async (t) => {
  const { opts } = await fixture(t);
  const literal = '$(touch DANGEROUS) `touch BAD` spaces';
  const result = await runBuild({ ...opts, command: [process.execPath, '-e', "require('fs').writeFileSync('args.json',JSON.stringify(process.argv.slice(1)))", literal] });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(opts.cwd, 'args.json'))), [literal]);
  await assert.rejects(fs.stat(path.join(opts.cwd, 'DANGEROUS')));
});
test('argument parsing accepts extensionless root and rejects unsafe job names', async (t) => {
  const { opts } = await fixture(t);
  assert.equal(parseArgs(['--cwd', opts.cwd, '--root', 'main', '--', process.execPath]).rootFile, opts.rootFile);
  assert.throws(() => parseArgs(['--cwd', opts.cwd, '--root', 'main', '--jobname', '../bad', '--', process.execPath]), /job name/);
});

test('a compiler error without any recorder withholds exact presentation', async (t) => {
  const { opts } = await fixture(t);
  const command = [process.execPath, '-e', `require('fs').writeFileSync('out/main.log',${JSON.stringify(errorLog)});process.exitCode=1`];
  const result = await runBuild({ ...opts, command });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.phase, 'complete');
  assert.equal(result.report.stale, true);
  assert.match(result.report.issues.join(' '), /fresh recorder dependency list/);
  assert.ok(result.report.errors.length, 'retain compiler information even when the source set cannot be trusted');
});

test('a previous recorder is not mistaken for this failed build dependency evidence', async (t) => {
  const { opts } = await fixture(t);
  await runBuild({ ...opts, command: fakeCompiler() });
  const result = await runBuild({ ...opts, command: [process.execPath, '-e',
    `require('fs').writeFileSync('out/main.log',${JSON.stringify(errorLog)});process.exitCode=1`] });
  assert.equal(result.report.stale, true);
  assert.match(result.report.issues.join(' '), /fresh recorder dependency list/);
});

test('fresh recorder PWD resolves outside-project relative dependencies correctly', async (t) => {
  const { opts } = await fixture(t);
  const external = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'latex-exact-recorder-pwd-')));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const macro = path.join(external, 'macros with spaces.tex');
  await fs.writeFile(macro, '\\newcommand{\\externalformula}{1}\n');
  const recorder = `PWD ${external}\nINPUT macros with spaces.tex\nINPUT ${opts.rootFile}\n`;
  const compiler = fakeCompiler(`fs.writeFileSync('out/main.fls',${JSON.stringify(recorder)})`);
  const first = await runBuild({ ...opts, command: compiler });
  assert.equal(first.report.stale, true);
  assert.ok(first.report.issues.some(issue => issue.includes(macro)), JSON.stringify(first.report.issues));
  const second = await runBuild({ ...opts, command: compiler });
  assert.equal(second.report.stale, false, JSON.stringify(second.report.issues));
  assert.ok(Object.hasOwn(second.report.sources, macro), 'second build must snapshot the actual recorder-relative dependency');
});

test('overlapping builds sharing an output job cannot consume each other compiler artifacts', async (t) => {
  const { opts } = await fixture(t);
  const source = '\\documentclass{article}\n\\begin{document}\n$\\alhpa+\\betaa$\n\\end{document}\n';
  await fs.writeFile(opts.rootFile, source);
  const firstLog = './main.tex:3: Undefined control sequence.\nl.3 $\\alhpa\n             +\\betaa$\n';
  const secondLog = './main.tex:3: Undefined control sequence.\nl.3 $\\alhpa+\\betaa\n                     $\n';
  const command = (name, log, beforeWrite, afterWrite) => [process.execPath, '-e', `
    const fs=require('fs');
    fs.appendFileSync('events.ndjson',${JSON.stringify(name + ':start\n')});
    fs.writeFileSync(${JSON.stringify(name + '-started.txt')},'ready');
    setTimeout(()=>{
      fs.writeFileSync('out/main.fls','PWD '+process.cwd()+'\\nINPUT main.tex\\n');
      fs.writeFileSync('out/main.log',${JSON.stringify(log)});
      setTimeout(()=>{fs.appendFileSync('events.ndjson',${JSON.stringify(name + ':end\n')});process.exitCode=1},${afterWrite});
    },${beforeWrite});
  `];
  const first = runBuild({ ...opts, command: command('first', firstLog, 120, 120) });
  const deadline = Date.now() + 5000;
  while (true) {
    try { await fs.stat(path.join(opts.cwd, 'first-started.txt')); break; } catch { /* Wait for actual compiler launch. */ }
    assert.ok(Date.now() < deadline, 'first compiler did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Different reports still share TeX's output job and therefore require one compile lock.
  const second = runBuild({ ...opts, reportPath: path.join(path.dirname(opts.reportPath), 'second-report.json'),
    command: command('second', secondLog, 0, 360) });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  for (const result of [firstResult, secondResult]) {
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.stale, false, JSON.stringify(result.report.issues));
  }
  assert.equal(firstResult.report.errors.find(error => error.status === 'exact')?.command, '\\alhpa');
  assert.equal(secondResult.report.errors.find(error => error.status === 'exact')?.command, '\\betaa');
  const events = (await fs.readFile(path.join(opts.cwd, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});
