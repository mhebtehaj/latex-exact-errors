'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

/**
 * A deliberately partial TeX source mapper. TeX, not a dictionary of commands,
 * decides whether an error exists. This module only maps compiler evidence to
 * immutable source snapshots. It does not execute TeX or access the filesystem.
 * All offsets are JavaScript/VS Code UTF-16 offsets; ends are exclusive.
 */

const VERBATIM = new Set(['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*',
  'BVerbatim', 'LVerbatim', 'lstlisting', 'minted', 'comment', 'filecontents',
  'filecontents*', 'luacode', 'luacode*']);
const COLLECTED = new Set(['align', 'align*', 'alignat', 'alignat*', 'flalign',
  'flalign*', 'gather', 'gather*', 'multline', 'multline*', 'equation', 'equation*',
  'split', 'aligned', 'alignedat', 'gathered']);
const COMMAND_DEFS = new Set(['\\newcommand', '\\renewcommand', '\\providecommand',
  '\\DeclareRobustCommand', '\\DeclareMathOperator']);
const DOCUMENT_DEFS = new Set(['\\NewDocumentCommand', '\\RenewDocumentCommand',
  '\\ProvideDocumentCommand', '\\DeclareDocumentCommand']);
const PRIMITIVE_DEFS = new Set(['\\def', '\\gdef', '\\edef', '\\xdef']);
const CONDITIONALS = /^(?:\\if(?:true|false|num|dim|odd|vmode|hmode|mmode|inner|cat|x|eof|void|hbox|vbox|case|defined|csname|fontchar)?|\\if[A-Za-z@]+)$/;
const UNSAFE_CATCODES = new Set(['\\catcode', '\\scantokens', '\\obeylines', '\\obeyspaces']);

function controlEnd(text, start, letters = /[A-Za-z]/) {
  let end = start + 1;
  if (end >= text.length || text[end] === '\n' || text[end] === '\r') return end;
  if (letters.test(text[end])) {
    while (end < text.length && letters.test(text[end])) end++;
    return end;
  }
  return end + (text.codePointAt(end) > 0xffff ? 2 : 1);
}

/** Tolerant lexer; malformed braces do not prevent indexing subsequent tokens. */
function lex(text, source = false) {
  const tokens = [];
  let atLetter = !source;
  let expl = !source;
  for (let i = 0; i < text.length;) {
    if (/\s/u.test(text[i])) { i++; continue; }
    if (source && text[i] === '%') {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }
    const start = i;
    if (text[i] === '\\') {
      const letters = expl ? /[A-Za-z@_:]/ : atLetter ? /[A-Za-z@]/ : /[A-Za-z]/;
      i = controlEnd(text, i, letters);
      const value = text.slice(start, i);
      tokens.push({ value, start, end: i, state: 'active' });
      if (source && (value === '\\verb' || value === '\\lstinline')) {
        if (text[i] === '*') i++;
        // An optional lstinline argument can contain commands, but is not code.
        if (value === '\\lstinline' && text[i] === '[') {
          const close = text.indexOf(']', i + 1);
          if (close >= 0) i = close + 1;
        }
        if (i < text.length && !/\s/u.test(text[i])) {
          const delimiter = text[i++];
          while (i < text.length && text[i] !== delimiter && text[i] !== '\n') i++;
          if (text[i] === delimiter) i++;
        }
      } else if (source && value === '\\begin') {
        const env = text.slice(i).match(/^\s*\{([A-Za-z*]+)\}/);
        if (env && VERBATIM.has(env[1])) {
          const startBody = i + env[0].length;
          const endMarker = new RegExp('\\\\end\\s*\\{' + env[1].replace(/\*/g, '\\*') + '\\}', 'g');
          endMarker.lastIndex = startBody;
          const close = endMarker.exec(text);
          i = close ? close.index + close[0].length : text.length;
        }
      }
      if (source && value === '\\makeatletter') atLetter = true;
      if (source && value === '\\makeatother') atLetter = false;
      if (source && value === '\\ExplSyntaxOn') expl = true;
      if (source && value === '\\ExplSyntaxOff') expl = false;
      continue;
    }
    i += text.codePointAt(i) > 0xffff ? 2 : 1;
    tokens.push({ value: text.slice(start, i), start, end: i, state: 'active' });
  }
  return tokens;
}

function groupAt(tokens, index, open = '{', close = '}') {
  if (tokens[index]?.value !== open) return null;
  let depth = 1;
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i].value === open) depth++;
    else if (tokens[i].value === close && --depth === 0) {
      return { start: index, end: i, next: i + 1 };
    }
  }
  return null;
}

function readName(tokens, index) {
  const group = groupAt(tokens, index);
  if (group && group.end === index + 2 && tokens[index + 1].value.startsWith('\\')) {
    return { name: tokens[index + 1].value, index: index + 1, next: group.next };
  }
  if (tokens[index]?.value.startsWith('\\')) return { name: tokens[index].value, index, next: index + 1 };
  return null;
}

function findDefinitions(tokens) {
  const definitions = [];
  for (let i = 0; i < tokens.length; i++) {
    const type = tokens[i].value;
    if (!COMMAND_DEFS.has(type) && !DOCUMENT_DEFS.has(type) && !PRIMITIVE_DEFS.has(type) && type !== '\\let' && type !== '\\futurelet') continue;
    let next = i + 1;
    if (tokens[next]?.value === '*') next++;
    const name = readName(tokens, next);
    if (!name) continue;
    next = name.next;
    let body;
    if (type === '\\let' || type === '\\futurelet') {
      definitions.push({ name: name.name, nameIndex: name.index, tokenStart: i, tokenEnd: next, body: null, safe: false });
      continue;
    }
    if (PRIMITIVE_DEFS.has(type)) {
      while (next < tokens.length && tokens[next].value !== '{' && next - name.next < 100) next++;
    } else if (DOCUMENT_DEFS.has(type)) {
      const argumentsGroup = groupAt(tokens, next);
      if (!argumentsGroup) continue;
      next = argumentsGroup.next;
    } else {
      for (let count = 0; count < 2 && tokens[next]?.value === '['; count++) {
        const optional = groupAt(tokens, next, '[', ']');
        if (!optional) break;
        next = optional.next;
      }
    }
    body = groupAt(tokens, next);
    if (!body) continue;
    definitions.push({ name: name.name, nameIndex: name.index, tokenStart: i,
      tokenEnd: body.end + 1, body, safe: type !== '\\edef' && type !== '\\xdef' && type !== '\\providecommand' && type !== '\\ProvideDocumentCommand' });
  }
  return definitions;
}

// Only literal true/false are evaluated. Unknown conditionals keep both branches
// as candidates. A macro body has its own conditional scope because its tokens
// are stored, not executed while TeX reads the definition.
function markConditionals(tokens, definitions) {
  const bodyStarts = new Map(definitions.filter(d => d.body).map(d => [d.body.start, d]));
  function walk(from, to, inherited = 'active') {
    const stack = [];
    let state = inherited;
    for (let i = from; i < to; i++) {
      const token = tokens[i];
      token.state = state;
      const def = bodyStarts.get(i);
      if (def) {
        walk(i + 1, def.body.end, state);
        tokens[def.body.end].state = state;
        i = def.body.end;
        continue;
      }
      if (token.value === '\\newif' && tokens[i + 1]) {
        tokens[++i].state = state;
        continue;
      }
      if (CONDITIONALS.test(token.value)) {
        const condition = token.value === '\\iftrue' ? true : token.value === '\\iffalse' ? false : null;
        stack.push({ prior: state, condition });
        state = state === 'inactive' || condition === false ? 'inactive' : state === 'conditional' || condition === null ? 'conditional' : 'active';
      } else if ((token.value === '\\else' || token.value === '\\or') && stack.length) {
        const top = stack[stack.length - 1];
        top.condition = token.value === '\\or' || top.condition === null ? null : !top.condition;
        state = top.prior === 'inactive' || top.condition === false ? 'inactive' : top.prior === 'conditional' || top.condition === null ? 'conditional' : 'active';
      } else if (token.value === '\\fi' && stack.length) state = stack.pop().prior;
    }
  }
  walk(0, tokens.length);
}

function indexSource(file, text) {
  const tokens = lex(text, true);
  const definitions = findDefinitions(tokens);
  markConditionals(tokens, definitions);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const environments = [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    token.index = i;
    token.definition = definitions.find(d => d.body && i > d.body.start && i < d.body.end) || null;
    if (token.state === 'inactive' || token.definition) continue;
    if (token.value !== '\\begin' && token.value !== '\\end') continue;
    const group = groupAt(tokens, i + 1);
    if (!group) continue;
    const name = tokens.slice(i + 2, group.end).map(t => t.value).join('');
    if (token.value === '\\begin') stack.push({ name, start: token.start, bodyStart: tokens[group.end].end, tokenStart: group.end + 1 });
    else {
      const match = stack.findLastIndex(e => e.name === name);
      if (match < 0) continue;
      const env = stack[match];
      // Mismatched nesting cannot establish a trustworthy body boundary.
      env.balanced = match === stack.length - 1;
      stack.splice(match);
      env.end = tokens[group.end].end;
      env.closeStart = token.start;
      env.bodyEnd = token.start;
      env.tokenEnd = i;
      environments.push(env);
    }
  }
  const unsafe = tokens.some(t => t.state !== 'inactive' && UNSAFE_CATCODES.has(t.value));
  return { file, text, tokens, definitions, lineStarts, environments, unsafe };
}

function lineBounds(index, line) {
  if (!Number.isSafeInteger(line) || line < 1 || line > index.lineStarts.length) return null;
  return { start: index.lineStarts[line - 1], end: index.lineStarts[line] ?? index.text.length };
}

function normalizePath(file, cwd) {
  return path.resolve(cwd, String(file).replace(/^"|"$/g, ''));
}

function sourceFile(raw, indices, cwd, rootFile) {
  const clean = raw.trim().replace(/^"|"$/g, '').replace(/\\/g, path.sep);
  const direct = [normalizePath(clean, cwd), normalizePath(clean, path.dirname(rootFile))];
  return direct.find(file => indices.has(file)) || null;
}

function headerAt(lines, index, indices, cwd, rootFile) {
  const line = lines[index];
  if (/^!\s/.test(line)) return { message: line.replace(/^!\s*/, ''), file: null, line: null, consumedFrom: index };
  if (!/:\d+:/.test(line) || /^(?:\s|<|\\|l\.\d)/.test(line)) return null;
  let joined = line;
  let verified = null;
  let fallback = null;
  for (let previous = index; previous >= Math.max(0, index - 16); previous--) {
    if (previous !== index) joined = lines[previous] + joined;
    const match = joined.match(/^(.+\.(?:tex|ltx|sty|cls|def|cfg|bib|aux|bbl|out|toc)):(\d+):\s*(.*)$/i);
    if (!match) continue;
    const known = sourceFile(match[1], indices, cwd, rootFile);
    if (known) {
      verified = { file: known, line: Number(match[2]), message: match[3], consumedFrom: previous };
      continue;
    }
    if (previous === index && !/^(?:<|\\|l\.\d)/.test(match[1])) {
      // Preserve a compiler-reported external filename, but never redirect it to
      // an unrelated project file having the same basename.
      fallback = { file: normalizePath(match[1], cwd), line: Number(match[2]), message: match[3], consumedFrom: index };
    } else if (previous < index && /^(?:\.?\/|"\.?\/|[A-Za-z]:[\\/])/.test(lines[previous])
      && lines[previous].length >= 70 && !/:\d+:/.test(lines[previous])) {
      // A wrapped external path must not be mistaken for a project file whose
      // name happens to equal its final physical line.
      fallback = { file: normalizePath(match[1], cwd), line: Number(match[2]), message: match[3], consumedFrom: previous };
    }
  }
  if (verified && (!fallback || verified.consumedFrom <= fallback.consumedFrom)) return verified;
  if (fallback) return fallback;
  const external = line.match(/^(.+\.(?:tex|ltx|sty|cls|def|cfg|bib|aux|bbl|out|toc)):(\d+):\s*(.+)$/i);
  return external ? { file: normalizePath(external[1], cwd), line: Number(external[2]), message: external[3], consumedFrom: index } : null;
}

function frameStart(line) {
  let match = line.match(/^l\.(\d+)\s?(.*)$/);
  if (match) return { type: 'source', line: Number(match[1]), left: match[2], prefixLength: line.length - match[2].length };
  match = line.match(/^<([^>]+)>\s?(.*)$/);
  if (match) return { type: match[1] === 'recently read' ? 'recent' : match[1] === 'argument' ? 'argument' : 'other', label: match[1], left: match[2], prefixLength: line.length - match[2].length };
  match = line.match(/^(\\[A-Za-z@_:]+|\\.)([^\r\n]*?)->(.*)$/);
  if (match) return { type: 'macro', name: match[1], signature: match[2], left: match[3], prefixLength: line.length - match[3].length };
  match = line.match(/^(\\[A-Za-z@_:]+|\\.)\s+((?:\.\.\.).*)$/);
  if (match) return { type: 'macro', name: match[1], left: match[2], prefixLength: line.length - match[2].length };
  return null;
}

function parseFrames(lines) {
  const frames = [];
  for (let i = 0; i < lines.length; i++) {
    const frame = frameStart(lines[i]);
    if (!frame) continue;
    frame.right = '';
    frame.complete = false;
    // TeX normally prints one split context line. A hard print-width break can
    // add unindented fragments before it. Keep those fragments without spaces.
    for (let next = i + 1; next < Math.min(lines.length, i + 8); next++) {
      if (frameStart(lines[next]) || /^(?:!|The control sequence|Type |Here is)/.test(lines[next])) break;
      if (/^\s/.test(lines[next])) {
        frame.right = lines[next].trimStart();
        frame.complete = true;
        i = next;
        break;
      }
      if (!lines[next].trim()) break;
      frame.left += lines[next];
      i = next;
    }
    frames.push(frame);
    if (frame.type === 'source') break;
  }
  return frames;
}

function parseLog(log, indices, cwd, rootFile) {
  const lines = log.replace(/\r\n?/g, '\n').split('\n');
  const headers = [];
  const stack = [];
  let active = rootFile;
  const aliases = [...indices.keys()].flatMap(file => {
    const relative = path.relative(cwd, file);
    return [[file, file], [relative, file], ['./' + relative, file], ['"' + file + '"', file], ['"' + relative + '"', file], ['"./' + relative + '"', file]];
  }).sort((a, b) => b[0].length - a[0].length);
  for (let i = 0; i < lines.length; i++) {
    const header = headerAt(lines, i, indices, cwd, rootFile);
    if (header) {
      // The engine's physical print width applies to the path and message as
      // well as source context. Recover even a split inside "control".
      const undefinedMessage = 'Undefined control sequence.';
      let continuation = i + 1;
      while (header.message !== undefinedMessage && undefinedMessage.startsWith(header.message)
        && continuation < Math.min(lines.length, i + 4) && !frameStart(lines[continuation])
        && undefinedMessage.startsWith(header.message + lines[continuation])) {
        header.message += lines[continuation++];
      }
      header.explicitFile = Boolean(header.file);
      header.file ||= active;
      header.index = i;
      headers.push(header);
      continue;
    }
    // Error context/help is not a reliable file-open stream (it may contain
    // arbitrary user parentheses). Only track opens before/in between errors.
    const previous = headers[headers.length - 1];
    if (previous && i - previous.index < 80) {
      if (frameStart(lines[i]) || /^\s|^The |^of your|^misspelled|^spelling|^and I|^!/.test(lines[i])) continue;
    }
    for (let at = 0; at < lines[i].length; at++) {
      if (lines[i][at] === '(') {
        const lookahead = lines.slice(i, i + 5).join('').slice(at + 1);
        const known = aliases.find(([alias]) => lookahead.startsWith(alias) && /[\s()\[\]{}]|^$/.test(lookahead.slice(alias.length, alias.length + 1)));
        stack.push(active);
        if (known) active = known[1];
      } else if (lines[i][at] === ')' && stack.length) active = stack.pop();
    }
  }
  return headers.map((header, i) => {
    const end = headers[i + 1]?.consumedFrom ?? lines.length;
    const frames = parseFrames(lines.slice(header.index + 1, end));
    const source = frames.find(f => f.type === 'source');
    return { ...header, inconsistentLine: Boolean(header.line && source && header.line !== source.line), line: source?.line ?? header.line, frames };
  });
}

function terminalCommand(frame) {
  if (!frame || !frame.complete || !['recent', 'argument', 'macro', 'source'].includes(frame.type)) return null;
  // An ellipsis at the split means the offending token itself is unavailable.
  if (/\.\.\.\s*$/.test(frame.left)) return null;
  const tokens = lex(frame.left);
  const last = tokens[tokens.length - 1];
  return last?.value.startsWith('\\') && last.value.length > 1 ? last.value : null;
}

function contextTokens(text, side) {
  let clean = text;
  if (side === 'left') clean = clean.replace(/^\s*\.\.\./, '');
  else clean = clean.replace(/\.\.\.\s*$/, '');
  return lex(clean).map(t => t.value);
}

function matchesContext(tokens, tokenIndex, frame, scopeStart = 0, scopeEnd = tokens.length) {
  const left = contextTokens(frame.left, 'left');
  const right = contextTokens(frame.right, 'right');
  if (!left.length) return false;
  let leftStart = 0;
  // TeX truncation may start in the middle of a control-word token. Dropping
  // only that incomplete leading word preserves the remaining token evidence.
  if (/^\s*\.\.\./.test(frame.left) && left[0] && /^[A-Za-z@_:]$/.test(left[0])) {
    while (leftStart < left.length - 1 && /^[A-Za-z@_:]$/.test(left[leftStart])) leftStart++;
  }
  const effective = left.slice(leftStart);
  if (tokenIndex - effective.length + 1 < scopeStart || tokenIndex + right.length >= scopeEnd && right.length) return false;
  for (let j = 0; j < effective.length; j++) if (tokens[tokenIndex - effective.length + 1 + j]?.value !== effective[j]) return false;
  for (let j = 0; j < right.length; j++) if (tokens[tokenIndex + 1 + j]?.value !== right[j]) return false;
  return true;
}

function matchesWholeContext(tokens, tokenIndex, frame, start, end) {
  if (!matchesContext(tokens, tokenIndex, frame, start, end)) return false;
  const left = contextTokens(frame.left, 'left');
  const right = contextTokens(frame.right, 'right');
  return (/^\s*\.\.\./.test(frame.left) || tokenIndex - left.length + 1 === start)
    && (/\.\.\.\s*$/.test(frame.right) || tokenIndex + right.length + 1 === end);
}

function matchesSourceLine(index, token, frame, bounds) {
  if (!frame?.complete || !bounds) return false;
  const compact = text => text.replace(/\s/gu, '');
  const left = compact(frame.left.replace(/^\s*\.\.\./, ''));
  const right = compact(frame.right.replace(/\.\.\.\s*$/, ''));
  const sourceLeft = compact(index.text.slice(bounds.start, token.end));
  const sourceRight = compact(index.text.slice(token.end, bounds.end));
  return (/^\s*\.\.\./.test(frame.left) ? sourceLeft.endsWith(left) : sourceLeft === left)
    && (/\.\.\.\s*$/.test(frame.right) ? sourceRight.startsWith(right) : sourceRight === right);
}

/** Bind an expanded #N to one unambiguous, plain mandatory source argument. */
function argumentCandidates(record, index, frame, sourceFrame, bounds, command) {
  if (!sourceFrame || !bounds) return [];
  const expansion = record.frames.find(f => f.type === 'macro' && /#[1-9]\s*$/.test(f.left));
  if (!expansion) return [];
  const argument = Number(expansion.left.match(/#([1-9])\s*$/)[1]);
  const signature = expansion.signature?.replace(/\s/g, '') || '';
  const count = (signature.match(/#[1-9]/g) || []).length;
  if (!count || signature !== Array.from({ length: count }, (_, i) => `#${i + 1}`).join('') || argument > count) return [];
  const tokens = index.tokens;
  const anchors = tokens.filter(t => t.start >= bounds.start && t.start < bounds.end && matchesSourceLine(index, t, sourceFrame, bounds));
  if (anchors.length !== 1) return [];
  const anchor = anchors[0].index;
  const calls = tokens.filter(t => t.start >= bounds.start && t.index <= anchor && t.value === expansion.name && !t.definition && t.state !== 'inactive');
  const matches = [];
  for (const call of calls) {
    let cursor = call.index + 1;
    const argumentsList = [];
    for (let n = 0; n < count && cursor < tokens.length; n++) {
      const group = groupAt(tokens, cursor);
      if (group) { argumentsList.push({ start: cursor + 1, end: group.end }); cursor = group.next; }
      else { argumentsList.push({ start: cursor, end: cursor + 1 }); cursor++; }
    }
    if (argumentsList.length !== count || cursor - 1 !== anchor) continue;
    const scope = argumentsList[argument - 1];
    matches.push(...tokens.slice(scope.start, scope.end).filter(t => t.value === command && t.state !== 'inactive'
      && matchesWholeContext(tokens, t.index, frame, scope.start, scope.end)).map(token => ({ index, token })));
  }
  return matches;
}

function rangeOf(index, token) { return { file: index.file, start: token.start, end: token.end }; }
function rangeKey(range) { return `${range.file}:${range.start}:${range.end}`; }
function uniqueRanges(ranges) { return [...new Map(ranges.map(r => [rangeKey(r), r])).values()]; }

function baseError(record) {
  return { kind: /^Undefined control sequence\.?$/i.test(record.message.trim()) ? 'undefined-command' : 'compiler-error',
    message: record.message, reported: { file: record.file, line: record.line ?? null },
    status: 'unresolved', candidates: [], related: [], evidence: [] };
}

function resolveRecord(record, indices, globalUnsafe, dynamicMacros) {
  const error = baseError(record);
  if (error.kind !== 'undefined-command') {
    error.evidence.push('This compiler error does not identify a unique offending control sequence.');
    return error;
  }
  const frame = record.frames[0];
  const command = terminalCommand(frame);
  if (!command) {
    error.evidence.push('The compiler context is missing, truncated, or does not expose the failing command.');
    return error;
  }
  error.command = command;
  error.message = `Undefined command ${command}.`;
  error.evidence.push(`The compiler stops immediately after ${command} in its ${frame.type} context.`);
  const reported = indices.get(record.file);
  const sourceFrame = record.frames.find(f => f.type === 'source');
  let chosen = [];
  let supportsExact = false;
  let reason = '';
  let considered = [];

  if (frame.type === 'macro') {
    const definitions = [...indices.values()].flatMap(index => index.definitions
      .filter(d => d.name === frame.name && index.tokens[d.tokenStart].state !== 'inactive')
      .map(definition => ({ index, definition })));
    for (const { index, definition } of definitions) {
      if (!definition.body) continue;
      const start = definition.body.start + 1;
      const end = definition.body.end;
      const candidates = index.tokens.slice(start, end).filter(t => t.value === command && t.state !== 'inactive');
      considered.push(...candidates.map(token => ({ index, token })));
      chosen.push(...candidates.filter(t => matchesWholeContext(index.tokens, t.index, frame, start, end)).map(token => ({ index, token, definition })));
    }
    supportsExact = Boolean(sourceFrame?.complete) && !dynamicMacros && definitions.length === 1 && definitions[0].definition.safe && definitions[0].index.tokens[definitions[0].definition.tokenStart].state === 'active';
    reason = definitions.length > 1 ? 'Several definitions or assignments of the expanded macro exist; its active definition is uncertain.' : 'The named macro expansion matches its source definition body.';
    if (reported && sourceFrame) {
      const bounds = lineBounds(reported, record.line);
      const names = record.frames.filter(f => f.type === 'macro').map(f => f.name);
      const calls = bounds ? reported.tokens.filter(t => t.start >= bounds.start && t.start < bounds.end && names.includes(t.value) && !t.definition && t.state !== 'inactive') : [];
      if (calls.length === 1) error.related.push({ ...rangeOf(reported, calls[0]), label: 'Macro invoked here' });
    }
  } else if (reported) {
    const bounds = lineBounds(reported, record.line);
    const onLine = bounds ? reported.tokens.filter(t => t.start >= bounds.start && t.start < bounds.end && t.value === command && t.state !== 'inactive' && !t.definition) : [];
    considered.push(...onLine.map(token => ({ index: reported, token })));
    // A direct source split is strongest evidence, including repeated commands
    // on a single line. For argument errors the source split can be *after*
    // the entire argument, so match the argument frame as well.
    if (sourceFrame && frame.type !== 'argument' && terminalCommand(sourceFrame) === command) {
      chosen = onLine.filter(t => matchesSourceLine(reported, t, sourceFrame, bounds))
        .map(token => ({ index: reported, token }));
      supportsExact = true;
      reason = 'The command and both sides of the compiler source split match the reported source line.';
    }
    if (!chosen.length && bounds && frame.type === 'argument') {
      chosen = argumentCandidates(record, reported, frame, sourceFrame, bounds, command);
      supportsExact = chosen.length > 0;
      reason = 'The expanded macro parameter identifies the matching source argument.';
    }
    if (!chosen.length && bounds && (frame.type === 'recent' || frame.type === 'source')) {
      chosen = onLine.filter(t => matchesContext(reported.tokens, t.index, frame)).map(token => ({ index: reported, token }));
      // Recently-read alone is sufficient only when a real source frame is
      // present. A line number without the split may belong to an expansion.
      supportsExact = false;
      reason = 'The failing argument context matches a command on the reported source line.';
    }
    if (!chosen.length && bounds && frame.type === 'argument') {
      const environments = reported.environments.filter(env => COLLECTED.has(env.name) && env.balanced && env.closeStart >= bounds.start && env.closeStart < bounds.end);
      for (const env of environments) {
        const candidates = reported.tokens.slice(env.tokenStart, env.tokenEnd).filter(t => t.value === command && t.state !== 'inactive' && !t.definition);
        considered.push(...candidates.map(token => ({ index: reported, token })));
        chosen.push(...candidates.filter(t => matchesWholeContext(reported.tokens, t.index, frame, env.tokenStart, env.tokenEnd)).map(token => ({ index: reported, token })));
      }
      supportsExact = environments.length === 1 && Boolean(sourceFrame);
      reason = 'The argument context matches the body of the environment closed on the reported line.';
    }
  }

  const entries = chosen.length ? chosen : considered;
  error.candidates = uniqueRanges(entries.map(({ index, token }) => rangeOf(index, token)));
  if (error.candidates.length) error.status = 'candidate';
  const exactEntry = chosen.length === 1 ? chosen[0] : null;
  if (!record.explicitFile && sourceFrame && frame.type !== 'macro' && supportsExact) {
    const matchingFiles = [...indices.values()].filter(index => {
      const bounds = lineBounds(index, record.line);
      return bounds && index.tokens.some(token => token.start >= bounds.start && token.start < bounds.end
        && token.state !== 'inactive' && matchesSourceLine(index, token, sourceFrame, bounds));
    });
    if (matchingFiles.length !== 1 || matchingFiles[0].file !== record.file) {
      supportsExact = false;
      error.evidence.push('Traditional log file context is ambiguous across the source snapshots.');
    }
  }
  if (exactEntry && supportsExact && exactEntry.token.state === 'active' && !globalUnsafe && !record.inconsistentLine) {
    error.status = 'exact';
    error.range = rangeOf(exactEntry.index, exactEntry.token);
    error.candidates = [error.range];
  }
  if (reason) error.evidence.push(reason);
  if (record.inconsistentLine) error.evidence.push('The compiler header and source frame disagree about the source line.');
  if (frame.type === 'macro' && dynamicMacros) error.evidence.push('Dynamically named definitions or altered definition primitives prevent identifying the active macro definition.');
  if (globalUnsafe) error.evidence.push('Source changes TeX tokenization or core conditional semantics; exact lexical mapping is disabled.');
  if (entries.some(e => e.token.state === 'conditional')) error.evidence.push('The source lies in a conditional branch whose execution was not established.');
  if (!error.candidates.length) error.evidence.push('No matching source occurrence is established within the compiler-indicated scope.');
  else if (error.status !== 'exact') error.evidence.push('The available context does not justify choosing one exact source occurrence.');
  return error;
}

/**
 * @param {{log:string, rootFile:string, cwd?:string, sources:Record<string,string>}} input
 * @returns {{errors:Array<object>,stats:{total:number,exact:number,candidate:number,unresolved:number,duplicates:number}}}
 */
function resolveErrors({ log, rootFile, cwd = process.cwd(), sources }) {
  if (typeof log !== 'string' || typeof rootFile !== 'string' || !sources || typeof sources !== 'object') throw new TypeError('resolveErrors requires log, rootFile, and source snapshot strings.');
  cwd = path.resolve(cwd);
  rootFile = normalizePath(rootFile, cwd);
  const indices = new Map(Object.entries(sources).filter(([, text]) => typeof text === 'string')
    .map(([file, text]) => { file = normalizePath(file, cwd); return [file, indexSource(file, text)]; }));
  const records = parseLog(log, indices, cwd, rootFile);
  const globalUnsafe = [...indices.values()].some(index => index.unsafe || index.definitions.some(d =>
    ['\\iftrue', '\\iffalse', '\\if', '\\ifnum', '\\ifx', '\\ifcase', '\\else', '\\fi', '\\begin', '\\end'].includes(d.name)));
  const dynamicMacros = [...indices.values()].some(index => index.tokens.some(t => t.state !== 'inactive' && t.value === '\\csname')
    || index.definitions.some(d => ['\\newcommand', '\\renewcommand', '\\def', '\\gdef', '\\let'].includes(d.name)
      || index.tokens[d.tokenStart - 1]?.value === '\\expandafter'));
  const errors = [];
  const seen = new Map();
  let duplicates = 0;
  for (const record of records) {
    const error = resolveRecord(record, indices, globalUnsafe, dynamicMacros);
    const identity = error.status === 'exact' ? [error.kind, error.command, rangeKey(error.range)]
      : [error.kind, error.command, error.reported, error.candidates, record.frames.map(f => [f.type, f.left, f.right])];
    const id = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16);
    if (seen.has(id)) { duplicates++; continue; }
    error.id = id;
    seen.set(id, error);
    errors.push(error);
  }
  return { errors, stats: { total: errors.length, exact: errors.filter(e => e.status === 'exact').length,
    candidate: errors.filter(e => e.status === 'candidate').length, unresolved: errors.filter(e => e.status === 'unresolved').length, duplicates } };
}

module.exports = { resolveErrors };
