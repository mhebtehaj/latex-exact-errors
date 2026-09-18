'use strict';

// The compiler controller validates source snapshots without changing source files.
// The separate live controller publishes current-buffer diagnostics.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const LIMITS = { report: 4 * 1024 * 1024, source: 16 * 1024 * 1024,
  total: 96 * 1024 * 1024, sources: 4096, errors: 2000, sites: 2000 };
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const absolute = value => typeof value === 'string' && value.length < 4096 &&
  !value.includes('\0') && path.isAbsolute(value);
const canonical = value => path.resolve(value);
const within = (file, directory) => {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const string = (value, length = 32000) => typeof value === 'string' && value.length <= length;

function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.schemaVersion !== 1 ||
      !['running', 'streaming', 'complete'].includes(report.phase) || !string(report.buildId, 256) || !report.buildId ||
      !absolute(report.rootFile) || !absolute(report.projectRoot) || !absolute(report.cwd) ||
      !within(report.rootFile, report.projectRoot) || !Number.isFinite(Date.parse(report.startedAt)) ||
      typeof report.stale !== 'boolean' ||
      (report.exitCode !== null && !Number.isInteger(report.exitCode))) throw new Error('Invalid build-report metadata.');
  if (report.phase === 'complete' && !Number.isFinite(Date.parse(report.completedAt))) throw new Error('Invalid completion time.');
  if (report.phase === 'streaming' && (report.completedAt !== null || report.exitCode !== null ||
      typeof report.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(report.observedAt) ||
      !Number.isFinite(Date.parse(report.observedAt)))) throw new Error('Invalid streaming-report metadata.');
  if (!report.sources || typeof report.sources !== 'object' || Array.isArray(report.sources) ||
      Object.keys(report.sources).length > LIMITS.sources) throw new Error('Invalid source identities.');
  for (const [file, identity] of Object.entries(report.sources)) {
    if (!absolute(file) || canonical(file) !== file || !identity || !/^[a-f0-9]{64}$/i.test(identity.hash) ||
        !Number.isFinite(identity.mtimeMs) || !Number.isSafeInteger(identity.size) || identity.size < 0 ||
        identity.size > LIMITS.source) throw new Error('Invalid source identity.');
  }
  if (!Array.isArray(report.errors) || report.errors.length > LIMITS.errors ||
      !Array.isArray(report.issues) || report.issues.length > LIMITS.errors ||
      !report.issues.every(value => string(value))) throw new Error('Invalid report errors or issues.');
  const site = value => value && absolute(value.file) && Object.hasOwn(report.sources, value.file) &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end > value.start &&
    value.end <= LIMITS.source;
  const ids = new Set();
  for (const error of report.errors) {
    if (!error || !string(error.id, 256) || ids.has(error.id) ||
        !['undefined-command', 'compiler-error'].includes(error.kind) ||
        !['exact', 'candidate', 'unresolved'].includes(error.status) || !string(error.message) ||
        (error.command !== undefined && !string(error.command, 1024)) ||
        !error.reported || !absolute(error.reported.file) ||
        !(Number.isSafeInteger(error.reported.line) && error.reported.line >= 1 ||
          error.status === 'unresolved' && error.reported.line === null) ||
        !Array.isArray(error.candidates) || error.candidates.length > LIMITS.sites || !error.candidates.every(site) ||
        !Array.isArray(error.related) || error.related.length > LIMITS.sites ||
        !error.related.every(value => site(value) && string(value.label, 1024)) ||
        !Array.isArray(error.evidence) || error.evidence.length > LIMITS.sites || !error.evidence.every(value => string(value)) ||
        (error.range !== undefined && !site(error.range)) || (error.status === 'exact' && !site(error.range))) {
      throw new Error('Invalid error location or evidence.');
    }
    ids.add(error.id);
  }
  return report;
}

function createController(vscode, dependencies = {}) {
  const io = dependencies.fs || fs;
  const now = dependencies.now || Date.now;
  const subscriptions = [];
  const knownReports = new Set();
  const latest = new Map();
  const invalidBuilds = new Set();
  const sourceFiles = new Set();
  const records = new Map();
  const pathAliases = new Map();
  const reportSignatures = new Map();
  const structural = new Map();
  const lintTimers = new Map();
  let active = [];
  let generation = 0;
  let invalidatedAt = 0;
  let disposed = false;
  let timer;
  let sourceTimer;
  let pollInFlight = false;
  let sourceCheckInFlight = false;
  let debounce;
  const waiting = 'Waiting for a wrapped LaTeX build. Run Errata: Enable for This Project to configure the build.';
  let status = waiting;
  let lastDiscovery = -Infinity;
  let refreshesInFlight = 0;
  let nextIndex = -1;
  const output = vscode.window.createOutputChannel('Errata');
  const decoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy #cc2020',
    backgroundColor: vscode.workspace.getConfiguration('latexExact').get('background', false) ? '#fff0a833' : undefined,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  const structureDecoration = vscode.window.createTextEditorDecorationType({
    color: '#b87900', textDecoration: 'underline wavy', backgroundColor: '#ffd54f30',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  subscriptions.push(output, decoration, structureDecoration);
  const trusted = () => vscode.workspace.isTrusted === true;
  const knownPath = file => {
    const resolved = canonical(file);
    if (pathAliases.has(resolved)) return pathAliases.get(resolved);
    for (const [alias, real] of pathAliases) if (within(resolved, alias)) return path.join(real, path.relative(alias, resolved));
    return resolved;
  };
  const documentFor = file => vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && knownPath(doc.uri.fsPath) === knownPath(file));
  const buildKey = report => `${canonical(report.rootFile)}\0${report.buildId}`;
  const workspaceContains = file => (vscode.workspace.workspaceFolders || []).some(folder =>
    folder.uri.scheme === 'file' && within(knownPath(file), knownPath(folder.uri.fsPath)));
  const documentKey = doc => doc.uri.toString();
  const isLatex = doc => ['latex', 'latex-expl3', 'tex'].includes(doc.languageId) ||
    /\.(?:tex|sty|cls|ltx)$/i.test(doc.uri.fsPath || '');

  function structureMarkdown(hint) {
    const result = new vscode.MarkdownString();
    result.isTrusted = false;
    result.supportHtml = false;
    result.appendText(`${hint.message}\n\nLive structural hint (${hint.confidence}). This comes from the current source, without compiling.\n\n`);
    if (/unclosed/.test(hint.code)) result.appendText('This highlights a likely unmatched opening token. The compiler may report a later line.');
    for (const related of (hint.related || []).slice(0, 10)) result.appendText(`\n\n${related.message}`);
    return result;
  }

  function renderStructure() {
    for (const editor of vscode.window.visibleTextEditors) {
      const entry = structural.get(documentKey(editor.document));
      const options = trusted() && entry && entry.text === editor.document.getText() ? entry.hints.map(hint => {
        let start = hint.start;
        let end = hint.end;
        let renderOptions;
        if (hint.code === 'alignment-paragraph' && /^\s*$/.test(entry.text.slice(start, end))) {
          const lineStart = entry.text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
          const nextLine = entry.text.indexOf('\n', start);
          const lineEnd = nextLine < 0 ? entry.text.length : nextLine;
          start = entry.text.slice(lineStart, lineEnd).trim() === '' ? lineStart : Math.min(hint.end, lineEnd + 1);
          end = start;
          renderOptions = { after: { contentText: '← blank line inside alignment', color: '#b87900', margin: '0 0 0 1em' } };
        }
        return { range: new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end)),
          hoverMessage: structureMarkdown(hint), ...(renderOptions ? { renderOptions } : {}) };
      }) : [];
      editor.setDecorations(structureDecoration, options);
    }
  }

  function scheduleStructure(doc, immediate = false) {
    if (dependencies.externalLive) return;
    const key = documentKey(doc);
    if (lintTimers.has(key)) clearTimeout(lintTimers.get(key));
    lintTimers.delete(key);
    // Old offsets must never survive a text change while the next scan is debounced.
    if (structural.has(key) && structural.get(key).text !== doc.getText()) {
      structural.delete(key); renderStructure();
    }
    const config = vscode.workspace.getConfiguration('latexExact', doc.uri);
    if (disposed || !trusted() || !isLatex(doc) || !config.get('liveStructure', true)) {
      structural.delete(key); renderStructure(); return;
    }
    const lint = () => {
      lintTimers.delete(key);
      if (disposed || doc.isClosed) return;
      const text = doc.getText();
      if (text.length > 2 * 1024 * 1024) { structural.delete(key); renderStructure(); return; }
      try {
        const analyze = dependencies.analyzeStructure || require('./structure').analyzeStructure;
        const hints = analyze(text, { file: doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined }).filter(hint =>
          hint && string(hint.code, 128) && string(hint.message) && ['certain', 'suspected'].includes(hint.confidence) &&
          Number.isSafeInteger(hint.start) && Number.isSafeInteger(hint.end) && hint.start >= 0 && hint.end > hint.start && hint.end <= text.length);
        structural.set(key, { file: doc.uri.scheme === 'file' ? doc.uri.fsPath : doc.uri.toString(), text, hints: hints.slice(0, 1000) });
      } catch (error) {
        structural.delete(key);
        output.appendLine(`Live structural check unavailable: ${error.message}`);
      }
      renderStructure();
    };
    const configuredDelay = Number(config.get('lintDelay', 150));
    const delay = Number.isFinite(configuredDelay) ? Math.max(0, Math.min(2000, configuredDelay)) : 150;
    if (immediate) lint(); else lintTimers.set(key, setTimeout(lint, delay));
  }

  function scanOpenDocuments() {
    for (const doc of vscode.workspace.textDocuments) if (isLatex(doc)) scheduleStructure(doc, true);
  }

  async function refreshAliases() {
    if (!io.realpath) return;
    const uris = [...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
      ...vscode.workspace.textDocuments.map(doc => doc.uri)];
    for (const uri of uris) {
      if (uri.scheme !== 'file') continue;
      try { pathAliases.set(canonical(uri.fsPath), canonical(await io.realpath(uri.fsPath))); }
      catch { /* A deleted file will fail its source validation below. */ }
    }
  }

  function clear(message) {
    active = [];
    nextIndex = -1;
    status = message;
    render();
  }

  function invalidate(message) {
    generation++;
    invalidatedAt = Math.max(invalidatedAt, now());
    for (const record of records.values()) if (record.report) invalidBuilds.add(buildKey(record.report));
    clear(message);
  }

  function relevant(uri) {
    return uri && uri.scheme === 'file' &&
      (sourceFiles.has(knownPath(uri.fsPath)) || /\.(?:tex|sty|cls|bib|bst|clo|def|ltx|cfg)$/i.test(uri.fsPath));
  }

  function markdown(error, report, texts) {
    const result = new vscode.MarkdownString();
    result.isTrusted = false;
    result.supportHtml = false;
    result.appendText(`${error.command ? `${error.command}: ` : ''}${error.message}\n\n`);
    result.appendText(`Location: ${error.status}. Build ${report.buildId}.\n\n`);
    if (report.phase === 'streaming') result.appendText('The compiler is still running. This error has already been confirmed by its output.\n\n');
    if (error.evidence.length) result.appendText(error.evidence.slice(0, 12).join('\n').slice(0, 12000));
    for (const related of error.related.slice(0, 20)) {
      const text = texts.get(related.file) || '';
      const line = text.slice(0, related.start).split('\n').length;
      const label = `${related.label}: ${path.basename(related.file)}:${line}`.replace(/[\\[\]()`*_<>]/g, '\\$&');
      const uri = vscode.Uri.file(related.file).with({ fragment: `L${line}` }).toString().replace(/[()]/g, value => encodeURIComponent(value));
      result.appendMarkdown(`\n\n[${label}](${uri})`);
    }
    return result;
  }

  function render() {
    for (const editor of vscode.window.visibleTextEditors) {
      const options = [];
      if (trusted() && editor.document.uri.scheme === 'file' && !editor.document.isDirty) {
        const file = knownPath(editor.document.uri.fsPath);
        for (const entry of active) {
          if (knownPath(entry.error.range.file) !== file) continue;
          options.push({ range: new vscode.Range(editor.document.positionAt(entry.error.range.start),
            editor.document.positionAt(entry.error.range.end)), hoverMessage: markdown(entry.error, entry.report, entry.texts) });
        }
      }
      editor.setDecorations(decoration, options);
    }
  }

  async function readLimited(file, limit) {
    const stat = await io.stat(file);
    if (!stat.isFile() || stat.size > limit) throw new Error(`File exceeds the supported size: ${file}`);
    // An open handle plus a bounded read avoids an unbounded allocation if the file grows after stat.
    if (io.open) {
      const handle = await io.open(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
        let count = 0;
        while (count < buffer.length) {
          const chunk = await handle.read(buffer, count, buffer.length - count, count);
          if (!chunk.bytesRead) break;
          count += chunk.bytesRead;
        }
        if (count > stat.size) throw new Error(`File changed while being read: ${file}`);
        return buffer.subarray(0, count);
      } finally { await handle.close(); }
    }
    const result = await io.readFile(file);
    if (result.length > limit) throw new Error(`File exceeds the supported size: ${file}`);
    return result;
  }

  async function discover(force) {
    const paths = new Set(knownReports);
    const folders = vscode.workspace.workspaceFolders || [];
    const configurations = [vscode.workspace.getConfiguration('latexExact')];
    for (const folder of folders) configurations.push(vscode.workspace.getConfiguration('latexExact', folder.uri));
    for (let index = 0; index < configurations.length; index++) {
      const configured = configurations[index].get('reportPaths', []);
      if (!Array.isArray(configured)) continue;
      for (const value of configured) {
        if (typeof value !== 'string' || value.includes('\0') || value.length > 4096) continue;
        if (absolute(value)) paths.add(canonical(value));
        else for (const folder of (index ? [folders[index - 1]] : folders)) {
          if (folder.uri.scheme === 'file') paths.add(path.resolve(folder.uri.fsPath, value));
        }
      }
    }
    // Know likely output paths before the first build, even when users exclude them from watching/search.
    for (const folder of folders) {
      if (folder.uri.scheme !== 'file') continue;
      const workshop = vscode.workspace.getConfiguration('latex-workshop', folder.uri);
      const configured = workshop.get('latex.outDir', '%DIR%');
      const roots = new Map([[folder.uri.fsPath, 'main']]);
      for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === 'file' && isLatex(doc) && within(doc.uri.fsPath, folder.uri.fsPath)) {
        roots.set(path.dirname(doc.uri.fsPath), path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath)));
        const rootHint = /^\s*%\s*!\s*TeX\s+root\s*=\s*(.+?)\s*$/im.exec(doc.getText());
        if (rootHint) {
          const root = path.resolve(path.dirname(doc.uri.fsPath), rootHint[1]);
          roots.set(path.dirname(root), path.basename(root, path.extname(root)));
        }
      }
      for (const [directory, basename] of [...roots].slice(0, 32)) {
        paths.add(path.join(directory, '.latex-build', '.latex-exact', 'report.json'));
        paths.add(path.join(directory, '.latex-exact', 'report.json'));
        if (typeof configured !== 'string') continue;
        const out = configured.replace(/%DIR%/g, directory).replace(/%DOCFILE%/g, basename)
          .replace(/%WORKSPACE_FOLDER%/g, folder.uri.fsPath).replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
        if (out.includes('%') || out.includes('\0') || out.length > 4096) continue;
        paths.add(path.resolve(directory, out, '.latex-exact', 'report.json'));
      }
    }
    if (force || !Number.isFinite(lastDiscovery)) {
      // null intentionally bypasses files.exclude and search.exclude; users commonly hide build directories.
      const found = dependencies.findReports ? await dependencies.findReports() :
        await vscode.workspace.findFiles('**/.latex-exact/report.json', null, 128);
      for (const uri of found) {
        if (uri.scheme === 'file' && !uri.fsPath.split(path.sep).some(part => part === 'node_modules' || part === '.git')) paths.add(canonical(uri.fsPath));
      }
      lastDiscovery = now();
    }
    for (const file of paths) knownReports.add(file);
    return [...paths].slice(0, 256);
  }

  async function fileSignature(file) {
    try {
      const stat = await io.stat(file);
      return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    } catch (error) { return error.code === 'ENOENT' ? 'missing' : `error:${error.code || error.message}`; }
  }

  async function pollReports() {
    if (disposed || !trusted() || pollInFlight || refreshesInFlight) return;
    pollInFlight = true;
    try {
      const signatures = await Promise.all([...knownReports].slice(0, 256).map(async file => [file, await fileSignature(file)]));
      if (disposed || refreshesInFlight) return;
      let changed = false;
      for (const [file, signature] of signatures) {
        if (reportSignatures.has(file) ? reportSignatures.get(file) !== signature : signature !== 'missing') changed = true;
        reportSignatures.set(file, signature);
      }
      if (changed) {
        generation++;
        clear('Build report changed; validating the latest build.');
        await refresh();
      }
    } finally { pollInFlight = false; }
  }

  async function verifyActiveSources() {
    if (disposed || !trusted() || sourceCheckInFlight || refreshesInFlight || !active.length) return;
    sourceCheckInFlight = true;
    const ticket = generation;
    try {
      const reports = new Map(active.map(entry => [buildKey(entry.report), entry.report]));
      for (const report of reports.values()) await verify(report, ticket);
    } catch (error) {
      if (ticket === generation && !disposed) invalidate(error.message);
    } finally { sourceCheckInFlight = false; }
  }

  async function verify(report, ticket) {
    const texts = new Map();
    let total = 0;
    if (!Object.hasOwn(report.sources, canonical(report.rootFile))) throw new Error('The build does not identify its root source.');
    for (const [file, identity] of Object.entries(report.sources)) {
      if (ticket !== generation || disposed) throw new Error('Validation superseded.');
      total += identity.size;
      if (total > LIMITS.total) throw new Error('Build sources exceed the validation limit.');
      const doc = documentFor(file);
      if (doc && doc.isDirty) throw new Error(`Unsaved changes: ${file}`);
      const bytes = await readLimited(file, LIMITS.source);
      if (bytes.length !== identity.size || hash(bytes) !== identity.hash) throw new Error(`Source changed after this build: ${file}`);
      const text = bytes.toString('utf8');
      if (doc && doc.getText() !== text) throw new Error(`Open document differs from this build: ${file}`);
      texts.set(file, text);
      texts.set(knownPath(file), text);
    }
    // Verify every location against the decoded UTF-16 source, including candidates and related sites.
    for (const error of report.errors) {
      for (const site of [...error.candidates, ...error.related, ...(error.range ? [error.range] : [])]) {
        if (site.end > texts.get(site.file).length) throw new Error('A reported location exceeds the source length.');
      }
      if (error.status === 'exact' && (error.kind !== 'undefined-command' || !error.command ||
          texts.get(error.range.file).slice(error.range.start, error.range.end) !== error.command)) {
        throw new Error('An exact location does not match its failing command.');
      }
    }
    return texts;
  }

  async function processRefresh(forceDiscovery = false) {
    if (disposed) return;
    const ticket = ++generation;
    if (!trusted()) { clear('Errata requires a trusted workspace.'); return; }
    await refreshAliases();
    if (ticket !== generation || disposed) return;
    let paths;
    try { paths = await discover(forceDiscovery); }
    catch (error) { if (ticket === generation) clear(`Unable to discover build reports: ${error.message}`); return; }
    if (ticket !== generation || disposed) return;
    const candidates = new Map();
    let invalid = false;
    for (const file of paths) {
      try {
        reportSignatures.set(file, await fileSignature(file));
        const bytes = await readLimited(file, LIMITS.report);
        const report = validateReport(JSON.parse(bytes.toString('utf8')));
        if (!workspaceContains(report.rootFile)) throw new Error('The report root is outside this workspace.');
        if (ticket !== generation || disposed) return;
        records.set(file, { report });
        for (const source of Object.keys(report.sources)) sourceFiles.add(knownPath(source));
        const root = canonical(report.rootFile);
        const previous = candidates.get(root);
        if (!previous || Date.parse(report.startedAt) >= Date.parse(previous.report.startedAt)) candidates.set(root, { file, report });
      } catch (error) {
        if (ticket !== generation || disposed) return;
        if (error.code === 'ENOENT') { records.delete(file); continue; }
        records.set(file, { error: `Ignored report ${file}: ${error.message}` });
        invalid = true;
      }
    }
    if (ticket !== generation || disposed) return;
    // A corrupt replacement cannot leave previous decorations visible or revive an older report.
    if (invalid) {
      for (const { report } of candidates.values()) invalidBuilds.add(buildKey(report));
      clear('A build report is invalid. See Errata: Show Build Details.'); return;
    }
    const activeBuilds = new Set(active.map(entry => buildKey(entry.report)));
    const unchangedSelection = candidates.size && [...candidates.values()].every(({ report }) =>
      report.phase !== 'running' && activeBuilds.has(buildKey(report)) && !report.stale);
    if (!unchangedSelection) clear(candidates.size ? 'Validating the latest build sources.' : waiting);
    const result = [];
    const messages = [];
    for (const { file, report } of candidates.values()) {
      const root = canonical(report.rootFile);
      const key = buildKey(report);
      const started = Date.parse(report.startedAt);
      const phaseOrder = { running: 0, streaming: 1, complete: 2 }[report.phase];
      const observed = Date.parse(report.phase === 'streaming' ? report.observedAt : report.phase === 'complete' ? report.completedAt : report.startedAt);
      const high = latest.get(root);
      if (high && (started < high.started || (started === high.started && key !== high.key) ||
          (key === high.key && (phaseOrder < high.phaseOrder || (phaseOrder === high.phaseOrder && observed < high.observed))))) {
        messages.push('An older build was ignored; rebuild to refresh.'); continue;
      }
      latest.set(root, { started, key, phaseOrder, observed });
      if (report.phase === 'running') { messages.push('Build in progress; previous highlights cleared.'); continue; }
      if (report.stale || invalidBuilds.has(key) || started <= invalidatedAt) {
        messages.push('Sources changed or this build is stale; rebuild to refresh.'); continue;
      }
      try {
        const texts = await verify(report, ticket);
        if (ticket !== generation || disposed || !trusted()) return;
        // A newer report written while source hashing was in progress supersedes this candidate.
        const current = validateReport(JSON.parse((await readLimited(file, LIMITS.report)).toString('utf8')));
        if (JSON.stringify(current) !== JSON.stringify(report)) {
          schedule(); return;
        }
        if (ticket !== generation || disposed) return;
        for (const [source, text] of texts) {
          const doc = documentFor(source);
          if (doc && (doc.isDirty || doc.getText() !== text)) throw new Error(`Open document changed during validation: ${source}`);
        }
        for (const error of report.errors) if (error.status === 'exact') result.push({ error, report, texts });
        const unresolved = report.errors.filter(error => error.status !== 'exact').length;
        messages.push(`${path.basename(root)}: ${report.phase === 'streaming' ? 'compiler still running; ' : ''}${report.errors.length} compiler error(s)${report.phase === 'streaming' ? ' confirmed so far' : ''}, ${unresolved} without an exact location.`);
      } catch (error) {
        if (ticket !== generation || disposed) return;
        invalidBuilds.add(key);
        messages.push(error.message);
      }
    }
    if (ticket !== generation || disposed) return;
    active = result;
    status = messages.join('\n') || waiting;
    render();
  }

  async function refresh(forceDiscovery = false) {
    refreshesInFlight++;
    try { await processRefresh(forceDiscovery); }
    finally { refreshesInFlight--; }
  }

  function schedule(force = false, delay = 35) {
    if (disposed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = undefined; void refresh(force); }, delay);
  }

  function reportChanged(uri) {
    if (!uri || uri.scheme !== 'file') return;
    const file = canonical(uri.fsPath);
    if (knownReports.has(file) || /[\\/]\.latex-exact[\\/]report\.json$/.test(file)) {
      knownReports.add(file);
      generation++;
      clear('Build report changed; validating the latest build.');
      schedule();
    } else if (relevant(uri)) invalidate('Source or dependency changed; rebuild to refresh highlights.');
  }

  function showDetails() {
    output.clear();
    output.appendLine(status);
    for (const entry of structural.values()) for (const hint of entry.hints) {
      const before = entry.text.slice(0, hint.start).split('\n');
      output.appendLine(`\n[Live structural hint: ${hint.confidence}] ${hint.message}`);
      output.appendLine(`${entry.file}:${before.length}:${before.at(-1).length + 1}`);
    }
    for (const [file, record] of records) {
      output.appendLine(`\nReport: ${file}`);
      if (record.error) { output.appendLine(record.error); continue; }
      const report = record.report;
      output.appendLine(`Build ${report.buildId}; ${report.phase}; root ${report.rootFile}; exit ${report.exitCode}`);
      for (const issue of report.issues) output.appendLine(`Build note: ${issue}`);
      for (const error of report.errors) {
        output.appendLine(`\n[${error.status}] ${error.command || ''} ${error.message}`);
        output.appendLine(`Compiler reported: ${error.reported.file}${error.reported.line === null ? ' (no source line)' : `:${error.reported.line}`}`);
        if (error.range) output.appendLine(`Resolved token: ${error.range.file} [${error.range.start}, ${error.range.end})`);
        for (const candidate of error.candidates) output.appendLine(`Candidate: ${candidate.file} [${candidate.start}, ${candidate.end})`);
        for (const related of error.related) output.appendLine(`${related.label}: ${related.file} [${related.start}, ${related.end})`);
        for (const evidence of error.evidence) output.appendLine(`Evidence: ${evidence}`);
        if (error.status !== 'exact') output.appendLine('No token is highlighted because the available compiler evidence does not establish one source occurrence.');
      }
    }
    output.show(true);
  }

  async function nextError() {
    if (!trusted()) return;
    if (!active.length) { showDetails(); return; }
    nextIndex = (nextIndex + 1) % active.length;
    const entry = active[nextIndex];
    const ticket = generation;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.error.range.file));
    if (ticket !== generation || doc.isDirty || doc.getText() !== entry.texts.get(entry.error.range.file)) {
      invalidate('Source changed; rebuild to refresh highlights.'); return;
    }
    const editor = await vscode.window.showTextDocument(doc);
    if (ticket !== generation || !active.includes(entry)) return;
    const range = new vscode.Range(doc.positionAt(entry.error.range.start), doc.positionAt(entry.error.range.end));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  function start() {
    subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.contentChanges.length) return;
      if (isLatex(event.document)) scheduleStructure(event.document);
      if (relevant(event.document.uri)) invalidate('Source edited; rebuild to refresh compiler highlights.');
    }));
    subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
      if (isLatex(doc)) {
        scheduleStructure(doc, true);
        // A root opened after activation may put its excluded build output in a new subdirectory.
        void discover(false).catch(error => output.appendLine(`Report discovery: ${error.message}`));
      }
      if (!relevant(doc.uri)) return;
      for (const entry of active) {
        const text = entry.texts.get(knownPath(doc.uri.fsPath));
        if (text !== undefined && (doc.isDirty || text !== doc.getText())) {
          invalidate('Open source differs from this build; rebuild to refresh highlights.'); break;
        }
      }
    }));
    if (vscode.workspace.onDidCloseTextDocument) subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
      const key = documentKey(doc);
      if (lintTimers.has(key)) clearTimeout(lintTimers.get(key));
      lintTimers.delete(key); structural.delete(key);
    }));
    subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => {
      render();
      for (const editor of vscode.window.visibleTextEditors) if (isLatex(editor.document)) scheduleStructure(editor.document, true);
    }));
    subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('latexExact') || event.affectsConfiguration('latex-workshop')) {
        generation++; clear('Configuration changed; refreshing build reports.'); scanOpenDocuments(); schedule(true);
      }
    }));
    if (vscode.workspace.onDidGrantWorkspaceTrust) subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { scanOpenDocuments(); schedule(true); }));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    subscriptions.push(watcher, watcher.onDidCreate(reportChanged), watcher.onDidChange(reportChanged), watcher.onDidDelete(reportChanged));
    subscriptions.push(vscode.commands.registerCommand('latexExact.nextError', nextError));
    subscriptions.push(vscode.commands.registerCommand('latexExact.showDetails', showDetails));
    subscriptions.push(vscode.commands.registerCommand('latexExact.refresh', () => refresh(true)));
    if (vscode.languages.onDidChangeDiagnostics) subscriptions.push(vscode.languages.onDidChangeDiagnostics(event => {
      // Problems updates are an extra signal to check for fresh reports; compiler output can arrive before a build exits.
      // Validate immediately without interpreting diagnostic text, waiting for polling, or searching the workspace again.
      if (!trusted() || !event.uris.some(uri => relevant(uri) && (workspaceContains(uri.fsPath) ||
          documentFor(uri.fsPath) || sourceFiles.has(knownPath(uri.fsPath))))) return;
      generation++;
      schedule(false, 0);
    }));
    subscriptions.push(vscode.languages.registerHoverProvider([{ scheme: 'file' },
      { scheme: 'untitled', language: 'latex' }, { scheme: 'untitled', language: 'tex' }], {
      provideHover(doc, position) {
        if (!trusted()) return undefined;
        const file = knownPath(doc.uri.fsPath);
        const offset = doc.offsetAt(position);
        for (const entry of doc.isDirty ? [] : active) {
          if (entry.texts.get(file) !== doc.getText()) continue;
          for (const site of [entry.error.range, ...entry.error.related]) {
            if (knownPath(site.file) === file && offset >= site.start && offset < site.end) return new vscode.Hover(
              markdown(entry.error, entry.report, entry.texts), new vscode.Range(doc.positionAt(site.start), doc.positionAt(site.end)));
          }
        }
        const live = structural.get(documentKey(doc));
        if (live && live.text === doc.getText()) for (const hint of live.hints) {
          if (offset >= hint.start && offset < hint.end) return new vscode.Hover(structureMarkdown(hint),
            new vscode.Range(doc.positionAt(hint.start), doc.positionAt(hint.end)));
        }
        return undefined;
      }
    }));
    // Fast metadata-only polling handles excluded output directories without rereading source or repainting unchanged results.
    if (dependencies.pollInterval !== 0) {
      const repeat = dependencies.setInterval || setInterval;
      timer = repeat(() => pollReports(), dependencies.pollInterval || 175);
      sourceTimer = repeat(() => verifyActiveSources(), dependencies.sourceCheckInterval || 3000);
      if (timer.unref) timer.unref();
      if (sourceTimer.unref) sourceTimer.unref();
    }
    scanOpenDocuments();
    void refresh(true);
  }

  return {
    start, refresh, invalidate, showDetails, nextError,
    getState: () => ({ status, generation, exact: active.map(entry => ({ buildId: entry.report.buildId,
      id: entry.error.id, command: entry.error.command, range: { ...entry.error.range } })),
      structural: [...structural.values()].flatMap(entry => entry.hints.map(hint => ({
        ...hint, file: entry.file, range: { file: entry.file, start: hint.start, end: hint.end }
      }))),
      reports: [...records].map(([file, record]) => ({ file, buildId: record.report?.buildId,
        phase: record.report?.phase, error: record.error })) }),
    dispose() {
      disposed = true; generation++;
      const cancel = dependencies.clearInterval || clearInterval;
      if (timer) cancel(timer);
      if (sourceTimer) cancel(sourceTimer);
      if (debounce) clearTimeout(debounce);
      for (const pending of lintTimers.values()) clearTimeout(pending);
      lintTimers.clear(); structural.clear(); renderStructure();
      clear('Errata is inactive.');
      for (const disposable of subscriptions.reverse()) disposable.dispose();
    }
  };
}

let controller;
let liveController;
function activate(context) {
  const vscode = require('vscode');
  controller = createController(vscode, { externalLive: true });
  liveController = require('./live/controller').createLiveController(vscode);
  require('./configure').registerConfigurationCommands(vscode, context);
  context.subscriptions.push(controller, liveController);
  controller.start();
  liveController.start();
  return { getState: () => ({ ...controller.getState(),
    structural: liveController.getState().documents.flatMap(d => d.findings.filter(f => f.code !== 'unknown-command').map(f => ({
      ...f, confidence: 'suspected', range: { file: f.file, start: f.start, end: f.end }
    }))) }), getLiveState: liveController.getState, refresh: controller.refresh, refreshLive: liveController.refresh };
}
function deactivate() { if (controller) controller.dispose(); liveController?.dispose(); controller = undefined; liveController = undefined; }

module.exports = { activate, deactivate, createController, validateReport };
