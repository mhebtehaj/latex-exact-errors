#!/usr/bin/env node
'use strict';

// Build the original document with its original tool; never interpret shell text.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { StringDecoder } = require('node:string_decoder');
const { resolveErrors } = require('../src/core');
const { completedErrorLog } = require('../src/stream');

const SOURCE_EXT = new Set(['.tex', '.ltx', '.sty', '.cls', '.def', '.cfg', '.clo', '.bst', '.bib']);
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '.latex-build', '.latex-exact', '.venv', 'venv', '.cache']);
const LIMITS = { files: 4096, fileBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, logBytes: 16 * 1024 * 1024 };
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(args) {
  const opts = { cwd: process.cwd() };
  let i = 0;
  for (; i < args.length && args[i] !== '--'; i += 2) {
    const key = { '--root': 'rootFile', '--project': 'projectRoot', '--out-dir': 'outDir', '--report': 'reportPath', '--cwd': 'cwd', '--jobname': 'jobname' }[args[i]];
    if (!key || args[i + 1] === undefined) throw new Error('Usage: build.js --root main.tex [--project DIR] [--out-dir DIR] -- COMMAND ARG...');
    opts[key] = args[i + 1];
  }
  opts.command = args.slice(i + 1);
  if (!opts.rootFile || !opts.command.length || args[i] !== '--') throw new Error('A root file and original build command are required.');
  opts.cwd = path.resolve(opts.cwd);
  opts.rootFile = path.resolve(opts.cwd, opts.rootFile);
  if (!fs.existsSync(opts.rootFile) && fs.existsSync(opts.rootFile + '.tex')) opts.rootFile += '.tex';
  opts.rootFile = fs.realpathSync(opts.rootFile);
  opts.projectRoot = fs.realpathSync(path.resolve(opts.cwd, opts.projectRoot || path.dirname(opts.rootFile)));
  opts.outDir = path.resolve(opts.cwd, opts.outDir || path.dirname(opts.rootFile));
  opts.reportPath = path.resolve(opts.cwd, opts.reportPath || path.join(opts.outDir, '.latex-exact', 'report.json'));
  opts.jobname ||= path.basename(opts.rootFile, path.extname(opts.rootFile));
  if (opts.jobname !== path.basename(opts.jobname) || /[\\/\0]/.test(opts.jobname)) throw new Error('Invalid job name.');
  return opts;
}

async function atomicJSON(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 }); await fsp.rename(temp, file); }
  finally { await fsp.rm(temp, { force: true }); }
}

async function withReportLock(reportPath, fn, timeoutMs = 10000) {
  const lock = `${reportPath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await fsp.mkdir(lock); await fsp.writeFile(path.join(lock, 'pid'), String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await fsp.readFile(path.join(lock, 'pid'), 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { await fsp.rm(lock, { recursive: true, force: true }); continue; } }
        }
      } catch { /* Another owner may still be creating its pid file. */ }
      if (Date.now() > deadline) throw new Error('Another report writer has not released its lock.');
      await sleep(30);
    }
  }
  try { return await fn(); } finally { await fsp.rm(lock, { recursive: true, force: true }); }
}

async function readSnapshot(file) {
  const canonical = await fsp.realpath(file);
  const before = await fsp.stat(canonical);
  if (!before.isFile() || before.size > LIMITS.fileBytes) throw new Error(`Source is not a regular file or exceeds 4 MiB: ${file}`);
  const bytes = await fsp.readFile(canonical);
  const after = await fsp.stat(canonical);
  if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size || before.ino !== after.ino) throw new Error(`Source changed while being read: ${file}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { file: canonical, text, hash: digest(bytes), mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, size: after.size, ino: after.ino };
}

function isSystemSource(file) {
  return /(?:^|\/)(?:texmf-dist|texmf-var|texmf-config)\//.test(file) || file.startsWith('/Library/TeX/');
}

async function flsInputs(file, cwd) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size > LIMITS.logBytes) return [];
    const inputs = [];
    let recorderCwd = cwd;
    for (const line of (await fsp.readFile(file, 'utf8')).split(/\r?\n/)) {
      if (line.startsWith('PWD ')) recorderCwd = path.resolve(cwd, line.slice(4));
      if (line.startsWith('INPUT ')) inputs.push(path.resolve(recorderCwd, line.slice(6)));
    }
    return inputs;
  } catch { return []; }
}

async function collectSources(opts, priorInputs, issues) {
  const snapshots = new Map();
  let bytes = 0;
  async function add(file) {
    if (!SOURCE_EXT.has(path.extname(file).toLowerCase())) return;
    try {
      const canonical = await fsp.realpath(file);
      if (snapshots.has(canonical) || isSystemSource(canonical)) return;
      if (snapshots.size >= LIMITS.files) throw new Error('Project source count exceeds the 4096-file limit.');
      const snap = await readSnapshot(canonical);
      if (bytes + snap.size > LIMITS.totalBytes) throw new Error('Project sources exceed the 32 MiB limit.');
      snapshots.set(canonical, snap); bytes += snap.size;
    } catch (error) { issues.push(error.message); }
  }
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (error) { issues.push(`Cannot inspect ${dir}: ${error.message}`); return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && file !== opts.outDir && !entry.name.startsWith('.')) await walk(file);
      } else if (entry.isFile() || entry.isSymbolicLink()) await add(file);
    }
  }
  await walk(opts.projectRoot);
  await add(opts.rootFile);
  for (const input of priorInputs) await add(input);
  return snapshots;
}

const artifactChanged = (before, after) => !before || before.mtimeMs !== after.mtimeMs ||
  before.ctimeMs !== after.ctimeMs || before.size !== after.size || before.ino !== after.ino;

// A recipe may keep running long after TeX has emitted an error. Publish the
// completed error contexts during that interval, with the same source identity
// requirements as the final report. Never treat a partly written context as EOF.
function progressiveReports({ opts, base, snapshots, changed, issues, oldLog, oldFls, activePath, output }) {
  const logFile = path.join(opts.outDir, `${opts.jobname}.log`);
  const flsFile = path.join(opts.outDir, `${opts.jobname}.fls`);
  const identities = Object.fromEntries([...snapshots].map(([file, s]) => [file, { hash: s.hash, mtimeMs: s.mtimeMs, size: s.size }]));
  // Keep all captured sources in the index: a partial recorder must not make a
  // genuinely ambiguous command look unique by omitting a later-loaded source.
  const sources = Object.fromEntries([...snapshots].filter(([file]) => path.extname(file).toLowerCase() !== '.bib').map(([file, s]) => [file, s.text]));
  let stopped = false, task = Promise.resolve(), busy = false, published = false;
  let lastInput, lastPublished, lastCheck = 0;
  let cachedLogStat, cachedLog = '', cachedTerminalSize = -1, cachedTerminalLog = '';
  let cachedFlsStat, cachedRecorder = '';

  async function publish(report) {
    const signature = JSON.stringify({ phase: report.phase, stale: report.stale, errors: report.errors, issues: report.issues });
    if (signature === lastPublished || stopped) return;
    await withReportLock(opts.reportPath, async () => {
      if (stopped) return;
      let active;
      try { active = JSON.parse(await fsp.readFile(activePath, 'utf8')); } catch { return; }
      if (active.buildId !== base.buildId) return;
      await atomicJSON(opts.reportPath, report);
      lastPublished = signature;
      published = report.phase === 'streaming';
    });
  }

  async function withdraw(reason) {
    lastInput = undefined;
    if (published) await publish({ ...base, phase: 'streaming', observedAt: new Date().toISOString(),
      sources: identities, issues: [reason] });
  }

  async function update() {
    if (stopped) return;
    if (issues.length || changed.size || output().cancelled) {
      await withdraw('Sources changed or compiler evidence became incomplete; waiting for the final build report.');
      return;
    }
    const current = output();
    let log = '';
    try {
      const stat = await fsp.stat(logFile);
      if (artifactChanged(oldLog, stat) && stat.size <= LIMITS.logBytes) {
        if (artifactChanged(cachedLogStat, stat)) {
          cachedLog = completedErrorLog(await fsp.readFile(logFile, 'utf8'));
          cachedLogStat = stat;
        }
        log = cachedLog;
      }
    } catch { /* The engine may not have flushed its log yet. */ }
    // stdout is often available before TeX flushes its buffered .log file.
    if (current.captured.length !== cachedTerminalSize) {
      cachedTerminalLog = completedErrorLog(current.captured);
      cachedTerminalSize = current.captured.length;
    }
    const terminalLog = current.truncated ? '' : cachedTerminalLog;
    if (terminalLog.length > log.length) log = terminalLog;
    if (!log) { await withdraw('The compiler has not supplied a complete error context.'); return; }

    let inputs, recorder;
    try {
      const stat = await fsp.stat(flsFile);
      if (!artifactChanged(oldFls, stat) || stat.size > LIMITS.logBytes) {
        await withdraw('No fresh recorder dependency list is available yet.'); return;
      }
      if (artifactChanged(cachedFlsStat, stat)) {
        const text = await fsp.readFile(flsFile, 'utf8');
        // Ignore a trailing partial recorder entry, just as for error contexts.
        cachedRecorder = text.slice(0, text.lastIndexOf('\n') + 1);
        cachedFlsStat = stat;
      }
      recorder = cachedRecorder;
      inputs = [];
      let cwd = opts.cwd;
      for (const line of recorder.split(/\r?\n/)) {
        if (line.startsWith('PWD ')) cwd = path.resolve(opts.cwd, line.slice(4));
        if (line.startsWith('INPUT ')) inputs.push(path.resolve(cwd, line.slice(6)));
      }
    } catch { await withdraw('The recorder dependency list is not available yet.'); return; }
    const signature = digest(log + '\0' + recorder);
    if (signature === lastInput && (!published || Date.now() - lastCheck < 500)) return;

    let rootSeen = false;
    for (const input of inputs) {
      if (!SOURCE_EXT.has(path.extname(input).toLowerCase())) continue;
      let canonical;
      try { canonical = await fsp.realpath(input); } catch {
        issues.push(`A recorded source could not be verified during compilation: ${input}`);
        await withdraw('A recorder input could not be verified.'); return;
      }
      if (canonical === opts.rootFile) rootSeen = true;
      if (!isSystemSource(canonical) && !snapshots.has(canonical)) {
        // Later latexmk passes may truncate the recorder. Once an uncaptured
        // dependency was observed, forgetting it cannot restore provenance.
        issues.push(`New dependency requires another build before exact highlighting: ${canonical}`);
        await withdraw('A new dependency requires another build before exact highlighting.'); return;
      }
    }
    if (!rootSeen) { await withdraw('The recorder does not yet identify the root source.'); return; }
    for (const [file, snap] of snapshots) {
      try {
        const currentSource = await readSnapshot(file);
        if (currentSource.hash !== snap.hash || currentSource.mtimeMs !== snap.mtimeMs ||
            currentSource.ctimeMs !== snap.ctimeMs || currentSource.ino !== snap.ino) changed.add(file);
      } catch { changed.add(file); }
    }
    lastCheck = Date.now();
    if (changed.size || output().cancelled) {
      await withdraw('Sources changed during compilation; exact highlights withheld.'); return;
    }
    if (signature === lastInput) return;
    const resolved = resolveErrors({ log, rootFile: opts.rootFile, cwd: opts.cwd, sources });
    lastInput = signature;
    if (!resolved.errors.length) return;
    await publish({ ...base, phase: 'streaming', observedAt: new Date().toISOString(), stale: false,
      sources: identities, errors: resolved.errors, stats: resolved.stats });
  }

  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    // Progressive feedback is supplementary. A failed read never fails TeX or
    // replaces the authoritative end-of-build validation below.
    task = update().catch(() => withdraw('Progressive compiler evidence could not be verified.')).catch(() => {})
      .finally(() => { busy = false; });
  }, 80);
  return { async stop() { stopped = true; clearInterval(timer); await task; } };
}

async function runBuild(opts) {
  const buildId = crypto.randomUUID();
  const reportDir = path.dirname(opts.reportPath);
  await fsp.mkdir(reportDir, { recursive: true, mode: 0o700 });
  const activePath = `${opts.reportPath}.active.json`;
  const base = { schemaVersion: 1, phase: 'running', buildId, rootFile: opts.rootFile, projectRoot: opts.projectRoot, cwd: opts.cwd, startedAt: new Date().toISOString(), completedAt: null, exitCode: null, stale: true, sources: {}, errors: [], issues: [] };
  await withReportLock(opts.reportPath, async () => { await atomicJSON(activePath, { buildId }); await atomicJSON(opts.reportPath, base); });

  // TeX writes logs and recorder files in place. Serialize wrapped compilers
  // sharing an output job, not just report publication, to bind artifacts to
  // the process that produced them. A newer queued build still clears old UI.
  const compileLockDir = path.join(opts.outDir, '.latex-exact');
  await fsp.mkdir(compileLockDir, { recursive: true, mode: 0o700 });
  const compileLock = path.join(compileLockDir, `compile-${digest(opts.jobname).slice(0, 16)}`);
  return withReportLock(compileLock, async () => {
  const issues = [];
  const flsFile = path.join(opts.outDir, `${opts.jobname}.fls`);
  const logFile = path.join(opts.outDir, `${opts.jobname}.log`);
  const priorInputs = await flsInputs(flsFile, opts.cwd);
  const snapshots = await collectSources(opts, priorInputs, issues);
  const changed = new Set();
  const watchers = [];
  // Directory watchers also catch atomic replacement of a source file.
  for (const dir of new Set([...snapshots.keys()].map((f) => path.dirname(f)))) {
    try {
      const watcher = fs.watch(dir, (event, filename) => {
        if (!filename) { changed.add(dir); return; }
        const file = path.join(dir, String(filename));
        if (SOURCE_EXT.has(path.extname(file).toLowerCase())) changed.add(file);
      });
      // Watchers are supplementary: network mounts and macOS can refuse them.
      // Hash, ctime, mtime and inode are always checked before and after TeX.
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch { /* Full source verification below remains authoritative. */ }
  }
  // Recheck after watcher attachment, closing the initial snapshot/watch race.
  for (const [file, snap] of snapshots) {
    try { const now = await readSnapshot(file); if (now.hash !== snap.hash || now.mtimeMs !== snap.mtimeMs || now.ctimeMs !== snap.ctimeMs || now.ino !== snap.ino) changed.add(file); }
    catch { changed.add(file); }
  }
  let oldLog;
  try { oldLog = await fsp.stat(logFile); } catch { /* A first build has no log. */ }
  let oldFls;
  try { oldFls = await fsp.stat(flsFile); } catch { /* Recorder not yet created. */ }
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  let captured = '', captureBytes = 0, truncated = false, cancelled = false;
  let exitCode = 127, spawnError;
  const child = spawn(opts.command[0], opts.command.slice(1), { cwd: opts.cwd, env: process.env, shell: false, detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'] });
  const forward = (signal) => {
    cancelled = true;
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Process already stopped. */ }
  };
  const onInt = () => forward('SIGINT'), onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const capture = (data, stream, decoder) => {
    stream.write(data);
    captureBytes += data.length;
    if (captureBytes <= LIMITS.logBytes) captured += decoder.write(data); else truncated = true;
  };
  child.stdout.on('data', (data) => capture(data, process.stdout, decoders.stdout));
  child.stderr.on('data', (data) => capture(data, process.stderr, decoders.stderr));
  const progressive = progressiveReports({ opts, base, snapshots, changed, issues, oldLog, oldFls, activePath,
    output: () => ({ captured, truncated, cancelled }) });
  await new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => { exitCode = code === null ? 128 + (os.constants.signals[signal] || 1) : code; resolve(); });
  });
  captured += decoders.stdout.end() + decoders.stderr.end();
  // Await any in-flight progressive write before publishing the final report.
  await progressive.stop();
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  if (spawnError) { issues.push(`Could not launch compiler: ${spawnError.message}`); exitCode = 127; }

  let log = captured;
  try {
    const newLog = await fsp.stat(logFile);
    const fresh = !oldLog || newLog.mtimeMs !== oldLog.mtimeMs || newLog.ctimeMs !== oldLog.ctimeMs || newLog.size !== oldLog.size || newLog.ino !== oldLog.ino;
    if (fresh) {
      if (newLog.size > LIMITS.logBytes) { issues.push('Compiler log exceeds the 16 MiB limit.'); log = ''; }
      else log = await fsp.readFile(logFile, 'utf8');
    } else if (exitCode === 0) log = '';
  } catch { /* stdout may contain usable errors even without a .log file. */ }
  if (truncated && log === captured) { issues.push('Compiler output was truncated.'); log = ''; }

  let currentInputs = [];
  try {
    const newFls = await fsp.stat(flsFile);
    if (!oldFls || newFls.mtimeMs !== oldFls.mtimeMs || newFls.ctimeMs !== oldFls.ctimeMs || newFls.size !== oldFls.size || newFls.ino !== oldFls.ino) currentInputs = await flsInputs(flsFile, opts.cwd);
  } catch { /* Compiler did not write a recorder. */ }
  const usedSources = new Set([opts.rootFile]);
  for (const input of currentInputs) {
    if (!SOURCE_EXT.has(path.extname(input).toLowerCase())) continue;
    try {
      const canonical = await fsp.realpath(input);
      usedSources.add(canonical);
      if (!isSystemSource(canonical) && !snapshots.has(canonical)) issues.push(`New dependency requires another build before exact highlighting: ${canonical}`);
    } catch { /* Missing dependencies are described by the compiler. */ }
  }
  for (const [file, snap] of snapshots) {
    try { const now = await readSnapshot(file); if (now.hash !== snap.hash || now.mtimeMs !== snap.mtimeMs || now.ctimeMs !== snap.ctimeMs || now.ino !== snap.ino) changed.add(file); }
    catch { changed.add(file); }
  }
  for (const watcher of watchers) watcher.close();
  if (changed.size) issues.push('Sources changed during compilation; exact highlights withheld.');
  if (cancelled) issues.push('Build was cancelled.');
  let resolved = { errors: [], stats: {} };
  try { resolved = resolveErrors({ log, rootFile: opts.rootFile, cwd: opts.cwd, sources: Object.fromEntries([...snapshots].filter(([f]) => path.extname(f).toLowerCase() !== '.bib' && (!currentInputs.length || usedSources.has(f))).map(([f, snap]) => [f, snap.text])) }); }
  catch (error) { issues.push(`Error resolver failed: ${error.message}`); }
  if (resolved.errors.length && !currentInputs.length) issues.push('No fresh recorder dependency list was produced; exact highlights withheld. Enable the compiler recorder and rebuild.');
  if (exitCode !== 0 && !resolved.errors.length) issues.push('The build failed without a recoverable TeX error context; see the original compiler output.');
  const report = { ...base, phase: 'complete', completedAt: new Date().toISOString(), exitCode, stale: cancelled || changed.size > 0 || issues.length > 0, sources: Object.fromEntries([...snapshots].map(([f, s]) => [f, { hash: s.hash, mtimeMs: s.mtimeMs, size: s.size }])), errors: resolved.errors, stats: resolved.stats, issues: [...new Set(issues)] };
  await withReportLock(opts.reportPath, async () => {
    let active;
    try { active = JSON.parse(await fsp.readFile(activePath, 'utf8')); } catch { return; }
    if (active.buildId === buildId) await atomicJSON(opts.reportPath, report);
  });
  return { exitCode, report, reportPath: opts.reportPath };
  }, 300000);
}

if (require.main === module) {
  (async () => {
    const result = await runBuild(parseArgs(process.argv.slice(2)));
    process.exitCode = result.exitCode;
  })().catch((error) => { console.error(`[LaTeX Exact] ${error.message}`); process.exitCode = 1; });
}

module.exports = { runBuild, parseArgs, readSnapshot, collectSources, atomicJSON, withReportLock, flsInputs, LIMITS };
