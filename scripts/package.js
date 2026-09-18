'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const candidates = [process.env.VSCE_BIN,
  path.join(root, 'node_modules/@vscode/vsce/vsce')].filter(Boolean);
const executable = candidates.find(file => fs.existsSync(file));
if (!executable) throw new Error('Run npm ci to install the packaging tools, or set VSCE_BIN to the vsce script.');
const result = spawnSync(process.execPath, [executable, 'package', '--no-dependencies', '--allow-missing-repository'], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
