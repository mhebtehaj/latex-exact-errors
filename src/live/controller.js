'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { moveRange } = require('./ranges');
function createLiveController(vscode, dependencies = {}) {
  const subscriptions = [], entries = new Map(), requests = new Map();
  let generation = 0, serial = 0, timer, disposed = false, worker, candidates = [], discoverPromise;
  let changedAt = performance.now(), lastError = null;
  const output = vscode.window.createOutputChannel('Errata Live');
  const diagnostics = vscode.languages.createDiagnosticCollection('Errata Live');
  function createHighlight() {
    const color = vscode.workspace.getConfiguration('latexExact').get('liveHighlightColor', '#ffd54f55');
    return vscode.window.createTextEditorDecorationType({
      backgroundColor: typeof color === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(color) ? color : '#ffd54f55',
      borderRadius: '2px', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
  }
  let highlight = createHighlight();
  subscriptions.push(output, diagnostics, { dispose: () => highlight.dispose() });
  const isLatex = doc => ['latex', 'tex', 'latex-expl3'].includes(doc.languageId) || /\.(tex|ltx|sty|cls)$/.test(doc.uri.fsPath || '');
  const key = doc => doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.uri.toString();
  const config = doc => vscode.workspace.getConfiguration('latexExact', doc?.uri);
  const md = (finding, pending = false) => {
    const value = new vscode.MarkdownString(); value.isTrusted = false; value.supportHtml = false;
    value.appendText(finding.message + (pending
      ? '\n\nErrata Live — rechecking after edits. This finding is from the last completed check, not compiler-confirmed.'
      : '\n\nErrata Live — current buffer analysis, not compiler-confirmed.')); return value;
  };
  function render() {
    for (const editor of vscode.window.visibleTextEditors) {
      const entry = entries.get(key(editor.document));
      editor.setDecorations(highlight,
        entry && entry.version === editor.document.version ? entry.findings.map(f => ({ range: f.range, hoverMessage: md(f, entry.pending) })) : []);
    }
  }
  function clear() { entries.clear(); diagnostics.clear(); render(); }
  function publishDiagnostics(doc, entry) {
    diagnostics.set(doc.uri, entry.findings.map(f => {
      const diag = new vscode.Diagnostic(f.range, f.message + (entry.pending ? '\nRechecking after edits.' : ''),
        // Reserve red error squiggles for compiler-confirmed diagnostics.
        f.severity === 'information' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Warning);
      diag.source = 'Errata Live'; diag.code = f.code;
      if (f.related?.length) diag.relatedInformation = f.related.map(r => {
        const target = vscode.workspace.textDocuments.find(d => key(d) === r.file);
        return target ? new vscode.DiagnosticRelatedInformation(new vscode.Location(target.uri, new vscode.Range(target.positionAt(r.start), target.positionAt(r.end))), r.message) : null;
      }).filter(Boolean);
      return diag;
    }));
  }
  function retainAfterEdit(event) {
    const editedFile = key(event.document);
    for (const [file, entry] of entries) {
      const doc = vscode.workspace.textDocuments.find(d => key(d) === file && !d.isClosed);
      const edited = file === editedFile;
      // A missed document version must never leave a highlight at a guessed location.
      if (!doc || !config(doc).get('keepLiveHighlightsWhileTyping', true) || !config(doc).get('liveCheck', true)
        || entry.version !== doc.version - (edited ? 1 : 0)) {
        entries.delete(file);
        if (doc) diagnostics.delete(doc.uri);
        continue;
      }
      const findings = entry.findings.flatMap(f => {
        const moved = edited ? moveRange(f, event.contentChanges) : { ...f };
        if (!moved) return [];
        if (edited) moved.range = new vscode.Range(doc.positionAt(moved.start), doc.positionAt(moved.end));
        if (moved.related) moved.related = moved.related.flatMap(r => {
          const related = r.file === editedFile ? moveRange(r, event.contentChanges) : r;
          return related ? [related] : [];
        });
        return [moved];
      });
      const retained = { ...entry, version: doc.version, findings, pending: true };
      entries.set(file, retained); publishDiagnostics(doc, retained);
    }
    render();
  }
  async function discover() {
    if (discoverPromise) return discoverPromise;
    discoverPromise = vscode.workspace.findFiles('**/*.{tex,ltx,sty,cls}', '**/{node_modules,.git,.latex-build,.latex-exact}/**', 512)
      .then(uris => { candidates = uris.filter(u => u.scheme === 'file').map(u => u.fsPath); }).finally(() => { discoverPromise = undefined; });
    return discoverPromise;
  }
  function analyze(request) {
    if (dependencies.analyze) return dependencies.analyze(request);
    if (!worker) {
      const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
      worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { metadataPath: workshop && path.join(workshop.extensionPath, 'data') } });
      worker.on('message', message => {
        const pending = requests.get(message.id); if (!pending) return;
        requests.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message);
      });
      worker.on('error', error => { for (const r of requests.values()) r.reject(error); requests.clear(); worker = null; });
      worker.on('exit', code => { if (code && !disposed) output.appendLine(`Analysis worker exited (${code}).`); });
    }
    const id = ++serial;
    return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); worker.postMessage({ id, request }); });
  }
  async function run() {
    const ticket = generation, started = performance.now(), editTime = changedAt;
    timer = undefined;
    if (disposed || !vscode.workspace.isTrusted) return;
    const docs = vscode.workspace.textDocuments.filter(doc => isLatex(doc) && !doc.isClosed);
    const versions = docs.map(doc => ({ doc, version: doc.version, text: doc.getText() }));
    try {
      if (discoverPromise) await discoverPromise;
      if (ticket !== generation || disposed) return;
      const request = { candidates, roots: (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
        documents: versions.map(({ doc, text, version }) => ({ file: key(doc), text, version, options: {
          enabled: config(doc).get('liveCheck', true), structure: config(doc).get('liveStructure', true), commands: config(doc).get('liveCommands', true),
          additionalCommands: config(doc).get('additionalCommands', []), ordinaryParentheses: config(doc).get('ordinaryParentheses', false)
        } })) };
      // Standalone files can resolve adjacent includes; untitled documents have no disk inputs.
      if (!request.roots.length) request.roots = docs.filter(d => d.uri.scheme === 'file').map(d => path.dirname(d.uri.fsPath));
      const response = await analyze(request);
      if (disposed || ticket !== generation || response.superseded || versions.some(v => v.doc.isClosed || v.doc.version !== v.version || v.doc.getText() !== v.text)) return;
      const publishedAt = performance.now(); lastError = null;
      const returned = new Set(response.result.documents.map(d => d.file));
      for (const { doc } of versions) if (!returned.has(key(doc))) { entries.delete(key(doc)); diagnostics.delete(doc.uri); }
      for (const result of response.result.documents) {
        const snapshot = versions.find(v => key(v.doc) === result.file); if (!snapshot) continue;
        const doc = snapshot.doc;
        const findings = result.findings.filter(f => f.start >= 0 && f.end > f.start && f.end <= snapshot.text.length).map(f => ({ ...f,
          range: new vscode.Range(doc.positionAt(f.start), doc.positionAt(f.end)) }));
        const entry = { file: result.file, version: doc.version, findings, pending: false, uncertainty: result.uncertainty, root: result.root,
          timing: { afterEditMs: publishedAt - editTime, analysisMs: response.analysisMs, dispatchMs: publishedAt - started, publishedAt } };
        entries.set(result.file, entry); publishDiagnostics(doc, entry);
      }
      render();
    } catch (error) {
      if (ticket !== generation || disposed) return;
      clear(); lastError = error.message; output.appendLine(`Live analysis failed: ${error.stack || error.message}`);
    }
  }
  function schedule(doc, immediate = false, edit) {
    generation++; changedAt = performance.now(); clearTimeout(timer);
    if (edit) retainAfterEdit(edit); else clear();
    const delay = Number(config(doc).get('lintDelay', 300));
    timer = setTimeout(() => { void run(); }, immediate ? 0 : Number.isFinite(delay) ? Math.max(50, Math.min(2000, delay)) : 300);
  }
  function start() {
    void discover().then(() => schedule(undefined, true));
    subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length && isLatex(event.document)) schedule(event.document, false, event); }));
    subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => { if (isLatex(doc)) schedule(doc, true); }));
    subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => { if (isLatex(doc)) schedule(undefined, true); }));
    subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(render));
    subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('latexExact.liveHighlightColor')) {
        highlight.dispose(); highlight = createHighlight();
      }
      if (event.affectsConfiguration('latexExact')) schedule(undefined, true);
    }));
    if (vscode.workspace.onDidGrantWorkspaceTrust) subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => schedule(undefined, true)));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,ltx,sty,cls}');
    const disk = () => { void discover(); schedule(); };
    subscriptions.push(watcher, watcher.onDidCreate(disk), watcher.onDidChange(disk), watcher.onDidDelete(disk));
    subscriptions.push(vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'untitled', language: 'latex' }, { scheme: 'untitled', language: 'tex' }], {
      provideHover(doc, position) {
        const entry = entries.get(key(doc));
        if (!entry || entry.version !== doc.version) return undefined;
        const f = entry.findings.find(f => f.range.contains(position));
        return f && new vscode.Hover(md(f, entry.pending), f.range);
      }
    }));
  }
  return { start, refresh: () => schedule(undefined, true), getState: () => ({ generation, error: lastError, documents: [...entries.values()] }),
    dispose() { if (disposed) return; disposed = true; generation++; clearTimeout(timer); clear(); worker?.terminate();
      for (const r of requests.values()) r.resolve({ superseded: true }); requests.clear();
      for (const subscription of subscriptions.reverse()) subscription.dispose(); } };
}
module.exports = { createLiveController };
