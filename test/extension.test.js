'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createController, validateReport } = require('../src/extension');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const disposable = () => ({ dispose() {} });
function emitter() {
  const listeners = new Set();
  return { event(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
    fire(value) { for (const callback of listeners) callback(value); } };
}
function uri(file) {
  return { scheme: 'file', fsPath: file, fragment: '', with(value) { return { ...this, ...value }; },
    toString() { return `file://${encodeURI(this.fsPath)}${this.fragment ? `#${this.fragment}` : ''}`; } };
}
function document(file, text) {
  return { uri: uri(file), isDirty: false, text, getText() { return this.text; },
    positionAt(offset) { const lines = this.text.slice(0, offset).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length }; },
    offsetAt(position) { return this.text.split('\n').slice(0, position.line).reduce((n, line) => n + line.length + 1, 0) + position.character; } };
}

async function harness(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-exact-extension-'));
  const source = path.join(dir, 'main.tex');
  const reportPath = path.join(dir, options.outDirName || '.latex-build', '.latex-exact', 'report.json');
  const text = options.text || '😀 test\n$\\alhpa+1$\n';
  await fs.writeFile(source, text);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  const doc = document(source, text);
  const decorations = [];
  const output = [];
  const commands = new Map();
  const events = Object.fromEntries(['text', 'open', 'close', 'visible', 'config', 'trust', 'create', 'change', 'delete', 'diagnostics'].map(name => [name, emitter()]));
  const metrics = { discoveries: 0 };
  let hoverProvider;
  const editor = { document: doc, setDecorations(type, values) {
    if (type.kind === 'structure') this.structuralDecorations = values;
    else { this.decorations = values; decorations.push(values); }
  }, revealRange() {} };
  class MarkdownString {
    constructor() { this.value = ''; this.segments = []; }
    appendText(value) { this.segments.push({ type: 'text', value }); this.value += value; return this; }
    appendMarkdown(value) { this.segments.push({ type: 'markdown', value }); this.value += value; return this; }
  }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  const vscode = {
    workspace: {
      isTrusted: options.trusted !== false, textDocuments: [doc], workspaceFolders: [{ uri: uri(dir) }],
      getConfiguration(section) { return { get(name, fallback) {
        return options.settings?.[`${section}.${name}`] ?? (section === 'latexExact' && name === 'reportPaths' && options.explicit ? [reportPath] : fallback);
      } }; },
      async findFiles(pattern, exclude) { metrics.discoveries++; assert.equal(exclude, null); return options.explicit || options.hideDiscovery ? [] : [uri(reportPath)]; },
      onDidChangeTextDocument: events.text.event, onDidOpenTextDocument: events.open.event,
      onDidCloseTextDocument: events.close.event,
      onDidChangeConfiguration: events.config.event, onDidGrantWorkspaceTrust: events.trust.event,
      createFileSystemWatcher() { return { dispose() {}, onDidCreate: events.create.event, onDidChange: events.change.event, onDidDelete: events.delete.event }; },
      async openTextDocument(fileUri) { return this.textDocuments.find(value => value.uri.fsPath === fileUri.fsPath); }
    },
    window: {
      visibleTextEditors: [editor], createTextEditorDecorationType: options => ({ ...disposable(), kind: options.color === '#b87900' ? 'structure' : 'compiler' }),
      createOutputChannel() { return { dispose() {}, clear() { output.length = 0; }, appendLine(value) { output.push(value); }, show() {} }; },
      onDidChangeVisibleTextEditors: events.visible.event,
      async showTextDocument() { return editor; }
    },
    languages: { onDidChangeDiagnostics: events.diagnostics.event,
      registerHoverProvider(selector, provider) { hoverProvider = provider; return disposable(); } },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return disposable(); } },
    Uri: { file: uri }, Range, Selection: Range, MarkdownString,
    Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
    DecorationRangeBehavior: { ClosedClosed: 1 }, TextEditorRevealType: { InCenterIfOutsideViewport: 1 }
  };
  let clock = Date.parse('2026-09-15T12:00:00Z');
  const io = options.io ? options.io(fs, source, reportPath) : fs;
  const controller = createController(vscode, { fs: io, now: () => clock, pollInterval: options.pollInterval ?? 0,
    sourceCheckInterval: options.sourceCheckInterval,
    setInterval: options.setInterval, clearInterval: options.clearInterval,
    analyzeStructure: options.analyzeStructure });
  t.after(async () => { controller.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  async function makeReport(overrides = {}) {
    const stat = await fs.stat(source);
    const content = await fs.readFile(source);
    const start = content.toString('utf8').indexOf('\\alhpa');
    return { schemaVersion: 1, buildId: 'build-1', rootFile: source, projectRoot: dir, cwd: dir,
      phase: 'complete', startedAt: new Date(clock - 100).toISOString(), completedAt: new Date(clock).toISOString(),
      exitCode: 1, stale: false, sources: { [source]: { hash: digest(content), mtimeMs: stat.mtimeMs, size: stat.size } },
      errors: [{ id: 'error-1', kind: 'undefined-command', command: '\\alhpa', message: 'Undefined control sequence.',
        reported: { file: source, line: 2 }, status: 'exact', range: { file: source, start, end: start + 6 },
        candidates: [], related: [], evidence: ['The compiler identified \\alhpa.'] }], issues: [], ...overrides };
  }
  async function write(report) { await fs.writeFile(reportPath, JSON.stringify(report)); }
  return { dir, source, reportPath, text, doc, editor, vscode, events, controller, makeReport, write,
    output, commands, decorations, metrics, hover: () => hoverProvider, advance(ms = 1000) { clock += ms; } };
}

test('highlights only an exact UTF-16 command range, with safe evidence hover and navigation', async t => {
  const h = await harness(t);
  const report = await h.makeReport();
  report.errors[0].message = 'Undefined [click](command:evil) <script>.';
  report.errors[0].related.push({ file: h.source, start: 0, end: 2, label: 'Invocation [bad](command:evil)' });
  await h.write(report);
  h.controller.start();
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  assert.deepEqual(h.editor.decorations[0].range.start, { line: 1, character: 1 });
  assert.deepEqual(h.editor.decorations[0].range.end, { line: 1, character: 7 });
  const hover = h.editor.decorations[0].hoverMessage;
  assert.equal(hover.isTrusted, false);
  assert.equal(hover.supportHtml, false);
  assert.ok(hover.segments.filter(value => value.type === 'markdown').every(value => value.value.includes('(file://')));
  assert.ok(h.hover().provideHover(h.doc, { line: 0, character: 1 }));
  await h.controller.nextError();
  assert.deepEqual(h.editor.selection.start, { line: 1, character: 1 });
  assert.equal(h.commands.has('latexExact.showDetails'), true);
});

test('ambiguous and unresolved errors remain visible in details without decorations', async t => {
  const h = await harness(t);
  const report = await h.makeReport();
  const error = report.errors[0];
  error.status = 'candidate'; error.candidates = [error.range]; delete error.range;
  await h.write(report);
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  h.controller.showDetails();
  assert.match(h.output.join('\n'), /\[candidate\]/);
  assert.match(h.output.join('\n'), /Candidate:/);
  assert.match(h.output.join('\n'), /does not establish one source occurrence/);
});

test('an unresolved compiler error without a source line preserves other exact errors', async t => {
  const h = await harness(t);
  const report = await h.makeReport();
  report.errors.push({ id: 'structural', kind: 'compiler-error', message: 'Emergency stop.',
    reported: { file: h.source, line: null }, status: 'unresolved', candidates: [], related: [], evidence: [] });
  await h.write(report); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  h.controller.showDetails();
  assert.match(h.output.join('\n'), /no source line/);
});

test('unsaved source edits clear highlights immediately and undo cannot revive the old build', async t => {
  const h = await harness(t);
  await h.write(await h.makeReport());
  h.controller.start(); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  h.doc.isDirty = true; h.doc.text += ' ';
  h.events.text.fire({ document: h.doc, contentChanges: [{ text: ' ' }] });
  assert.equal(h.editor.decorations.length, 0);
  h.doc.isDirty = false; h.doc.text = h.text;
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  h.advance();
  await h.write(await h.makeReport({ buildId: 'build-2' }));
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact[0].buildId, 'build-2');
});

test('a running build clears a previous completion and superseded historical reports stay ignored', async t => {
  const h = await harness(t);
  await h.write(await h.makeReport()); await h.controller.refresh();
  h.advance();
  await h.write(await h.makeReport({ buildId: 'build-2', phase: 'running', completedAt: undefined, exitCode: null }));
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /in progress/);
  await h.write(await h.makeReport({ buildId: 'build-1', startedAt: '2026-09-15T11:59:59Z' }));
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /older build/);
});

test('a dirty document or clean in-memory mismatch is never decorated', async t => {
  const h = await harness(t);
  await h.write(await h.makeReport());
  h.doc.isDirty = true;
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /Unsaved/);
  h.doc.isDirty = false; h.doc.text += 'x'; h.advance();
  await h.write(await h.makeReport({ buildId: 'build-2' }));
  await h.controller.refresh();
  assert.match(h.controller.getState().status, /Open document differs/);
});

test('all known dependencies must match, including files without a TeX extension', async t => {
  const h = await harness(t);
  const dependency = path.join(h.dir, 'macros.input');
  await fs.writeFile(dependency, 'old');
  const report = await h.makeReport();
  report.sources[dependency] = { hash: digest('old'), mtimeMs: (await fs.stat(dependency)).mtimeMs, size: 3 };
  await h.write(report);
  h.controller.start(); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  await fs.writeFile(dependency, 'new');
  h.events.change.fire(uri(dependency));
  assert.equal(h.controller.getState().exact.length, 0);
  h.advance(); await h.write({ ...report, buildId: 'build-2', startedAt: new Date(Date.parse(report.startedAt) + 1000).toISOString() });
  await h.controller.refresh();
  assert.match(h.controller.getState().status, /Source changed/);
});

test('source hash checks detect disk changes without a watcher notification', async t => {
  const h = await harness(t);
  await h.write(await h.makeReport()); await h.controller.refresh();
  await fs.writeFile(h.source, h.text.replace('+1', '+2'));
  h.doc.text = h.text.replace('+1', '+2');
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /Source changed/);
});

test('configured reports work when discovery and filesystem watchers exclude the build directory', async t => {
  const h = await harness(t, { explicit: true });
  await h.write(await h.makeReport()); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  h.advance(); await h.write(await h.makeReport({ buildId: 'done', errors: [], exitCode: 0 }));
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /0 compiler error/);
});

test('symlinked workspace and editor paths match canonical compiler source paths', async t => {
  const h = await harness(t);
  const aliasParent = await fs.mkdtemp(path.join(os.tmpdir(), 'latex-exact-alias-'));
  t.after(() => fs.rm(aliasParent, { recursive: true, force: true }));
  const alias = path.join(aliasParent, 'project');
  await fs.symlink(h.dir, alias, 'dir');
  const realSource = await fs.realpath(h.source);
  const realRoot = path.dirname(realSource);
  const report = await h.makeReport();
  report.rootFile = realSource; report.projectRoot = realRoot; report.cwd = realRoot;
  report.sources = { [realSource]: report.sources[h.source] };
  report.errors[0].reported.file = realSource; report.errors[0].range.file = realSource;
  h.vscode.workspace.workspaceFolders = [{ uri: uri(alias) }];
  h.doc.uri = uri(path.join(alias, 'main.tex'));
  await h.write(report); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  assert.equal(h.editor.decorations.length, 1);
  h.doc.isDirty = true; h.advance();
  await h.write({ ...report, buildId: 'new', startedAt: '2026-09-15T12:00:01Z' });
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /Unsaved/);
});

test('untrusted workspaces never read a report or decorate source', async t => {
  let reads = 0;
  const h = await harness(t, { trusted: false, io: real => ({ stat: real.stat,
    async readFile(...args) { reads++; return real.readFile(...args); } }) });
  await h.write(await h.makeReport()); await h.controller.refresh();
  assert.equal(reads, 0);
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /trusted workspace/);
});

test('a source edit while asynchronous hashing is pending cancels publication', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { io: (real, source) => ({ stat: real.stat,
    async readFile(file) { if (file === source) { entered(); await gate; } return real.readFile(file); } }) });
  await h.write(await h.makeReport());
  const pending = h.controller.refresh();
  await began;
  h.controller.invalidate('Source edited.');
  release(); await pending;
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /Source edited/);
});

test('a superseding refresh wins over an earlier validation that finishes later', async t => {
  let release;
  let entered;
  let sourceReads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { io: (real, source) => ({ stat: real.stat,
    async readFile(file) { if (file === source && sourceReads++ === 0) { entered(); await gate; } return real.readFile(file); } }) });
  await h.write(await h.makeReport());
  const old = h.controller.refresh(); await began;
  h.advance(); await h.write(await h.makeReport({ buildId: 'new-build', errors: [], exitCode: 0 }));
  await h.controller.refresh(); release(); await old;
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /0 compiler error/);
  assert.equal(h.controller.getState().reports[0].buildId, 'new-build');
});

test('a replaced report during source validation is re-read before publication', async t => {
  let replacement;
  let replaced = false;
  const h = await harness(t, { io: (real, source, reportFile) => ({ stat: real.stat,
    async readFile(file) {
      if (file === source && !replaced) { replaced = true; await real.writeFile(reportFile, JSON.stringify(replacement)); }
      return real.readFile(file);
    } }) });
  await h.write(await h.makeReport());
  replacement = await h.makeReport({ buildId: 'new-build', phase: 'running', exitCode: null });
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
});

test('invalid report replacement immediately removes a prior exact highlight', async t => {
  const h = await harness(t);
  await h.write(await h.makeReport()); await h.controller.refresh();
  await fs.writeFile(h.reportPath, '{broken'); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /invalid/);
  h.controller.showDetails(); assert.match(h.output.join('\n'), /Ignored report/);
});

test('range validation rejects malformed, unknown-file, non-file URI, and out-of-source locations', async t => {
  const h = await harness(t);
  const good = await h.makeReport();
  for (const mutate of [
    value => { value.errors[0].range.start = -1; },
    value => { value.errors[0].range.end = value.errors[0].range.start; },
    value => { value.errors[0].range.file = 'command:evil'; },
    value => { value.errors[0].range.file = path.join(h.dir, 'not-in-build.tex'); },
    value => { value.errors[0].reported.file = 'https://evil.invalid'; },
    value => { value.sources[h.source].hash = '__proto__'; },
    value => { value.errors.push(value.errors[0]); }
  ]) {
    const value = structuredClone(good); mutate(value);
    assert.throws(() => validateReport(value));
  }
  good.errors[0].range.end = 1000;
  await h.write(good); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /exceeds the source length/);
});

test('reported exact range must reproduce the actual failing command', async t => {
  const h = await harness(t);
  const report = await h.makeReport(); report.errors[0].range.start++;
  await h.write(report); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /does not match its failing command/);
});

test('stale reports and a missing root source never publish locations', async t => {
  const h = await harness(t);
  await h.write(await h.makeReport({ stale: true })); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /stale/);
  h.advance(); const report = await h.makeReport({ buildId: 'next', errors: [], sources: {} });
  await h.write(report); await h.controller.refresh();
  assert.match(h.controller.getState().status, /does not identify its root/);
});

test('closing and reopening a changed document invalidates an existing exact result', async t => {
  const h = await harness(t);
  await h.write(await h.makeReport()); h.controller.start(); await h.controller.refresh();
  const changed = document(h.source, 'changed');
  h.events.open.fire(changed);
  assert.equal(h.controller.getState().exact.length, 0);
});

test('dirty structural errors appear after debounce and recover without saving or compiling', async t => {
  const h = await harness(t, { text: '\\begin{document}\n\\frac{1}{2}\n\\end{document}\n', hideDiscovery: true });
  h.controller.start(); await h.controller.refresh();
  assert.equal(h.controller.getState().structural.length, 0);
  h.doc.isDirty = true;
  h.doc.text = '\\begin{document}\n\\frac{1\n\\end{document}\n';
  h.events.text.fire({ document: h.doc, contentChanges: [{ text: h.doc.text }] });
  assert.equal(h.controller.getState().structural.length, 0, 'typing is debounced');
  await new Promise(resolve => setTimeout(resolve, 190));
  const hints = h.controller.getState().structural;
  assert.equal(hints.length, 1);
  assert.equal(hints[0].code, 'brace-unclosed');
  assert.equal(hints[0].confidence, 'suspected');
  assert.equal(h.doc.text.slice(hints[0].start, hints[0].end), '{');
  assert.equal(h.editor.structuralDecorations.length, 1);
  assert.equal(h.controller.getState().exact.length, 0);
  const hover = h.hover().provideHover(h.doc, h.doc.positionAt(hints[0].start));
  assert.match(hover.contents.value, /likely unmatched opening token/);
  assert.match(hover.contents.value, /without compiling/);
  h.controller.showDetails(); assert.match(h.output.join('\n'), /Live structural hint: suspected/);
  h.doc.text = h.text;
  h.events.text.fire({ document: h.doc, contentChanges: [{ text: h.doc.text }] });
  assert.equal(h.editor.structuralDecorations.length, 0, 'obsolete offsets clear immediately');
  await new Promise(resolve => setTimeout(resolve, 190));
  assert.equal(h.controller.getState().structural.length, 0);
  assert.equal(h.doc.isDirty, true);
});

test('blank alignment lines receive a visible inline warning and keep precise source offsets', async t => {
  const h = await harness(t, { text: '\\begin{align*}\na&=1\n\nb&=2\n\\end{align*}\n' });
  h.doc.isDirty = true;
  h.controller.start(); await h.controller.refresh();
  const hint = h.controller.getState().structural.find(value => value.code === 'alignment-paragraph');
  assert.ok(hint);
  assert.equal(hint.end > hint.start, true);
  const decorated = h.editor.structuralDecorations.find(value => value.renderOptions?.after);
  assert.equal(decorated.renderOptions.after.contentText, '← blank line inside alignment');
  assert.equal(decorated.range.start.line, 2);
  assert.equal(decorated.range.end.line, 2);
  h.events.close.fire(h.doc);
  assert.equal(h.controller.getState().structural.length, 0);
});

test('live structural checks can be disabled independently from compiler exact highlights', async t => {
  const h = await harness(t, { text: '\\frac{1', settings: { 'latexExact.liveStructure': false } });
  h.controller.start(); await h.controller.refresh();
  assert.equal(h.controller.getState().structural.length, 0);
  assert.equal(h.editor.structuralDecorations.length, 0);
});

test('cheap report polling discovers an excluded Workshop output path within one 175ms tick', async t => {
  const ticks = new Map();
  const h = await harness(t, { outDirName: 'quick-output', hideDiscovery: true,
    settings: { 'latex-workshop.latex.outDir': '%DIR%/quick-output' }, pollInterval: 175,
    setInterval(callback, delay) { ticks.set(delay, callback); return { unref() {} }; }, clearInterval() {} });
  h.controller.start(); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  await h.write(await h.makeReport());
  assert.equal(ticks.has(175), true);
  h.advance(175); await ticks.get(175)();
  assert.equal(h.controller.getState().exact.length, 1);
});

test('unchanged reports are not reread or repainted by metadata polling or periodic source verification', async t => {
  const ticks = new Map();
  const reads = new Map();
  const h = await harness(t, { pollInterval: 175,
    io: real => ({ stat: real.stat, async readFile(file) { reads.set(file, (reads.get(file) || 0) + 1); return real.readFile(file); } }),
    setInterval(callback, delay) { ticks.set(delay, callback); return { unref() {} }; }, clearInterval() {} });
  await h.write(await h.makeReport()); h.controller.start(); await h.controller.refresh();
  const reportReads = reads.get(h.reportPath);
  const sourceReads = reads.get(h.source);
  const paints = h.decorations.length;
  const generation = h.controller.getState().generation;
  for (let n = 0; n < 3; n++) await ticks.get(175)();
  assert.equal(reads.get(h.reportPath), reportReads);
  assert.equal(reads.get(h.source), sourceReads);
  await ticks.get(3000)();
  assert.ok(reads.get(h.source) > sourceReads, 'source identity is still periodically verified');
  assert.equal(reads.get(h.reportPath), reportReads);
  assert.equal(h.decorations.length, paints);
  assert.equal(h.controller.getState().generation, generation);
  assert.equal(h.controller.getState().exact.length, 1);
});

test('periodic source verification clears an excluded dependency edit without reloading the report', async t => {
  const ticks = new Map();
  const h = await harness(t, { pollInterval: 175,
    setInterval(callback, delay) { ticks.set(delay, callback); return { unref() {} }; }, clearInterval() {} });
  await h.write(await h.makeReport()); h.controller.start(); await h.controller.refresh();
  await fs.writeFile(h.source, h.text.replace('+1', '+2'));
  await ticks.get(3000)();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /Source changed/);
});

test('Problems diagnostic event picks up a completed excluded report without a polling tick or workspace scan', async t => {
  const h = await harness(t, { hideDiscovery: true });
  h.controller.start(); await h.controller.refresh();
  const discoveries = h.metrics.discoveries;
  await h.write(await h.makeReport());
  h.events.diagnostics.fire({ uris: [h.doc.uri] });
  const deadline = Date.now() + 300;
  while (!h.controller.getState().exact.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.controller.getState().exact.length, 1);
  assert.equal(h.metrics.discoveries, discoveries);
});

test('Problems diagnostic event retains dirty-source rejection', async t => {
  const h = await harness(t, { hideDiscovery: true });
  h.controller.start(); await h.controller.refresh();
  h.doc.isDirty = true;
  await h.write(await h.makeReport());
  h.events.diagnostics.fire({ uris: [h.doc.uri] });
  const deadline = Date.now() + 300;
  while (!/Unsaved/.test(h.controller.getState().status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /Unsaved/);
});

test('unrelated Problems changes do not read reports, refresh, or scan files', async t => {
  let reads = 0;
  const h = await harness(t, { io: real => ({ stat: real.stat, async readFile(file) { reads++; return real.readFile(file); } }) });
  await h.write(await h.makeReport()); h.controller.start(); await h.controller.refresh();
  const before = { reads, generation: h.controller.getState().generation, discoveries: h.metrics.discoveries };
  h.events.diagnostics.fire({ uris: [uri(path.join(h.dir, 'script.js')), uri(path.join(os.tmpdir(), 'unopened-other-project.tex'))] });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual({ reads, generation: h.controller.getState().generation, discoveries: h.metrics.discoveries }, before);
  assert.equal(h.controller.getState().exact.length, 1);
});

test('streaming reports paint validated exact commands and disclose that the compiler is still running', async t => {
  const h = await harness(t);
  const report = await h.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00Z' });
  await h.write(report); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  assert.equal(h.controller.getState().reports[0].phase, 'streaming');
  assert.match(h.controller.getState().status, /compiler still running/);
  assert.match(h.controller.getState().status, /confirmed so far/);
  assert.match(h.editor.decorations[0].hoverMessage.value, /compiler is still running/);
  assert.match(h.editor.decorations[0].hoverMessage.value, /confirmed by its output/);
  h.controller.showDetails(); assert.match(h.output.join('\n'), /streaming/);
});

test('same-build streaming updates add errors immediately and a final successful report clears them', async t => {
  const h = await harness(t, { text: '$\\alhpa + \\betaa$\n' });
  const first = await h.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00Z' });
  await h.write(first); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  const second = structuredClone(first);
  second.observedAt = '2026-09-15T12:00:00.100Z';
  const start = h.text.indexOf('\\betaa');
  second.errors.push({ ...structuredClone(second.errors[0]), id: 'error-2', command: '\\betaa',
    range: { file: h.source, start, end: start + 6 } });
  await h.write(second); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 2);
  assert.deepEqual(h.controller.getState().exact.map(error => error.command), ['\\alhpa', '\\betaa']);
  const final = { ...second, phase: 'complete', completedAt: '2026-09-15T12:00:01Z', exitCode: 0, errors: [] };
  await h.write(final); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.equal(h.editor.decorations.length, 0);
  assert.doesNotMatch(h.controller.getState().status, /still running/);
  await h.write(second); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0, 'an older streaming phase cannot revive a completed build');
  assert.match(h.controller.getState().status, /older build/);
});

test('an older observation in the same streaming build cannot replace newer error evidence', async t => {
  const h = await harness(t);
  const newer = await h.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00.500Z' });
  await h.write(newer); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  await h.write({ ...newer, observedAt: '2026-09-15T12:00:00Z' }); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /older build/);
});

test('a new running build clears streaming errors and accepts only its own later observations', async t => {
  const h = await harness(t);
  const first = await h.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00Z' });
  await h.write(first); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 1);
  const next = { ...first, buildId: 'next-build', startedAt: '2026-09-15T12:00:02Z' };
  await h.write({ ...next, phase: 'running', errors: [] }); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /in progress/);
  await h.write(first); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  await h.write({ ...next, observedAt: '2026-09-15T12:00:02.500Z' }); await h.controller.refresh();
  assert.equal(h.controller.getState().exact[0].buildId, 'next-build');
});

test('streaming reports require an ISO observation time and cannot claim a completion or exit status', async t => {
  const h = await harness(t);
  const report = await h.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00Z' });
  assert.equal(validateReport(report), report);
  for (const override of [
    { observedAt: undefined }, { observedAt: '2026-09-15' }, { observedAt: 'not-a-date' },
    { completedAt: '2026-09-15T12:00:00Z' }, { completedAt: undefined }, { exitCode: 0 }
  ]) assert.throws(() => validateReport({ ...report, ...override }), /streaming-report metadata/);
});

test('streaming reports retain stale-source and unsaved-document rejection', async t => {
  const stale = await harness(t);
  await stale.write(await stale.makeReport({ phase: 'streaming', completedAt: null, exitCode: null,
    observedAt: '2026-09-15T12:00:00Z', stale: true }));
  await stale.controller.refresh();
  assert.equal(stale.controller.getState().exact.length, 0);
  assert.match(stale.controller.getState().status, /stale/);
  const dirty = await harness(t);
  dirty.doc.isDirty = true;
  await dirty.write(await dirty.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00Z' }));
  await dirty.controller.refresh();
  assert.equal(dirty.controller.getState().exact.length, 0);
  assert.match(dirty.controller.getState().status, /Unsaved/);
});

test('a source edit during asynchronous streaming validation cancels publication', async t => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { entered = resolve; });
  const h = await harness(t, { io: (real, source) => ({ stat: real.stat,
    async readFile(file) { if (file === source) { entered(); await gate; } return real.readFile(file); } }) });
  await h.write(await h.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00Z' }));
  const pending = h.controller.refresh(); await began;
  h.controller.invalidate('Source edited during compilation.'); release(); await pending;
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /edited during compilation/);
});

test('a final report replacing a streaming report during validation prevents an obsolete highlight', async t => {
  let final;
  let replaced = false;
  const h = await harness(t, { io: (real, source, reportFile) => ({ stat: real.stat,
    async readFile(file) {
      if (file === source && !replaced) { replaced = true; await real.writeFile(reportFile, JSON.stringify(final)); }
      return real.readFile(file);
    } }) });
  const streaming = await h.makeReport({ phase: 'streaming', completedAt: null, exitCode: null, observedAt: '2026-09-15T12:00:00Z' });
  final = { ...streaming, phase: 'complete', completedAt: '2026-09-15T12:00:01Z', errors: [], exitCode: 0 };
  await h.write(streaming); await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  await h.controller.refresh();
  assert.equal(h.controller.getState().exact.length, 0);
  assert.match(h.controller.getState().status, /0 compiler error/);
});
