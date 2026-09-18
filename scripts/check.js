'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const dir of ['src', 'bin', 'scripts', 'test']) {
  function check(folder) {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) check(file);
      else if (file.endsWith('.js')) {
        const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
        if (result.status) process.exit(result.status);
      }
    }
  }
  check(path.join(root, dir));
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!fs.existsSync(path.join(root, manifest.main))) throw new Error('Missing extension entry point');
console.log('JavaScript syntax and extension entry point checked.');
