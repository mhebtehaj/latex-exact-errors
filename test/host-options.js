'use strict';

const fs = require('node:fs');
const path = require('node:path');

// An explicit executable takes precedence. Otherwise download an isolated
// VS Code test installation, independently of the user's installed editor.
function editorOptions() {
  const executable = process.env.LATEX_EXACT_HOST_EDITOR || process.env.LATEX_EXACT_HOST_CURSOR;
  if (executable) return { vscodeExecutablePath: executable };
  return { version: process.env.LATEX_EXACT_HOST_VERSION || 'stable' };
}

function texEngine() {
  const configured = process.env.LATEX_EXACT_HOST_ENGINE;
  if (configured) return configured;
  const name = process.platform === 'win32' ? 'pdflatex.exe' : 'pdflatex';
  const candidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  if (process.platform === 'darwin') candidates.push('/Library/TeX/texbin/pdflatex');
  return candidates.find(file => fs.existsSync(file)) || name;
}

module.exports = { editorOptions, texEngine };
