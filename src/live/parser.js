'use strict';
// A tolerant event parser built on the original scanner. All offsets are UTF-16.
// Stored definitions are opaque, but their declarations/arguments are indexed.
const S = require('../structure');
const { whitespace, group, verbEnd } = S;
// TeX control words stop before a subscript or colon in normal syntax.
function commandAt(text, start, expl = false) {
  const letters = expl ? /[A-Za-z@_:]/ : /[A-Za-z@]/;
  let end = start + 1;
  if (letters.test(text[end] || '')) while (end < text.length && letters.test(text[end])) end++;
  else if (end < text.length) end += text.codePointAt(end) > 0xffff ? 2 : 1;
  return { value: text.slice(start, end), start, end };
}
const valueOf = (text, g) => text.slice(g.start + 1, g.end - 1).trim();
const SIMPLE = new Set([...S.SIMPLE_DEFINITIONS, '\\newlength', '\\newsavebox', '\\newcount', '\\newdimen', '\\newtoks', '\\newif']);
const DOC = new Set([...S.DOCUMENT_DEFINITIONS, '\\NewExpandableDocumentCommand', '\\RenewExpandableDocumentCommand', '\\ProvideExpandableDocumentCommand', '\\DeclareExpandableDocumentCommand']);
const ENV = S.ENVIRONMENT_DEFINITIONS;
const PRIM = S.PRIMITIVE_DEFINITIONS;

function definition(text, token) {
  const op = token.value;
  if (!SIMPLE.has(op) && !DOC.has(op) && !ENV.has(op) && !PRIM.has(op) && op !== '\\let' && op !== '\\newtheorem') return null;
  let at = whitespace(text, token.end);
  if (text[at] === '*') at = whitespace(text, at + 1);
  const g = group(text, at);
  const target = g ? valueOf(text, g) : text[at] === '\\' ? commandAt(text, at).value : '';
  at = g ? g.end : target ? at + target.length : at;
  const environment = ENV.has(op) || op === '\\newtheorem';
  const name = environment ? target : target.startsWith('\\') ? target.slice(1) : '';
  if (!name) return { ...token, kind: 'uncertain', reason: 'incomplete declaration' };
  const event = { ...token, kind: 'definition', name, environment, bodies: [], parameters: '', global: ['\\gdef', '\\xdef'].includes(op) };
  if (op === '\\let') {
    at = whitespace(text, at); if (text[at] === '=') at = whitespace(text, at + 1);
    const alias = text[at] === '\\' ? commandAt(text, at) : { value: text[at], end: at + 1 };
    return { ...event, end: Math.min(text.length, alias.end), alias: alias.value };
  }
  if (['\\newlength', '\\newsavebox', '\\newcount', '\\newdimen', '\\newtoks', '\\newif'].includes(op)) return { ...event, end: at };
  at = whitespace(text, at);
  if (PRIM.has(op)) {
    const parameterStart = at;
    while (at < text.length && text[at] !== '{' && text[at] !== '\n') at++;
    event.parameters = text.slice(parameterStart, at);
  } else if (DOC.has(op) || /DocumentEnvironment$/.test(op)) {
    const params = group(text, at);
    if (params) { event.parameters = valueOf(text, params); at = whitespace(text, params.end); }
  } else {
    for (let n = 0; n < 2 && text[at] === '['; n++) {
      const optional = group(text, at, '[', ']');
      if (!optional) break;
      event.parameters += text.slice(at, optional.end); at = whitespace(text, optional.end);
    }
  }
  const count = ENV.has(op) ? 2 : 1;
  for (let n = 0; n < count; n++) {
    const body = group(text, at);
    if (!body) {
      event.incomplete = text[at] === '{' ? { start: at, end: at + 1 } : token;
      // Recover at the next physical line. An incomplete declaration must not
      // consume the remainder of the buffer and hide independent typos.
      const newline = text.indexOf('\n', at);
      event.end = newline < 0 ? text.length : newline;
      return event;
    }
    event.bodies.push(valueOf(text, body));
    at = whitespace(text, body.end);
    event.end = body.end;
  }
  if (op === '\\newtheorem') event.bodies = [];
  return event;
}

function parse(text) {
  const events = [];
  let at = 0, lineStart = 0, content = false, comment = false, expl = false;
  const push = (kind, start, end, extra = {}) => events.push({ kind, start, end, ...extra });
  const advance = end => {
    const newline = text.lastIndexOf('\n', end - 1);
    if (newline >= at) { lineStart = newline + 1; content = false; comment = false; }
    at = end;
  };
  while (at < text.length) {
    const c = text[at];
    if (c === '\n') {
      if (!content && !comment) push('paragraph', lineStart, at + 1);
      at++; lineStart = at; content = false; comment = false; continue;
    }
    if (/\s/.test(c)) { at++; continue; }
    if (c === '%') {
      const end = text.indexOf('\n', at); comment = true;
      at = end < 0 ? text.length : end; continue;
    }
    content = true;
    if (c === '\\') {
      const t = commandAt(text, at, expl); at = t.end;
      if (t.value === '\\ExplSyntaxOn') expl = true;
      if (t.value === '\\ExplSyntaxOff') expl = false;
      const d = definition(text, t);
      if (d) { events.push(d); advance(d.end); continue; }
      if (['\\verb', '\\lstinline'].includes(t.value)) { advance(verbEnd(text, at, t.value)); continue; }
      if (['\\begin', '\\end'].includes(t.value)) {
        const g = group(text, whitespace(text, at));
        if (g) {
          const name = valueOf(text, g);
          push(t.value === '\\begin' ? 'begin' : 'end', t.start, g.end, { name });
          advance(g.end);
          if (t.value === '\\begin' && S.OPAQUE_ENVIRONMENTS.has(name)) {
            const re = new RegExp('\\\\end\\s*\\{' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\}', 'g');
            re.lastIndex = at; const close = re.exec(text);
            if (close) { push('end', close.index, close.index + close[0].length, { name }); advance(close.index + close[0].length); }
            else advance(text.length);
          }
          continue;
        }
      }
      if (['\\usepackage', '\\RequirePackage', '\\documentclass', '\\LoadClass', '\\input', '\\include', '\\subfile'].includes(t.value)) {
        let p = whitespace(text, at);
        if (text[p] === '[') { const opt = group(text, p, '[', ']'); if (opt) p = whitespace(text, opt.end); }
        const g = group(text, p);
        let value, end;
        if (g) { value = valueOf(text, g); end = g.end; }
        else if (t.value === '\\input') { const m = /^[^\s%{}\\]+/.exec(text.slice(p)); if (m) { value = m[0]; end = p + m[0].length; } }
        if (value) {
          const kind = /input|include|subfile/.test(t.value) ? 'include' : /class|Class/.test(t.value) ? 'class' : 'package';
          push(kind, t.start, end, { value }); advance(end); continue;
        }
      }
      if (t.value === '\\par') events.push({ ...t, kind: 'paragraph' });
      else if (['\\(', '\\)', '\\[', '\\]'].includes(t.value)) events.push({ ...t, kind: 'math' });
      else if (t.value === '\\begingroup' || t.value === '\\bgroup') events.push({ ...t, kind: 'open' });
      else if (t.value === '\\endgroup' || t.value === '\\egroup') events.push({ ...t, kind: 'close' });
      else events.push({ ...t, kind: 'command', name: t.value.slice(1) });
      continue;
    }
    if (c === '$') { const end = at + (text[at + 1] === '$' ? 2 : 1); push('math', at, end, { value: text.slice(at, end) }); at = end; continue; }
    if ('{}&()[]'.includes(c)) push(({ '{': 'open', '}': 'close', '&': 'amp' })[c] || 'ordinary', at, at + 1, { value: c });
    at += text.codePointAt(at) > 0xffff ? 2 : 1;
  }
  return { text, events };
}
module.exports = { parse, definition };
