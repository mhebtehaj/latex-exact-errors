'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');
const manifest = require('../../package.json');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(30);
  }
  throw new Error(message);
}

async function runCompiler(project, extensionRoot, suffix) {
  const args = [path.join(extensionRoot, 'bin', 'build.js'), '--root', path.join(project, 'main.tex'),
    '--project', project, '--cwd', project, '--out-dir', path.join(project, '.latex-build'), '--',
    process.env.LATEX_EXACT_HOST_ENGINE, '-interaction=nonstopmode', '-file-line-error', '-recorder',
    '-no-shell-escape', '-output-directory=.latex-build', 'main.tex'];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.LATEX_EXACT_HOST_NODE, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Compiler wrapper exceeded 30 seconds.')); }, 30000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  await fs.writeFile(path.join(process.env.LATEX_EXACT_HOST_ROOT, `${suffix}-compiler.txt`), result.output);
  return result;
}

async function run() {
  const project = process.env.LATEX_EXACT_HOST_PROJECT;
  const extensionRoot = process.env.LATEX_EXACT_HOST_EXTENSION;
  assert.ok(project && extensionRoot, 'Run this suite through test/host/run.js.');
  assert.equal(vscode.workspace.isTrusted, true);
  assert.equal(vscode.workspace.workspaceFolders.length, 1);
  assert.equal(await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), project);
  const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(extension, 'The development extension must be discoverable.');
  const api = await extension.activate();
  assert.equal(typeof api.getState, 'function');
  assert.equal(typeof api.refresh, 'function');
  const sourceUri = vscode.Uri.file(path.join(project, 'main.tex'));
  const doc = await vscode.workspace.openTextDocument(sourceUri);
  await vscode.window.showTextDocument(doc, { preview: false });
  const source = doc.getText();
  const start = source.indexOf('\\alhpa');
  assert.ok(start >= 0);
  const reportPath = path.join(project, '.latex-build', '.latex-exact', 'report.json');
  const checks = [];

  const compilation = await runCompiler(project, extensionRoot, 'failed');
  assert.equal(compilation.code, 1, compilation.output);
  assert.equal(compilation.signal, null);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.phase, 'complete');
  assert.equal(report.stale, false, JSON.stringify(report.issues));
  assert.ok(report.errors.some(error => error.status === 'exact'), JSON.stringify(report.errors));
  // Model the actual Workshop ordering: the wrapper report is already complete
  // when its process exits and Workshop publishes the Problems entry.
  const problems = vscode.languages.createDiagnosticCollection('LaTeX host fixture');
  const problemsPublishedAt = Date.now();
  const reportedLine = report.errors.find(error => error.status === 'exact').reported.line - 1;
  const problem = new vscode.Diagnostic(new vscode.Range(reportedLine, 0, reportedLine, 1),
    'Undefined control sequence. \\alhpa', vscode.DiagnosticSeverity.Error);
  problem.source = 'LaTeX';
  problems.set(sourceUri, [problem]);
  // No manual refresh or explicitly configured report path: the actual editor
  // must notice the new report promptly despite the excluded output folder.
  await until(() => api.getState().exact.length === 1, `Exact range unavailable: ${JSON.stringify(api.getState())}`);
  const compilerDisplayDelayMs = Date.now() - Date.parse(report.completedAt);
  const problemsDisplayDelayMs = Date.now() - problemsPublishedAt;
  assert.ok(compilerDisplayDelayMs < 1500, `Compiler-report pickup took ${compilerDisplayDelayMs} ms.`);
  const first = api.getState().exact[0];
  assert.equal(first.range.file, sourceUri.fsPath);
  assert.equal(first.range.start, start);
  assert.equal(first.range.end, start + '\\alhpa'.length);
  assert.equal(doc.getText().slice(first.range.start, first.range.end), '\\alhpa');
  assert.ok(vscode.window.visibleTextEditors.some(editor => editor.document === doc));
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', sourceUri, doc.positionAt(start + 1));
  assert.ok(hovers.some(hover => hover.contents.some(content => /alhpa/.test(content.value || String(content)))), 'The real editor hover provider must return compiler evidence.');
  checks.push('Failed pdfLaTeX align* build yields the exact six-character command in a visible editor and a real hover.');
  checks.push(`Excluded-folder report appeared automatically ${compilerDisplayDelayMs} ms after completion.`);
  checks.push(`Exact highlight was visible ${problemsDisplayDelayMs} ms after publishing the Problems entry.`);
  problems.dispose();

  const edit = new vscode.WorkspaceEdit();
  edit.replace(sourceUri, new vscode.Range(doc.positionAt(start), doc.positionAt(start + 6)), '\\alpha');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(doc.isDirty, true);
  await until(() => api.getState().exact.length === 0, 'Unsaved source edit must clear exact highlights.');
  await api.refresh();
  assert.equal(api.getState().exact.length, 0, 'Refreshing the old report must not revive highlights.');
  checks.push('An unsaved fix immediately clears the result; the old build cannot revive it.');
  assert.equal(await doc.save(), true);
  await sleep(150);
  const fixed = await runCompiler(project, extensionRoot, 'fixed');
  assert.equal(fixed.code, 0, fixed.output);
  const completed = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(completed.stale, false, JSON.stringify(completed.issues));
  assert.equal(completed.errors.length, 0);
  await api.refresh();
  assert.equal(api.getState().exact.length, 0);
  assert.ok((await fs.stat(path.join(project, '.latex-build', 'main.pdf'))).size > 0);
  checks.push('Saving and rebuilding the corrected document preserves PDF output and publishes no errors.');

  const replaceBuffer = async text => {
    const replacement = new vscode.WorkspaceEdit();
    replacement.replace(sourceUri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(replacement), true);
  };
  const fixedSource = doc.getText();
  const brokenAlignment = '\\begin{align*}\na &= 1\n\nb &= 2\n\\end{align*}\n';
  const editStarted = Date.now();
  await replaceBuffer(brokenAlignment);
  assert.equal(doc.isDirty, true);
  await until(() => api.getState().structural?.length > 0, 'An unsaved malformed alignment must show a live hint.');
  const liveDisplayDelayMs = Date.now() - editStarted;
  assert.ok(liveDisplayDelayMs < 1500, `Live structure check took ${liveDisplayDelayMs} ms.`);
  const structure = api.getState().structural[0];
  assert.match(structure.message, /blank|paragraph/i);
  const liveHover = await vscode.commands.executeCommand('vscode.executeHoverProvider', sourceUri, doc.positionAt(structure.range.start));
  assert.ok(liveHover.some(hover => hover.contents.some(content => /blank|paragraph/i.test(content.value || String(content)))), 'Dirty-document structural hover must explain the issue.');
  await replaceBuffer(brokenAlignment.replace('\n\n', '\n'));
  await until(() => api.getState().structural.length === 0, 'Fixing the unsaved alignment must remove its warning without a build.');
  await replaceBuffer(fixedSource);
  await until(() => api.getState().structural.length === 0, 'Restored valid document should have no live hints.');
  checks.push(`Unsaved alignment warning and hover appeared in ${liveDisplayDelayMs} ms and cleared after the fix without compiling.`);

  const config = vscode.workspace.getConfiguration('latex-workshop', sourceUri);
  const original = structuredClone(config.get('latex.tools'));
  assert.equal(original.length, 1);
  await vscode.commands.executeCommand('latexExact.enableProject');
  await until(() => vscode.workspace.getConfiguration('latex-workshop', sourceUri).get('latex.tools')[0].args.includes(path.join(extensionRoot, 'bin', 'build.js')),
    'Enable command must wrap the compiler tool.');
  const wrapped = vscode.workspace.getConfiguration('latex-workshop', sourceUri).get('latex.tools');
  assert.deepEqual(wrapped[0].env, original[0].env);
  assert.ok(wrapped[0].args.includes(original[0].command));
  await vscode.commands.executeCommand('latexExact.disableProject');
  await until(() => JSON.stringify(vscode.workspace.getConfiguration('latex-workshop', sourceUri).get('latex.tools')) === JSON.stringify(original),
    'Disable command must restore the original compiler tool.');
  checks.push('Enable/disable commands round-trip real folder settings and preserve the original tool environment.');
  await fs.writeFile(path.join(process.env.LATEX_EXACT_HOST_ROOT, 'result.json'), JSON.stringify({
    passed: true, application: vscode.env.appName, vscodeVersion: vscode.version, checks,
    compilerDisplayDelayMs, problemsDisplayDelayMs, liveDisplayDelayMs, initialExact: first, finalState: api.getState()
  }, null, 2));
  console.log(`LaTeX Exact: ${checks.length} real editor extension-host checks passed.`);
}

module.exports = { run };
