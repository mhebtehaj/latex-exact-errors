'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapTools, migrateTools, migrateConfiguredWorkspaces } = require('../src/configure');
test('wrapper preserves original compiler, arguments, and environment without double wrapping', () => {
  const input = [{ name: 'latexmk', command: '/Library/TeX/texbin/latexmk', args: ['-pdf', '-outdir=%OUTDIR%', '%DOC%'], env: { PATH: '/Library/TeX/texbin' } }, { name: 'biber', command: 'biber', args: ['%DOCFILE%'] }];
  const result = wrapTools(input, '/ext/bin/build.js', '/opt/homebrew/bin/node');
  assert.equal(result.count, 1);
  assert.deepEqual(result.tools[0].args.slice(-5), [input[0].command, '-recorder', ...input[0].args]);
  assert.deepEqual(result.tools[0].env, input[0].env);
  assert.equal(result.tools[1], input[1]);
  assert.equal(wrapTools(result.tools, '/ext/bin/build.js', 'node').count, 0);
});
test('custom job name is propagated to report log discovery', () => {
  const result = wrapTools([{ command: 'pdflatex', args: ['-jobname=paper', '%DOC%'] }], '/ext/bin/build.js', 'node');
  assert.ok(result.tools[0].args.includes('--jobname'));
  assert.ok(result.tools[0].args.includes('paper'));
});

test('extension upgrades replace only recognized wrapper paths', () => {
  const old = '/extensions/local.latex-exact-errors-0.1.0/bin/build.js';
  const next = '/extensions/local.latex-exact-errors-0.2.0/bin/build.js';
  const original = [{ command: 'node', args: [old, '--root', '%DOC%', '--', 'latexmk', '-pdf'] },
    { command: 'node', args: ['/custom/bin/build.js', '--root', '%DOC%', '--', 'latexmk'] }];
  const result = migrateTools(original, next);
  assert.equal(result.count, 1);
  assert.equal(result.tools[0].args[0], next);
  assert.deepEqual(result.tools[0].args.slice(1), original[0].args.slice(1));
  assert.equal(result.tools[1], original[1]);
  assert.equal(original[0].args[0], old);
});

test('migration preserves original restore backup and does not overwrite later user settings', async () => {
  const oldTools = [{ command: 'node', args: ['/extensions/local.latex-exact-errors-0.1.0/bin/build.js', '--root', '%DOC%', '--', 'latexmk'] }];
  const original = [{ command: 'latexmk', args: ['%DOC%'] }];
  let current = oldTools;
  let backup = { hadFolderValue: true, before: original, applied: oldTools };
  let writes = 0;
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { toString: () => 'file:///project' } }],
    getConfiguration: () => ({ inspect: () => ({ workspaceFolderValue: current }), update: async (_key, value) => { current = value; writes++; } }) },
    ConfigurationTarget: { WorkspaceFolder: 3 } };
  const context = { extensionPath: '/extensions/local.latex-exact-errors-0.2.0',
    workspaceState: { get: () => backup, update: async (_key, value) => { backup = value; } } };
  await migrateConfiguredWorkspaces(vscode, context);
  assert.equal(writes, 1);
  assert.ok(current[0].args[0].includes('0.2.0'));
  assert.deepEqual(backup.before, original);
  assert.deepEqual(backup.applied, current);
  current = [{ command: 'my-custom-compiler', args: [] }];
  context.extensionPath = '/extensions/local.latex-exact-errors-0.3.0';
  await migrateConfiguredWorkspaces(vscode, context);
  assert.equal(writes, 1);
  assert.equal(current[0].command, 'my-custom-compiler');
});
