'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const manifest = require('../../package.json');
const R = String.raw;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, message, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await fn()) return; await sleep(10); }
  throw new Error(message);
}
async function run() {
  const root = process.env.LATEX_EXACT_HOST_ROOT, project = process.env.LATEX_EXACT_HOST_PROJECT;
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  const api = await extension.activate(), checks = [], latency = [];
  const uri = vscode.Uri.file(path.join(project, 'main.tex'));
  const doc = await vscode.workspace.openTextDocument(uri);
  let editor = await vscode.window.showTextDocument(doc, { preview: false });
  const state = () => api.getLiveState().documents.find(d => d.file === doc.uri.fsPath);
  const liveProblems = () => vscode.languages.getDiagnostics(uri).filter(d => d.source === 'LaTeX Live');
  async function settled() {
    await until(() => state()?.version === doc.version && !state().pending, 'Live checker did not settle: ' + JSON.stringify(api.getLiveState()));
    await until(() => liveProblems().length === state().findings.length, 'Problems panel did not receive all findings');
    return state();
  }
  async function replace(text) {
    editor = await vscode.window.showTextDocument(doc, { preview: false });
    const started = performance.now();
    await editor.edit(b => b.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
    return started;
  }
  for (const text of [R`$\alhpa$`, R`\[\alhpa\]`, R`\begin{align}x &= \alhpa\end{align}`]) {
    const start = await replace(text); await settled(); latency.push(performance.now() - start);
    const p = liveProblems(); assert.equal(p.length, 1, JSON.stringify(p));
    assert.equal(doc.getText(p[0].range), R`\alhpa`); assert.equal(p[0].severity, vscode.DiagnosticSeverity.Warning);
    assert.match(p[0].message, /Unrecognized command/); assert.match(p[0].message, /\\alpha/);
    assert.ok(p[0].range.isEqual(state().findings[0].range), 'decorations and Problems share exact ranges');
    assert.equal(doc.isDirty, true);
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, p[0].range.start);
    assert.ok(hovers.length && hovers[0].range.isEqual(p[0].range), 'Real hover provider must return the exact diagnostic range');
  }
  checks.push('Inline, display, align: exact live warning ranges, Problems, and real hover provider');
  await replace('é😀 $\\alhpa$'); await settled();
  assert.equal(liveProblems()[0].range.start.character, 5); assert.equal(doc.getText(liveProblems()[0].range), R`\alhpa`);
  await replace(R`$\alpha$`); await settled(); assert.equal(liveProblems().length, 0);
  async function historyEdit(command, expectedText) {
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    const previousVersion = doc.version;
    await vscode.commands.executeCommand(command);
    // Command completion can precede delivery of the document-change event.
    await until(() => doc.version > previousVersion, `${command} did not change the test document`);
    assert.equal(doc.getText(), expectedText);
    await settled();
  }
  await historyEdit('undo', 'é😀 $\\alhpa$'); assert.equal(liveProblems().length, 1);
  await historyEdit('redo', R`$\alpha$`); assert.equal(liveProblems().length, 0);
  checks.push('UTF-16, correction, undo and redo without save');
  await replace(R`$\alhpa$`); await sleep(100); await replace(R`$\alpha$`); await settled();
  assert.equal(liveProblems().length, 0); await sleep(200); assert.equal(liveProblems().length, 0);
  checks.push('Rapid consecutive edits discard superseded snapshots');
  const untitled = await vscode.workspace.openTextDocument({ language: 'latex', content: '$\\alhpa$' });
  await vscode.window.showTextDocument(untitled);
  await until(() => vscode.languages.getDiagnostics(untitled.uri).some(d => d.source === 'LaTeX Live'), 'Untitled buffer was not checked');
  assert.equal(untitled.getText(vscode.languages.getDiagnostics(untitled.uri).find(d => d.source === 'LaTeX Live').range), R`\alhpa`);
  // Keep dirty untitled fixtures open until the isolated host exits. Cursor's
  // focus-based revert-and-close command can close the test window mid-run.
  editor = await vscode.window.showTextDocument(doc, { preview: false });
  checks.push('Brand-new untitled LaTeX buffer and switching back to the main document');

  const defsUri = vscode.Uri.file(path.join(project, 'defs.tex'));
  await fs.writeFile(defsUri.fsPath, '');
  const defs = await vscode.workspace.openTextDocument(defsUri);
  await replace(R`\documentclass{article}\input{defs}\begin{document}\custom\end{document}`); await settled();
  assert.ok(liveProblems().some(d => d.code === 'unknown-command'));
  const defsEditor = await vscode.window.showTextDocument(defs, { preview: false });
  await defsEditor.edit(b => b.insert(new vscode.Position(0, 0), R`\newcommand{\custom}{ok}`));
  await until(() => state()?.version === doc.version && !state().pending && liveProblems().length === 0, 'Unsaved included definition did not clear parent diagnostics');
  assert.equal(defs.isDirty, true); assert.equal(await fs.readFile(defsUri.fsPath, 'utf8'), '');
  editor = await vscode.window.showTextDocument(doc, { preview: false });
  assert.equal(liveProblems().length, 0);
  checks.push('Adding definition in another unsaved buffer updates the already-open parent; switching files');
  for (const text of [R`\usepackage{amsmath}\begin{align}\dfrac{1}{2}&=\text{hello}\end{align}`,
    R`\usepackage{amsmath,amsthm,thmtools}\declaretheorem[name=Theorem]{theorem}\declaretheorem[sibling=theorem]{lemma}\begin{lemma}$x$\end{lemma}`,
    R`\newenvironment{myalign}{\begin{align}}{\end{align}}\begin{myalign}\alpha&=1\end{myalign}`,
    R`% \alhpa
\verb|\alhpa| \newcommand{\ok}{\later} $\ok (0,1]$`]) {
    await replace(text); await settled(); assert.equal(liveProblems().length, 0, JSON.stringify(liveProblems()));
  }
  checks.push('Package dependencies, custom environments, declarations, comments, verbatim, intervals');
  for (const [text, token] of [[R`{`, '{'], [R`$`, '$'], [R`{abc`, '{'], [R`$x`, '$'], [R`\[x`, R`\[`], [R`\begin{align}x&=1`, R`\begin{align}`], [R`$\left(x$`, R`\left`]]) {
    await replace(text); await settled(); assert.equal(liveProblems().length, 1, JSON.stringify(liveProblems())); assert.equal(doc.getText(liveProblems()[0].range), token);
  }
  checks.push('Unmatched braces, math, environments, left/right underline existing openers');
  await fs.writeFile(path.join(project, 'formatting.tex'), R`\NewDocumentCommand{\boxmath}{m}{\begingroup\ensuremath{\begin{array}{c}#1\end{array}}\endgroup}`);
  const formatted = R`\documentclass{article}\input{formatting}\begin{document}\[\boxmath{x}\] `;
  for (const [token, code, closer] of [['$', 'math-unclosed', 'x$'], ['{', 'brace-unclosed', '}']]) {
    await replace(formatted + token + R`\end{document}`); await settled();
    assert.equal(liveProblems().length, 1, JSON.stringify(liveProblems()));
    assert.equal(liveProblems()[0].code, code);
    assert.equal(doc.offsetAt(liveProblems()[0].range.start), formatted.length);
    assert.equal(doc.getText(liveProblems()[0].range), token);
    assert.equal(liveProblems()[0].severity, vscode.DiagnosticSeverity.Warning);
    await editor.edit(b => b.insert(doc.positionAt(formatted.length + 1), closer));
    await settled(); assert.equal(liveProblems().length, 0);
  }
  checks.push('Single dollar and brace after a formatting macro from another file: exact live warning ranges, cleared on pairing');
  const large = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n' + ('A paragraph with $\\alpha+\\beta$, \\emph{text}, and \\ref{eq:one}.\n').repeat(10000);
  await replace(large + '$\\alpha$\n\\end{document}'); await settled();
  for (let n = 0; n < 12; n++) {
    const start = performance.now();
    const from = doc.getText().lastIndexOf(n % 2 ? '\\alhpa' : '\\alpha');
    await editor.edit(b => b.replace(new vscode.Range(doc.positionAt(from), doc.positionAt(from + 6)), n % 2 ? R`\alpha` : R`\alhpa`));
    await settled(); latency.push(performance.now() - start);
    assert.equal(liveProblems().length, n % 2 ? 0 : 1);
    assert.ok(state().timing.analysisMs < 500, 'Worker analysis unexpectedly slow');
  }
  checks.push('12 measured unsaved edits on a 640 KB / 10005-line manuscript fixture');
  // Start work on one version then supersede it before publication.
  await replace(large + '$\\alhpa$\n\\end{document}'); await sleep(305);
  await replace(large + '$\\alpha$\n\\end{document}'); await settled();
  assert.equal(liveProblems().length, 0);
  checks.push('Edit while worker analysis is in flight cannot revive obsolete diagnostics');
  // A late compiler report for different saved contents cannot overwrite live ranges.
  await replace('😀 $\\alhpa$'); await settled();
  await fs.mkdir(path.join(project, '.latex-build', '.latex-exact'), { recursive: true });
  const crypto = require('node:crypto'); const saved = await fs.readFile(uri.fsPath); const stat = await fs.stat(uri.fsPath);
  const report = { schemaVersion: 1, buildId: 'late-old-source', phase: 'complete', projectRoot: project, cwd: project, rootFile: uri.fsPath,
    startedAt: new Date(Date.now() - 10000).toISOString(), completedAt: new Date().toISOString(), stale: false, exitCode: 1,
    sources: { [uri.fsPath]: { hash: crypto.createHash('sha256').update(saved).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs } },
    issues: [], errors: [{ id: 'old', kind: 'undefined-command', status: 'exact', command: R`\alhpa`, message: 'Undefined control sequence.',
      reported: { file: uri.fsPath, line: 6 }, range: { file: uri.fsPath, start: saved.toString().indexOf(R`\alhpa`), end: saved.toString().indexOf(R`\alhpa`) + 6 }, related: [], candidates: [], evidence: ['A valid late compiler report for the saved source.'] }] };
  require('../../src/extension').validateReport(report);
  await fs.writeFile(path.join(project, '.latex-build', '.latex-exact', 'report.json'), JSON.stringify(report));
  await api.refresh(); assert.equal(api.getState().exact.length, 0);
  assert.match(api.getState().status, /Unsaved|Source|stale|edited/i, 'Report must be rejected for source freshness, not malformed schema');
  assert.equal(doc.getText(liveProblems()[0].range), R`\alhpa`);
  checks.push('Late stale compiler report cannot restore or replace current live ranges');
  const configuration = vscode.workspace.getConfiguration('latexExact');
  const savedColor = configuration.inspect('liveHighlightColor').workspaceValue;
  const savedDelay = configuration.inspect('lintDelay').workspaceValue;
  const savedKeep = configuration.inspect('keepLiveHighlightsWhileTyping').workspaceValue;
  const settingsTiming = {};
  async function setting(name, value) {
    const before = api.getLiveState().generation;
    await configuration.update(name, value, vscode.ConfigurationTarget.Workspace);
    await until(() => api.getLiveState().generation > before, 'Setting change was not applied: ' + name);
    await settled();
    assert.equal(api.getLiveState().error, null);
  }
  try {
    await setting('liveHighlightColor', '#ff555555');
    assert.equal(doc.getText(liveProblems()[0].range), R`\alhpa`);
    await setting('lintDelay', 800);
    await replace(R`$\alpha$`); await settled();
    settingsTiming.slowMs = state().timing.afterEditMs;
    assert.ok(settingsTiming.slowMs >= 780, 'Configured 800 ms pause was not respected');
    await setting('lintDelay', 50);
    await replace(R`$\alhpa$`); await settled();
    settingsTiming.fastMs = state().timing.afterEditMs;
    assert.ok(settingsTiming.fastMs < settingsTiming.slowMs, 'Shorter delay did not take effect');
    assert.equal(doc.getText(liveProblems()[0].range), R`\alhpa`);

    await setting('lintDelay', 1000);
    assert.equal(configuration.get('keepLiveHighlightsWhileTyping'), true, 'Smooth highlighting defaults to enabled');
    await replace('$\\alhpa + \\btea$\nTail'); await settled();
    const originalPublication = state().timing.publishedAt;
    const tokens = () => liveProblems().map(p => doc.getText(p.range));
    for (const prefix of ['😀\n', 'é', 'more text\n']) {
      await editor.edit(b => b.insert(doc.positionAt(0), prefix));
      await until(() => state()?.version === doc.version && state().pending, 'Untouched findings were not retained while typing');
      await until(() => tokens().join(',') === '\\alhpa,\\btea', 'Retained Problems ranges did not follow the edit');
      assert.equal(state().timing.publishedAt, originalPublication, 'Retention must work before the new analysis');
      assert.deepEqual(state().findings.map(f => doc.getText(f.range)), [R`\alhpa`, R`\btea`]);
    }
    const typo = state().findings.find(f => doc.getText(f.range) === R`\alhpa`);
    await editor.edit(b => b.replace(typo.range, R`\alpha`));
    await until(() => state()?.pending && state().findings.length === 1, 'Editing one token did not clear only that finding');
    await until(() => tokens().join(',') === '\\btea', 'Edited token remains in Problems');
    await sleep(100);
    assert.equal(state().pending, true);
    assert.deepEqual(tokens(), [R`\btea`]);
    await settled(); assert.deepEqual(tokens(), [R`\btea`]);
    checks.push('Untouched live findings persist through rapid Unicode/multiline edits; fixing one token immediately clears only that token');

    // A finding in another unsaved buffer also remains while this file is edited.
    const other = await vscode.workspace.openTextDocument({ language: 'latex', content: '$\\alhpa$' });
    await until(() => api.getLiveState().documents.some(d => d.file === other.uri.toString() && !d.pending && d.findings.length), 'Other buffer did not settle');
    await settled();
    await editor.edit(b => b.insert(doc.positionAt(doc.getText().length), 'x'));
    await until(() => state()?.pending, 'Main buffer did not retain findings');
    const retainedOther = api.getLiveState().documents.find(d => d.file === other.uri.toString());
    assert.equal(retainedOther.pending, true); assert.equal(retainedOther.findings.length, 1);
    assert.equal(other.getText(retainedOther.findings[0].range), R`\alhpa`);
    await settled();
    checks.push('Typing in one buffer preserves untouched findings in another unsaved buffer');

    await setting('keepLiveHighlightsWhileTyping', false);
    await editor.edit(b => b.insert(doc.positionAt(doc.getText().length), 'x'));
    await until(() => !state() && liveProblems().length === 0, 'Disabled retention must clear live findings before the debounce');
    await settled(); assert.deepEqual(tokens(), [R`\btea`]);
    await setting('keepLiveHighlightsWhileTyping', true);
    await editor.edit(b => b.insert(doc.positionAt(doc.getText().length), 'x'));
    await until(() => state()?.pending && state().findings.length === 1, 'Re-enabling retention did not take effect without reload');
    await settled();
    checks.push('Boolean option switches between retained and immediately cleared highlights without reload');
  } finally {
    // A default value written explicitly can be restored without a value-change event.
    if (configuration.inspect('keepLiveHighlightsWhileTyping').workspaceValue !== savedKeep) {
      await configuration.update('keepLiveHighlightsWhileTyping', savedKeep, vscode.ConfigurationTarget.Workspace);
    }
    await setting('liveHighlightColor', savedColor);
    await setting('lintDelay', savedDelay);
  }
  checks.push('Workspace color changes preserve live findings; 800 ms and 50 ms typing delays apply without reload');
  const sorted = [...latency].sort((a, b) => a - b);
  const result = { cursor: vscode.version, extension: extension.packageJSON.version, checks, samplesMs: latency,
    medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1),
    largeFixtureCharacters: large.length, lastTiming: state().timing, settingsTiming, dirty: doc.isDirty };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log('LATEX_LIVE_HOST_RESULT ' + JSON.stringify(result));
  if (process.env.LATEX_LIVE_KEEP === '1') {
    await replace('\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\nUnicode é😀: $\\alhpa + 1$\n\n\\begin{align}\na &= \\alpha + 1\n\\end{align}\n\\end{document}\n'); await settled();
    await vscode.commands.executeCommand('workbench.actions.view.problems');
    editor.selection = new vscode.Selection(new vscode.Position(4, 15), new vscode.Position(4, 15));
    await fs.writeFile(path.join(root, 'ready-for-visual.txt'), root);
    await until(async () => { try { await fs.access(path.join(root, 'finish-visual')); return true; } catch { return false; } }, 'Visual inspection timed out', 180000);
  }
}
module.exports = { async run() {
  try { await run(); }
  catch (error) {
    await fs.writeFile(path.join(process.env.LATEX_EXACT_HOST_ROOT, 'failure.txt'), String(error?.stack || error));
    throw error;
  }
} };
