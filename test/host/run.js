'use strict';

// Runs the real extension in an isolated editor profile. Never touches the user's open workspace.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { editorOptions, texEngine } = require('../host-options');

async function main() {
  const extensionRoot = path.resolve(__dirname, '../..');
  // macOS Unix-domain sockets have a short pathname limit; Cursor places IPC sockets under user-data.
  const temporaryRoot = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'lex-host-')));
  const project = path.join(temporaryRoot, 'project');
  const userData = path.join(temporaryRoot, 'user-data');
  const extensions = path.join(temporaryRoot, 'extensions');
  const stub = path.join(temporaryRoot, 'workshop-configuration-fixture');
  const workspace = path.join(temporaryRoot, 'host.code-workspace');
  const engine = texEngine();
  const editor = editorOptions();
  let passed = false;
  try {
    await Promise.all([fs.access(engine), fs.mkdir(path.join(project, '.vscode'), { recursive: true }),
      fs.mkdir(path.join(project, '.latex-build'), { recursive: true }), fs.mkdir(path.join(userData, 'User'), { recursive: true }),
      fs.mkdir(extensions), fs.mkdir(stub)]);
    const originalTools = [{ name: 'host-pdflatex', command: engine,
      args: ['-interaction=nonstopmode', '-file-line-error', '-recorder', '-no-shell-escape', '-output-directory=%OUTDIR%', '%DOC%'],
      env: { LATEX_EXACT_TEST_PRESERVED: 'yes' } }];
    const source = '\\documentclass{article}\n\\usepackage{amsmath}\n\\errorcontextlines=999\n\\begin{document}\n\\begin{align*}\na &= \\alhpa + 1 \\\\\nb &= 2\n\\end{align*}\n\\end{document}\n';
    await Promise.all([
      fs.writeFile(path.join(project, 'main.tex'), source),
      fs.writeFile(workspace, JSON.stringify({ folders: [{ path: project }], settings: {} }, null, 2)),
      fs.writeFile(path.join(project, '.vscode', 'settings.json'), JSON.stringify({
        'latex-workshop.latex.tools': originalTools, 'latex-workshop.latex.outDir': '.latex-build',
        'latexExact.nodePath': process.execPath,
        'files.watcherExclude': { '**/.latex-build/**': true }, 'files.exclude': { '**/.latex-build': true },
        'search.exclude': { '**/.latex-build': true }
      }, null, 2)),
      fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
        'workbench.enableExperiments': false, 'window.restoreWindows': 'none',
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
        'telemetry.telemetryLevel': 'off', 'files.autoSave': 'off'
      }, null, 2)),
      // Contribute only the settings used by setup, without installing or running LaTeX Workshop.
      fs.writeFile(path.join(stub, 'package.json'), JSON.stringify({
        name: 'latex-exact-host-workshop-config', publisher: 'local', version: '0.0.1', engines: { vscode: '^1.95.0' },
        contributes: { configuration: { properties: {
          'latex-workshop.latex.tools': { type: 'array', default: [], scope: 'resource' },
          'latex-workshop.latex.outDir': { type: 'string', default: '.latex-build', scope: 'resource' }
        } } }
      }, null, 2))
    ]);
    console.log(`Isolated Editor host fixture: ${temporaryRoot}`);
    await runTests({
      ...editor,
      extensionDevelopmentPath: [extensionRoot, stub], extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
        '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window'],
      extensionTestsEnv: {
        LATEX_EXACT_HOST_ROOT: temporaryRoot, LATEX_EXACT_HOST_PROJECT: project,
        LATEX_EXACT_HOST_EXTENSION: extensionRoot, LATEX_EXACT_HOST_NODE: process.execPath,
        LATEX_EXACT_HOST_ENGINE: engine
      }
    });
    const result = JSON.parse(await fs.readFile(path.join(temporaryRoot, 'result.json'), 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    passed = true;
  } finally {
    if (passed && process.env.LATEX_EXACT_HOST_KEEP !== '1') await fs.rm(temporaryRoot, { recursive: true, force: true });
    else console.log(`Editor host logs and fixtures retained at: ${temporaryRoot}`);
  }
}

main().catch(error => { console.error('Editor extension-host tests failed:', error); process.exitCode = 1; });
