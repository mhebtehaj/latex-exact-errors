'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function pickNode(configured) {
  if (configured && configured !== 'node') return configured;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* Keep looking. */ }
  }
  return configured || 'node';
}

function wrapTools(tools, wrapper, node) {
  if (!Array.isArray(tools)) throw new Error('LaTeX Workshop has no configured build tools.');
  let count = 0;
  const wrapped = tools.map((tool) => {
    if (!tool || typeof tool.command !== 'string' || !Array.isArray(tool.args)) return tool;
    if (tool.args.includes(wrapper) || tool.args.some((a) => typeof a === 'string' && /latex-exact-errors[^/\\]*[/\\]bin[/\\]build\.js$/.test(a))) return tool;
    if (!/^(latexmk|pdflatex|xelatex|lualatex|latex|pdftex|xetex|luatex)(\.exe)?$/i.test(path.basename(tool.command))) return tool;
    if (tool.args.some((arg) => typeof arg !== 'string')) return tool;
    count++;
    const job = tool.args.find((arg) => /^--?jobname=/.test(arg));
    const jobIndex = tool.args.findIndex(arg => /^--?jobname$/.test(arg));
    const jobName = job ? job.replace(/^--?jobname=/, '') : jobIndex >= 0 ? tool.args[jobIndex + 1] : undefined;
    const jobArgs = jobName ? ['--jobname', jobName] : [];
    const args = tool.args.some(arg => /^--?recorder(?:-|=|$)/.test(arg)) ? tool.args : ['-recorder', ...tool.args];
    return { ...tool, command: node, args: [wrapper, '--root', '%DOC%', '--project', '%DIR%', '--out-dir', '%OUTDIR%', ...jobArgs, '--', tool.command, ...args] };
  });
  return { tools: wrapped, count };
}

function migrateTools(tools, wrapper) {
  let count = 0;
  const migrated = tools.map(tool => {
    if (!tool || !Array.isArray(tool.args)) return tool;
    const old = tool.args[0];
    if (typeof old !== 'string' || old === wrapper ||
        !/latex-exact-errors[^/\\]*[/\\]bin[/\\]build\.js$/.test(old) ||
        !tool.args.includes('--root') || !tool.args.includes('--')) return tool;
    count++;
    return { ...tool, args: [wrapper, ...tool.args.slice(1)] };
  });
  return { tools: migrated, count };
}

async function migrateConfiguredWorkspaces(vscode, context) {
  if (!vscode.workspace.isTrusted) return;
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const key = `latexExact.backup:${folder.uri.toString()}`;
    const backup = context.workspaceState.get(key);
    if (!backup || !Array.isArray(backup.applied)) continue;
    const config = vscode.workspace.getConfiguration('latex-workshop', folder.uri);
    const current = config.inspect('latex.tools')?.workspaceFolderValue;
    // Preserve later user changes and the original pre-installation backup.
    if (JSON.stringify(current) !== JSON.stringify(backup.applied)) continue;
    const result = migrateTools(current, path.join(context.extensionPath, 'bin', 'build.js'));
    if (!result.count) continue;
    await context.workspaceState.update(key, { ...backup, applied: result.tools });
    try { await config.update('latex.tools', result.tools, vscode.ConfigurationTarget.WorkspaceFolder); }
    catch (error) { await context.workspaceState.update(key, backup); throw error; }
  }
}

function registerConfigurationCommands(vscode, context) {
  const migration = migrateConfiguredWorkspaces(vscode, context).catch(error => {
    vscode.window.showWarningMessage(`LaTeX Exact could not update its build connection: ${error.message}`);
  });
  const chooseFolder = async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) { vscode.window.showInformationMessage('Open a LaTeX project folder first.'); return; }
    if (folders.length === 1) return folders[0];
    const picked = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: 'Choose the LaTeX project' });
    return picked?.folder;
  };
  context.subscriptions.push(vscode.commands.registerCommand('latexExact.enableProject', async () => {
    await migration;
    if (!vscode.workspace.isTrusted) return;
    const folder = await chooseFolder(); if (!folder) return;
    const config = vscode.workspace.getConfiguration('latex-workshop', folder.uri);
    const current = config.get('latex.tools');
    const wrapper = path.join(context.extensionPath, 'bin', 'build.js');
    const node = pickNode(vscode.workspace.getConfiguration('latexExact', folder.uri).get('nodePath', 'node'));
    const result = wrapTools(current, wrapper, node);
    if (!result.count) { vscode.window.showInformationMessage('No unwrapped supported LaTeX compiler tools were found. See LaTeX Exact setup instructions.'); return; }
    const key = `latexExact.backup:${folder.uri.toString()}`;
    const prior = context.workspaceState.get(key);
    if (prior) { vscode.window.showWarningMessage('LaTeX Exact has an existing configuration backup. Disable it before applying another configuration.'); return; }
    const before = config.inspect('latex.tools')?.workspaceFolderValue;
    const backup = { hadFolderValue: before !== undefined, before: before ?? null, applied: result.tools, createdAt: new Date().toISOString(), id: crypto.randomUUID() };
    await context.workspaceState.update(key, backup);
    try {
      await config.update('latex.tools', result.tools, vscode.ConfigurationTarget.WorkspaceFolder);
      vscode.window.showInformationMessage('LaTeX Exact enabled. Build your document normally to highlight compiler-confirmed errors.');
    } catch (error) { await context.workspaceState.update(key, undefined); throw error; }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('latexExact.disableProject', async () => {
    await migration;
    const folder = await chooseFolder(); if (!folder) return;
    const key = `latexExact.backup:${folder.uri.toString()}`;
    const backup = context.workspaceState.get(key);
    if (!backup) { vscode.window.showInformationMessage('No LaTeX Exact configuration backup exists for this project.'); return; }
    const config = vscode.workspace.getConfiguration('latex-workshop', folder.uri);
    const current = config.inspect('latex.tools')?.workspaceFolderValue;
    if (JSON.stringify(current) !== JSON.stringify(backup.applied)) { vscode.window.showWarningMessage('Build tools changed after setup. LaTeX Exact will not overwrite those changes; restore your tool configuration manually.'); return; }
    await config.update('latex.tools', backup.hadFolderValue ? backup.before : undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    await context.workspaceState.update(key, undefined);
    vscode.window.showInformationMessage('Original LaTeX build tools restored.');
  }));
}
module.exports = { registerConfigurationCommands, wrapTools, pickNode, migrateTools, migrateConfiguredWorkspaces };
