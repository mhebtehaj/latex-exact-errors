'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const engine = process.env.LATEX_HIGHLIGHTER_TEST_ENGINE ||
  (fs.existsSync('/Library/TeX/texbin/pdflatex') ? '/Library/TeX/texbin/pdflatex' : 'pdflatex');
const probe = spawnSync(engine, ['--version'], { encoding: 'utf8', timeout: 10000 });
const available = !probe.error && probe.status === 0;
const document = (body, preamble = '') => '\\documentclass{article}\n\\usepackage{amsmath}\n\\errorcontextlines=50\n' +
  preamble + '\\begin{document}\n' + body + '\n\\end{document}\n';

const cases = [
  { name: 'inline and both explicit delimiter forms', text: document('Inline $x_1+1$, \\(y^2\\), and \\[z=3\\].') },
  { name: 'double-dollar display', text: document('Before $$x_1+1=2$$ after.') },
  { name: 'text math nested inside alignment', text: document('\\begin{align*}\nx&=1 &&\\text{when $y=2$}\\\\\ny&=3\n\\end{align*}') },
  { name: 'ensuremath and escaped dollars', text: document('Cost \\$5. Expression \\ensuremath{x_1+1}. $\\text{cost \\$5}+x$.') },
  { name: 'aligned nested within explicit math', text: document('\\[\\begin{aligned}x&=1\\\\y&=2\\end{aligned}\\]') },
  { name: 'macro definitions storing math delimiters', text: document('\\startinline x_1+1\\stopinline', '\\def\\startinline{$}\n\\def\\stopinline{$}\n') },
  { name: 'macro math opener with a literal closer', text: document('\\startinline x_1+1$', '\\def\\startinline{$}\n') },
  { name: 'macro environment opener with a literal closer', text: document('\\startequation x_1=1\\end{equation}', '\\def\\startequation{\\begin{equation}}\n') },
  { name: 'environment definition storing begin and end separately', text: document('\\wrappedmath x_1=1\\endwrappedmath', '\\newenvironment{wrappedmath}{\\begin{equation}}{\\end{equation}}\n') },
  { name: 'newcommand stored complete environment', text: document('\\savedformula', '\\newcommand{\\savedformula}{\\begin{equation}x=1\\end{equation}}\n') },
  { name: 'comments verbatim and escaped braces', text: document('% $ } \\end{align*}\n\\verb|$ } \\end{align*}|\n\\begin{verbatim}\n$ } \\end{align*}\n\\end{verbatim}\nEscaped \\{ and \\}.') },
  { name: 'inactive branch contains arbitrary broken structure', text: document('\\iffalse\n$ { \\begin{align*}\n\\fi\nValid $x=1$.') },
  { name: 'unknown conditional may abstain rather than cross branches', text: document('\\ifnum 1=1\n$x=1$\n\\else\n$\n\\fi') },
  { name: 'math-only commands deliberately stored in a macro', text: document('Text and $\\savedmath$.', '\\newcommand{\\savedmath}{x_1+\\alpha^2}\n') },
  { name: 'blank line in intertext prose is still rejected by TeX', text: document('\\begin{align*}\nx&=1\\\\\n\\intertext{A paragraph.\n\nAnother paragraph.}\ny&=2\n\\end{align*}'), error: true },
  { name: 'comment-only gap is not a blank paragraph', text: document('\\begin{align*}\nx&=1\\\\\n% a comment-only row\ny&=2\n\\end{align*}') },
  { name: 'tabular ampersands are valid text alignment', text: document('\\begin{tabular}{cc}a&b\\\\c&d\\end{tabular}') },
  { name: 'unclosed inline dollar', text: document('Before $x+1 and text.'), error: true, mustFind: true },
  { name: 'unclosed explicit inline delimiter', text: document('Before \\(x+1 and text.'), error: true, mustFind: true },
  { name: 'mismatched math environment', text: document('\\begin{align*}\nx&=1\n\\end{gather*}'), error: true, mustFind: true },
  { name: 'unclosed source brace', text: document('Text \\textbf{bold text.'), error: true, mustFind: true },
  { name: 'blank line inside align', text: document('\\begin{align*}\nx&=1\\\\\n\ny&=2\n\\end{align*}'), error: true, mustFind: true },
  { name: 'missing dollar before underscore is ambiguous', text: document('Text x_1 and prose.'), error: true, suspectedOnly: true },
  { name: 'missing dollar before a math macro is ambiguous', text: document('First $x_1=\nFirst $\\mathcal{E}^{2}=1$.\n\\begin{align*}\ny&=2\n\\end{align*}'), error: true },
  { name: 'logical iff is not a conditional and must not disable checking', text: document('$P\\iff Q$. Text \\textbf{unclosed.'), error: true, mustFind: true },
];

function checkRanges(diagnostics, text) {
  assert.ok(Array.isArray(diagnostics), 'analyzeStructure returns an array');
  for (const item of diagnostics) {
    assert.ok(typeof item.code === 'string' && item.code.length, 'diagnostic has a stable code');
    assert.ok(typeof item.message === 'string' && item.message.length, 'diagnostic has an explanation');
    assert.ok(['certain', 'suspected'].includes(item.confidence), 'diagnostic distinguishes lexical certainty from a suspicion');
    assert.ok(Number.isInteger(item.start) && Number.isInteger(item.end));
    assert.ok(item.start >= 0 && item.end > item.start && item.end <= text.length, 'nonempty UTF-16 range stays within the current text');
    for (const related of item.related || []) {
      assert.ok(related.start >= 0 && related.end > related.start && related.end <= text.length, 'related range stays within text');
    }
  }
}

test('live structure checks agree with real TeX on supported constructs and abstain on ambiguity', {
  skip: !available && 'pdfLaTeX is unavailable', timeout: 120000,
}, async t => {
  const { analyzeStructure } = require('../src/structure.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-live-structure-'));
  let failed = false;
  t.after(() => {
    if (failed) t.diagnostic(`Live structure compilation evidence retained at ${directory}`);
    else fs.rmSync(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < cases.length; index++) {
    const fixture = cases[index];
    await t.test(fixture.name, () => {
      const cwd = path.join(directory, String(index).padStart(2, '0'));
      fs.mkdirSync(cwd);
      const file = path.join(cwd, 'main.tex');
      fs.writeFileSync(file, fixture.text);
      try {
        const compilation = spawnSync(engine, ['-interaction=nonstopmode', '-file-line-error', '-no-shell-escape', 'main.tex'], {
          cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
        });
        assert.ifError(compilation.error);
        assert.equal(compilation.status !== 0, Boolean(fixture.error), `Unexpected real TeX outcome: ${compilation.stdout}`);
        const diagnostics = analyzeStructure(fixture.text, { file });
        fs.writeFileSync(path.join(cwd, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
        checkRanges(diagnostics, fixture.text);
        if (!fixture.error) assert.deepEqual(diagnostics, [], 'valid TeX must not get live structure warnings');
        if (fixture.mustFind) assert.ok(diagnostics.length, 'supported structural mistake should be shown before compilation');
        if (fixture.suspectedOnly) assert.ok(diagnostics.every(item => item.confidence === 'suspected'), 'compiler insertion points do not uniquely prove the missing delimiter position');
      } catch (error) {
        failed = true;
        error.message += `\nEvidence: ${cwd}`;
        throw error;
      }
    });
  }
});

test('structure positions retain UTF-16 offsets after astral characters and CRLF', () => {
  const { analyzeStructure } = require('../src/structure.js');
  const text = '% 😀\r\nText $x+1\r\n';
  const diagnostics = analyzeStructure(text, { file: '/example/main.tex' });
  checkRanges(diagnostics, text);
  assert.ok(diagnostics.some(item => item.start <= text.indexOf('$') && item.end > text.indexOf('$')),
    'unclosed math should retain the actual opening dollar position');
});
