'use strict';
const { parse } = require('./parser');
const { TEXT_ARGUMENTS, storedStructureRisk } = require('../structure');
const MATH_ENV = new Set('math displaymath equation equation* align align* alignat alignat* flalign flalign* gather gather* multline multline* eqnarray eqnarray* aligned alignedat gathered split array matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix cases smallmatrix subarray'.split(' '));
const DISPLAY = new Set('displaymath equation equation* align align* alignat alignat* flalign flalign* gather gather* multline multline* eqnarray eqnarray*'.split(' '));
const ALIGN = new Set('align align* alignat alignat* flalign flalign* eqnarray eqnarray* aligned alignedat split array matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix cases smallmatrix subarray tabular tabular* tabularx longtable'.split(' '));
const TEXT_ENV = new Set('document itemize enumerate description center flushleft flushright quote quotation theorem lemma proof proposition corollary definition remark example abstract figure figure* table table* minipage verbatim verbatim* Verbatim lstlisting minted comment filecontents filecontents*'.split(' '));
const MATH_ONLY = new Set('alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega frac dfrac tfrac sqrt sum prod int iint oint lim infty partial nabla mathrm mathbf mathit mathsf mathtt mathcal mathbb mathfrak overline overbrace underbrace hat widehat vec cdot times leq geq neq subseteq supseteq forall exists left right'.split(' '));
const CONDITIONAL = /^if(?:[A-Za-z@]+)?$/;
const NORMAL_IF = new Set(['iff', 'ifthenelse', 'ifstrequal', 'ifstrempty', 'ifblank', 'ifboolexpr']);
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const rows = [Array.from({ length: b.length + 1 }, (_, i) => i)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i]; rows.push(row);
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
    }
  }
  return rows[a.length][b.length];
}
function analyze(events, options) {
  const findings = [], uncertainty = new Set(), scopes = [new Map()];
  const known = new Set([...options.base, ...(options.additionalCommands || []).map(n => n.replace(/^\\/, ''))]);
  const groups = [], envs = [], lefts = [], branches = [], guesses = new Map();
  let math = null, mode = false, pending = null, dynamic = false, csname = false, globalNext = false, structureUncertain = false;
  let ordinary = [];
  const emit = (code, message, token, severity = 'warning', extra = {}) => {
    if (code !== 'unknown-command' && (dynamic || structureUncertain || branches.some(b => b.unknown))) return;
    if (findings.length >= 500 || !token || token.end <= token.start) return;
    findings.push({ code, message, file: token.file, start: token.start, end: token.end, severity, ...extra });
  };
  const lookup = name => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); return known.has(name) ? { builtin: true } : null; };
  const define = (name, value, global = false) => { scopes[global ? 0 : scopes.length - 1].set(name, value); guesses.clear(); };
  const related = t => t ? [{ file: t.file, start: t.start, end: t.end, message: 'Opening token is here.' }] : [];
  const flushLeft = (depth, environmentDepth = 0) => {
    while (lefts.length && lefts.at(-1).depth >= depth && lefts.at(-1).environmentDepth >= environmentDepth) {
      emit('left-unclosed', 'No matching \\right was found in this math group. Add a matching \\right (possibly \\right.).', lefts.pop());
    }
  };
  const flushOrdinary = () => {
    if (options.ordinaryParentheses && !ordinary.some(t => '[]'.includes(t.value) || t.name === 'left' || t.name === 'right')) {
      const stack = [];
      for (const t of ordinary) {
        if (t.value === '(') stack.push(t);
        if (t.value === ')' && !stack.pop()) emit('parenthesis-hint', 'Possible extra ordinary parenthesis; intentional delimiter combinations are allowed by TeX.', t, 'information');
      }
      for (const t of stack) emit('parenthesis-hint', 'Possible unclosed ordinary parenthesis; this is an optional style hint, not a TeX error.', t, 'information');
    }
    ordinary = [];
  };
  const closeMath = () => { flushLeft(groups.length); flushOrdinary(); math = null; mode = envs.at(-1)?.mode ?? false; };
  const closeGroup = () => {
    const g = groups.pop(); if (!g) return null;
    flushLeft(groups.length + 1);
    if (g.context) {
      if (math && math !== g.math) emit('math-unclosed', `No matching ${math.close} before this argument ends.`, math);
      math = g.math; mode = g.mode;
    }
    scopes.splice(g.scopeDepth); return g;
  };
  const suggest = name => {
    if (guesses.has(name)) return guesses.get(name);
    let best = 3, matches = [];
    for (const candidate of new Set([...known, ...scopes.flatMap(s => [...s.keys()])])) {
      const d = distance(name, candidate);
      if (d < best) { best = d; matches = [candidate]; } else if (d === best) matches.push(candidate);
    }
    const result = best === 1 || (best === 2 && name.length >= 6) ? matches.sort().slice(0, 3) : [];
    guesses.set(name, result); return result;
  };
  for (const t of events) {
    if (t.kind === 'command' && CONDITIONAL.test(t.name) && !NORMAL_IF.has(t.name)) {
      const parent = branches.some(b => b.skip);
      const unknown = !['iftrue', 'iffalse'].includes(t.name);
      branches.push({ skip: parent || t.name === 'iffalse', parent, unknown });
      if (unknown) uncertainty.add('Conditional execution is not evaluated.');
      continue;
    }
    if (t.kind === 'command' && t.name === 'else' && branches.length) { const b = branches.at(-1); b.skip = b.parent || !b.skip; continue; }
    if (t.kind === 'command' && t.name === 'fi' && branches.length) { branches.pop(); continue; }
    if (branches.some(b => b.skip)) continue;
    const uncertain = dynamic || branches.some(b => b.unknown);
    if (t.kind === 'uncertain') { uncertainty.add(t.reason); dynamic = true; continue; }
    if (t.kind === 'include') { if (!t.child) uncertainty.add(`Input ${t.value} could not be indexed.`); continue; }
    if (t.kind === 'package' || t.kind === 'class') {
      for (const name of t.names || []) known.add(name);
      guesses.clear();
      for (const name of t.missing || []) uncertainty.add(`No completion metadata for ${name}.`);
      continue;
    }
    if (t.kind === 'definition') {
      if (t.incomplete) emit('brace-unclosed', 'Incomplete macro definition: a closing } or required argument is missing. This marks the existing opener.', { ...t.incomplete, file: t.file });
      const body = t.bodies.join('');
      const info = { parameters: t.parameters, risk: storedStructureRisk(t.bodies), mathArgument: /^\\ensuremath\s*\{/.test(body) || /^\$/.test(body), alias: t.alias };
      if (t.environment) {
        // Definitions are scope-bound, just like the two control sequences TeX creates.
        info.environment = true;
        info.math = /\\begin\s*\{(?:align\*?|equation\*?|gather\*?|math|displaymath)\}/.test(body) || /^\$|^\\\[/.test(body);
        info.locals = parse(t.bodies[0] || '').events.filter(e => e.kind === 'definition');
        info.alignment = /\\begin\s*\{(?:align\*?|aligned|array|tabular)\}/.test(body);
        define(t.name, info, globalNext || t.global); define('end' + t.name, info, globalNext || t.global);
        if (t.value === '\\newtheorem') define('the' + t.name, {}, globalNext || t.global);
      } else {
        define(t.name, info, globalNext || t.global);
        if (t.value === '\\newif' && t.name.startsWith('if')) for (const suffix of ['true', 'false']) define(t.name.slice(2) + suffix, {}, globalNext);
      }
      globalNext = false; continue;
    }
    if (branches.some(b => b.unknown) && !['command', 'definition'].includes(t.kind)) continue;
    if (t.kind === 'open') {
      const context = pending && pending.file === t.file && pending.at === t.start;
      groups.push({ ...t, mode, math, context, scopeDepth: scopes.length }); scopes.push(new Map());
      if (context) { mode = pending.mode; math = null; pending = null; }
      continue;
    }
    if (t.kind === 'close') {
      if (!closeGroup()) emit('brace-unexpected-close', 'Extra closing }: no matching opening group was found.', t);
      continue;
    }
    if (t.kind === 'begin') {
      const def = lookup(t.name)?.environment ? lookup(t.name) : null;
      const isMath = MATH_ENV.has(t.name) || def?.math;
      if (DISPLAY.has(t.name) && math) { emit('math-unclosed', `Math opened here has no matching ${math.close} before the display environment.`, math); closeMath(); }
      const frame = { ...t, previousMode: mode, mode: isMath ? true : def || TEXT_ENV.has(t.name) ? mode : null, scopeDepth: scopes.length, groupDepth: groups.length, alignment: ALIGN.has(t.name) || def?.alignment, amps: 0 };
      envs.push(frame); scopes.push(new Map()); mode = frame.mode;
      if (def) for (const local of def.locals) define(local.name, { parameters: local.parameters });
      continue;
    }
    if (t.kind === 'end') {
      const index = envs.findLastIndex(e => e.name === t.name);
      if (index < 0) {
        if (envs.length) {
          const e = envs.pop(); emit('environment-mismatched', `Expected \\end{${e.name}}, found \\end{${t.name}}.`, t, 'warning', { related: related(e) });
          scopes.splice(e.scopeDepth); mode = e.previousMode;
        } else emit('environment-unexpected-close', `No matching \\begin{${t.name}} was found.`, t);
      } else {
        const e = envs[index];
        if (index !== envs.length - 1) emit('environment-unclosed', `Missing \\end{${envs.at(-1).name}} before \\end{${t.name}}.`, envs.at(-1));
        if (math && math.file === t.file && math.start >= e.start) { emit('math-unclosed', `No matching ${math.close} before this environment ends.`, math); closeMath(); }
        if (groups.length > e.groupDepth) { emit('brace-unclosed', 'No matching closing } before this environment ends.', groups[e.groupDepth]); while (groups.length > e.groupDepth) closeGroup(); }
        flushLeft(e.groupDepth, index + 1); flushOrdinary(); envs.splice(index); scopes.splice(e.scopeDepth); mode = e.previousMode;
      }
      continue;
    }
    if (t.kind === 'math') {
      if (uncertain) { mode = null; continue; }
      const value = t.value;
      if (math?.close === value) { closeMath(); continue; }
      if (math) { emit('math-mismatched', `Expected ${math.close}, found ${value}. Check the earlier opening delimiter.`, t, 'warning', { related: related(math) }); closeMath(); continue; }
      if (value === '\\)' || value === '\\]') { emit('math-unexpected-close', `No matching ${value === '\\)' ? '\\(' : '\\['} was found.`, t); continue; }
      if (mode === true) { emit('math-mismatched', 'A math delimiter appears inside an existing math context.', t); continue; }
      math = { ...t, close: value === '\\(' ? '\\)' : value === '\\[' ? '\\]' : value }; mode = true; continue;
    }
    if (t.kind === 'paragraph') {
      if (uncertain) continue;
      if (math) { emit('math-unclosed', `A paragraph break occurs before the matching ${math.close}. Check this opener; the intended insertion point is ambiguous.`, math); closeMath(); }
      else if (mode === true || envs.some(e => DISPLAY.has(e.name))) emit('alignment-paragraph', 'A paragraph break is not allowed in this math environment. Remove the blank line or use \\intertext{...} between alignment rows.', t);
      continue;
    }
    if (t.kind === 'ordinary') { if (mode === true) ordinary.push(t); continue; }
    if (t.kind === 'amp') {
      const e = envs.at(-1);
      if (uncertain || mode === null) continue;
      if (!e || !e.alignment) emit('alignment-tab', 'Alignment tab & outside a recognized alignment. Use \\& for a literal ampersand.', t);
      else { e.amps++; const max = e.name === 'split' ? 1 : /^eqnarray/.test(e.name) ? 2 : Infinity; if (e.amps > max) emit('alignment-tabs', `Too many alignment tabs in this ${e.name} row (at most ${max}).`, t); }
      continue;
    }
    if (t.kind !== 'command') continue;
    if (t.name === 'csname') { csname = true; uncertainty.add('Dynamically constructed command names are not expanded.'); continue; }
    if (t.name === 'endcsname') { csname = false; dynamic = true; continue; }
    if (csname) continue;
    if (['catcode', 'scantokens', 'ExplSyntaxOn', 'expandafter', 'futurelet'].includes(t.name)) { dynamic = true; uncertainty.add('Dynamic TeX or category codes limit static checks.'); }
    if (t.name === 'global') { globalNext = true; continue; }
    if (['\\', 'cr', 'tabularnewline'].includes(t.name) && envs.length) envs.at(-1).amps = 0;
    const def = lookup(t.name);
    if (def?.risk && !def.environment) { structureUncertain = true; mode = null; uncertainty.add(`Macro \\${t.name} can change delimiter context.`); }
    if (TEXT_ARGUMENTS.has(t.value) || t.name === 'ensuremath' || def?.mathArgument) {
      const text = options.sources.get(t.file)?.text || '';
      const at = require('../structure').whitespace(text, t.end);
      pending = { file: t.file, at, mode: t.name === 'ensuremath' || !!def?.mathArgument };
    }
    if (t.name === 'left' || t.name === 'right') {
      ordinary.push(t);
      if (mode === true && !uncertain) {
        if (t.name === 'left') lefts.push({ ...t, depth: groups.length, environmentDepth: envs.length });
        else if (lefts.at(-1)?.depth === groups.length && lefts.at(-1).environmentDepth === envs.length) lefts.pop();
        else emit('right-unmatched', 'No matching \\left in this math group. Use \\left. for an invisible opener when intended.', t);
      }
    }
    if (def && MATH_ONLY.has(t.name) && def.builtin && mode === false && !uncertain && options.structure !== false) emit('math-only', `\\${t.name} requires math mode here. Add math delimiters around the expression.`, t);
    if (!def && /^[A-Za-z][A-Za-z@_:]+$/.test(t.name) && options.commands !== false) {
      const suggestions = suggest(t.name);
      const limited = uncertain || uncertainty.size > 0;
      emit('unknown-command', `Unrecognized command \\${t.name}.${suggestions.length ? ' Did you mean ' + suggestions.map(s => '\\' + s).join(' or ') + '?' : ''} Live source check; not compiler-confirmed.${limited ? ' Project command knowledge is incomplete; this command may be defined dynamically or by unindexed package code.' : ' Package and macro expansion may define additional commands.'}`, t, uncertain ? 'information' : suggestions.length ? 'error' : limited ? 'information' : 'warning', { suggestions });
    }
  }
  if (math) emit('math-unclosed', `No matching ${math.close} was found. This marks the unmatched opener, not an assumed insertion point.`, math);
  if (groups.length) emit('brace-unclosed', 'No matching closing } was found.', groups[0]);
  if (envs.length) emit('environment-unclosed', `No matching \\end{${envs.at(-1).name}} was found.`, envs.at(-1));
  flushLeft(0); flushOrdinary();
  const unique = new Map();
  for (const f of findings) if (options.structure !== false || f.code === 'unknown-command') unique.set(`${f.file}:${f.code}:${f.start}:${f.end}`, f);
  return { findings: [...unique.values()].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start), uncertainty: [...uncertainty] };
}
module.exports = { analyze, distance };
