'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const manifest = require('../../package.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(15); }
  throw new Error(message);
}

async function run() {
  const root = process.env.LATEX_EXACT_WS_TRACE_ROOT;
  const project = process.env.LATEX_EXACT_WS_TRACE_PROJECT;
  const workshopRoot = process.env.LATEX_EXACT_WS_TRACE_WORKSHOP;
  assert.ok(root && project && workshopRoot, 'Launch with test/workshop-host/run.js.');
  const events = [];
  const record = (event, details = {}) => { const item = { at: Date.now(), event, ...details }; events.push(item); return item; };
  const sourceUri = vscode.Uri.file(path.join(project, 'main.tex'));
  const reportPath = path.join(project, '.latex-build', '.latex-exact', 'report.json');
  const disposables = [];
  let timer;
  let pollBusy = false;
  let currentCase = 'activation';
  let api;
  let workshopLogger;
  let seenLogs = 0;
  let stateSignature;
  let reportSignature;
  let latestReport;
  const cases = [];
  try {
    disposables.push(vscode.languages.onDidChangeDiagnostics(change => {
      for (const uri of change.uris) {
        if (uri.fsPath !== sourceUri.fsPath) continue;
        record('diagnostics-event', { case: currentCase, uri: uri.toString(), diagnostics: vscode.languages.getDiagnostics(uri).map(d => ({
          source: d.source, message: d.message, severity: d.severity,
          range: { start: d.range.start, end: d.range.end },
        })) });
      }
    }));
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    const exact = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
    assert.ok(workshop && exact, 'Both real development extensions must be loaded.');
    await workshop.activate();
    record('workshop-activated', { version: workshop.packageJSON.version, path: workshop.extensionPath });
    assert.equal(await fs.realpath(workshop.extensionPath), await fs.realpath(workshopRoot));
    // Read the real extension's already-loaded log cache. No log parser, diagnostic collection, or API is replaced.
    workshopLogger = require(path.join(workshopRoot, 'out', 'src', 'utils', 'logger.js')).log;
    api = await exact.activate();
    record('exact-activated', { version: exact.packageJSON.version, path: exact.extensionPath });
    assert.equal(typeof api.getState, 'function');
    const doc = await vscode.workspace.openTextDocument(sourceUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    const expectedStart = doc.getText().indexOf('\\alhpa');
    assert.ok(expectedStart >= 0);
    await sleep(500);

    const poll = async () => {
      if (pollBusy) return;
      pollBusy = true;
      try {
        const state = api.getState();
        const signature = JSON.stringify({ status: state.status, exact: state.exact, reports: state.reports });
        if (signature !== stateSignature) { stateSignature = signature; record('exact-state', { case: currentCase, state }); }
        try {
          const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
          const reportKey = JSON.stringify({ buildId: report.buildId, phase: report.phase, completedAt: report.completedAt,
            stale: report.stale, errors: report.errors, sequence: report.sequence });
          if (reportKey !== reportSignature) {
            reportSignature = reportKey; latestReport = report;
            record('report-observed', { case: currentCase, buildId: report.buildId, phase: report.phase,
              startedAt: report.startedAt, completedAt: report.completedAt, stale: report.stale, errors: report.errors });
          }
        } catch (error) { if (error.code !== 'ENOENT') record('report-read-error', { case: currentCase, message: error.message }); }
        const logs = workshopLogger.getCachedLog().CACHED_EXTLOG;
        while (seenLogs < logs.length) record('workshop-log', { case: currentCase, text: logs[seenLogs++] });
      } finally { pollBusy = false; }
    };
    timer = setInterval(() => { void poll(); }, 10);
    await poll();
    for (const [name, recipe, label] of [
      ['normal', 'Trace normal', 'trace-normal'], ['slow-tail', 'Trace slow tail', 'trace-slow-tail'],
    ]) {
      currentCase = name;
      const previousBuild = latestReport?.buildId;
      const began = record('build-command', { case: name, recipe });
      let commandReturned = false;
      let commandError;
      const build = vscode.commands.executeCommand('latex-workshop.recipes', recipe).then(() => {
        commandReturned = true; record('build-command-returned', { case: name });
      }, error => { commandError = error; commandReturned = true; record('build-command-error', { case: name, message: error.message }); });
      await until(() => latestReport && latestReport.buildId !== previousBuild && latestReport.phase === 'complete',
        `No completed actual Workshop build report: ${JSON.stringify(api.getState())}`);
      const buildId = latestReport.buildId;
      await until(() => api.getState().exact.some(error => error.buildId === buildId), 'No exact highlight for actual Workshop build.');
      await until(() => events.some(event => event.case === name && event.event === 'diagnostics-event' &&
        event.diagnostics.some(d => d.source === 'LaTeX' && /Undefined control sequence/.test(d.message))),
      'The actual LaTeX Workshop extension did not publish the expected Problems entry.');
      await until(() => commandReturned, 'Workshop build command did not return.');
      await build;
      if (commandError) throw commandError;
      await sleep(250);
      await poll();
      const exactRange = api.getState().exact.find(error => error.buildId === buildId);
      assert.equal(exactRange.range.start, expectedStart);
      assert.equal(exactRange.range.end, expectedStart + 6);
      const hover = await vscode.commands.executeCommand('vscode.executeHoverProvider', sourceUri, doc.positionAt(expectedStart + 1));
      const hoverMatched = hover.some(h => h.contents.some(c => /alhpa/.test(c.value || String(c))));
      record('hover-observed', { case: name, hoverMatched, contents: hover.map(h => h.contents) });
      const engineEvents = (await fs.readFile(path.join(project, 'engine-events.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.label === label);
      const relevant = events.filter(event => event.case === name && event.at >= began.at);
      const problem = relevant.find(event => event.event === 'diagnostics-event' && event.diagnostics.some(d => d.source === 'LaTeX' && /Undefined control sequence/.test(d.message)));
      const highlight = relevant.find(event => event.event === 'exact-state' && event.state.exact.some(error => error.buildId === buildId));
      const outcome = relevant.find(event => event.event === 'workshop-log' && /Recipe returns with error code/.test(event.text));
      const streaming = relevant.filter(event => event.event === 'report-observed' && event.phase === 'streaming');
      if (name === 'slow-tail' && process.env.LATEX_EXACT_WS_REQUIRE_STREAMING === '1') {
        assert.ok(streaming.some(event => event.errors.some(error => error.status === 'exact')), 'A real build must publish an exact streaming report.');
        const driverExit = engineEvents.find(event => event.event === 'driver-exit');
        assert.ok(highlight && driverExit && highlight.at < driverExit.at,
          `Streaming highlight must precede driver exit: highlight=${highlight?.at}, driver=${driverExit?.at}`);
        assert.ok(outcome && highlight.at < outcome.at, 'Streaming highlight must precede actual Workshop recipe failure.');
      }
      cases.push({ name, buildId, buildStartedAt: began.at, engineEvents, completedAt: latestReport.completedAt,
        streamingReports: streaming.map(event => ({ at: event.at, errors: event.errors })),
        problemEventAt: problem?.at, exactObservedAt: highlight?.at, recipeOutcomeLogObservedAt: outcome?.at,
        recipeOutcomeLog: outcome?.text, problemToExactMs: highlight && problem ? highlight.at - problem.at : null,
        completionToProblemMs: problem ? problem.at - Date.parse(latestReport.completedAt) : null,
        completionToExactMs: highlight ? highlight.at - Date.parse(latestReport.completedAt) : null,
        diagnostics: problem?.diagnostics, exact: exactRange, hoverMatched });
    }
    const result = { passed: true, application: vscode.env.appName, vscodeVersion: vscode.version,
      workshopVersion: workshop.packageJSON.version, exactVersion: exact.packageJSON.version,
      extensionSource: process.env.LATEX_EXACT_WS_TRACE_ORIGINAL, cases,
      limitations: ['Diagnostic API events and extension decoration state are measured, not UI pixel paint.',
        'Recipe outcome is timestamped through the real Workshop log; notification popup paint is not observed.',
        'Report and exact state are sampled every 10 ms; event-loop scheduling can increase sampling uncertainty.',
        'The slow-tail fixture is real pdfLaTeX followed by a controlled 1500 ms driver delay; no diagnostic is synthesized.'] };
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  } finally {
    if (timer) clearInterval(timer);
    for (const disposable of disposables) disposable.dispose();
    await fs.writeFile(path.join(root, 'trace.json'), JSON.stringify(events, null, 2));
    if (workshopLogger) {
      const logs = workshopLogger.getCachedLog();
      await fs.writeFile(path.join(root, 'workshop.log'), logs.CACHED_EXTLOG.join('\n'));
      await fs.writeFile(path.join(root, 'compiler.log'), logs.CACHED_COMPILER.join(''));
    }
  }
}
module.exports = { run };
