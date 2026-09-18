'use strict';

// Actual Workshop integration; the user's profile, projects, and installed files are untouched.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { editorOptions, texEngine } = require('../host-options');

async function main() {
  const sourceExtensionRoot = process.env.LATEX_EXACT_WS_EXACT_ROOT || path.resolve(__dirname, '../..');
  const workshopRoot = process.env.LATEX_EXACT_WORKSHOP_ROOT;
  if (!workshopRoot) throw new Error('Set LATEX_EXACT_WORKSHOP_ROOT to your installed LaTeX Workshop extension directory.');
  const editor = editorOptions();
  const engine = texEngine();
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'lex-ws-')));
  const extensionRoot = path.join(root, 'exact-extension');
  const project = path.join(root, 'project');
  const userData = path.join(root, 'user');
  const extensions = path.join(root, 'extensions');
  const workspace = path.join(root, 'trace.code-workspace');
  const driver = path.join(root, 'compiler-trace.js');
  await Promise.all([fs.access(engine), fs.access(path.join(workshopRoot, 'package.json')),
    fs.mkdir(extensionRoot),
    fs.mkdir(path.join(project, '.vscode'), { recursive: true }), fs.mkdir(path.join(project, '.latex-build'), { recursive: true }),
    fs.mkdir(path.join(userData, 'User'), { recursive: true }), fs.mkdir(extensions)]);
  // Freeze the extension under test before launching the isolated host.
  await Promise.all(['src', 'bin', 'package.json'].map(name => fs.cp(path.join(sourceExtensionRoot, name), path.join(extensionRoot, name), { recursive: true })));
  const source = '\\documentclass{article}\n\\usepackage{amsmath}\n\\errorcontextlines=999\n\\begin{document}\n\\begin{align*}\na &= \\alhpa + 1 \\\\\nb &= 2\n\\end{align*}\n\\end{document}\n';
  const tool = (label, tailMs) => ({ name: label, command: process.execPath, args: [
    path.join(extensionRoot, 'bin', 'build.js'), '--root', '%DOC%', '--project', project, '--cwd', project,
    '--out-dir', '%OUTDIR%', '--', process.execPath, driver, label, String(tailMs), engine,
    '-interaction=nonstopmode', '-file-line-error', '-recorder', '-no-shell-escape', '-output-directory=%OUTDIR%', '%DOC%',
  ], env: { PATH: [path.dirname(engine), process.env.PATH || ''].join(path.delimiter) } });
  await Promise.all([
    fs.writeFile(path.join(project, 'main.tex'), source),
    fs.writeFile(workspace, JSON.stringify({ folders: [{ path: project }] }, null, 2)),
    fs.writeFile(path.join(project, '.vscode', 'settings.json'), JSON.stringify({
      'latex-workshop.latex.tools': [tool('trace-normal', 0), tool('trace-slow-tail', 1500)],
      'latex-workshop.latex.recipes': [
        { name: 'Trace normal', tools: ['trace-normal'] }, { name: 'Trace slow tail', tools: ['trace-slow-tail'] },
      ],
      'latex-workshop.latex.outDir': '%DIR%/.latex-build',
      'latex-workshop.latex.autoBuild.run': 'never', 'latex-workshop.latex.autoClean.run': 'never',
      'latex-workshop.latex.autoBuild.cleanAndRetry.enabled': false,
      'latex-workshop.message.log.show': true, 'latex-workshop.message.error.show': true,
      'latex-workshop.linting.chktex.enabled': false, 'latex-workshop.linting.lacheck.enabled': false,
      'latex-workshop.intellisense.package.enabled': false, 'latex-workshop.hover.preview.enabled': false,
      'latex-workshop.view.autoFocus.enabled': false, 'latexExact.nodePath': process.execPath,
      'files.watcherExclude': { '**/.latex-build/**': true }, 'files.exclude': { '**/.latex-build': true },
      'search.exclude': { '**/.latex-build': true }, 'files.autoSave': 'off',
    }, null, 2)),
    fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
      'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
      'workbench.enableExperiments': false, 'window.restoreWindows': 'none',
      'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
      'telemetry.telemetryLevel': 'off', 'files.autoSave': 'off',
    }, null, 2)),
    fs.writeFile(driver, `'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const [label, tailText, engine, ...args] = process.argv.slice(2);
const trace = (event, extra = {}) => fs.appendFileSync('engine-events.ndjson', JSON.stringify({label,event,at:Date.now(),...extra})+'\\n');
trace('engine-spawn');
const child = spawn(engine,args,{stdio:['inherit','pipe','pipe']});
let errorSeen=false;
child.stdout.on('data',data=>{process.stdout.write(data);if(!errorSeen&&data.toString().includes('Undefined control sequence')){errorSeen=true;trace('engine-error-output');}});
child.stderr.on('data',data=>process.stderr.write(data));
child.on('error',error=>{trace('engine-spawn-error',{message:error.message});process.exitCode=127;});
child.on('close',(code,signal)=>{trace('engine-close',{code,signal});setTimeout(()=>{trace('driver-exit',{code});process.exitCode=code??1;},Number(tailText));});
`),
  ]);
  console.log(`Actual Workshop isolated host trace: ${root}`);
  try {
    await runTests({ ...editor,
      extensionDevelopmentPath: [extensionRoot, workshopRoot], extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--disable-extensions',
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window'],
      extensionTestsEnv: { LATEX_EXACT_WS_TRACE_ROOT: root, LATEX_EXACT_WS_TRACE_PROJECT: project,
        LATEX_EXACT_WS_TRACE_WORKSHOP: workshopRoot, LATEX_EXACT_WS_TRACE_EXTENSION: extensionRoot,
        LATEX_EXACT_WS_TRACE_ORIGINAL: sourceExtensionRoot,
        LATEX_EXACT_WS_REQUIRE_STREAMING: process.env.LATEX_EXACT_WS_REQUIRE_STREAMING || '' },
    });
    console.log(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
  } finally { console.log(`Actual Workshop trace retained at ${root}`); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
