'use strict';

/**
 * Fast, local structural hints for an editor buffer. This is intentionally not
 * a TeX interpreter: hints describe literal source structure, and an opener is
 * never presented as the unique position of a missing character. No I/O.
 * Offsets use JavaScript/VS Code UTF-16 code units and ends are exclusive.
 */

const MAX_SOURCE_LENGTH = 2 * 1024 * 1024;
const MAX_HINTS = 100;
const OPAQUE_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*',
  'BVerbatim', 'LVerbatim', 'lstlisting', 'minted', 'comment', 'filecontents',
  'filecontents*', 'luacode', 'luacode*', 'alltt', 'pycode', 'python', 'sageblock',
  'asy', 'tcblisting', 'verbatimwrite']);
const ALIGNMENTS = new Set(['align', 'align*', 'alignat', 'alignat*', 'flalign',
  'flalign*', 'gather', 'gather*', 'multline', 'multline*', 'aligned', 'alignedat',
  'gathered', 'split']);
const DISPLAY_ENVIRONMENTS = new Set(['align', 'align*', 'alignat', 'alignat*',
  'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*', 'equation',
  'equation*', 'displaymath', 'eqnarray', 'eqnarray*']);
const COLLECTED_ALIGNMENTS = new Set(['align', 'align*', 'alignat', 'alignat*',
  'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*']);
const TEXT_ARGUMENTS = new Set(['\\text', '\\textrm', '\\textsf', '\\texttt',
  '\\textnormal', '\\textbf', '\\textit', '\\textup', '\\textsl', '\\textsc',
  '\\mbox', '\\hbox', '\\intertext', '\\shortintertext']);
const SIMPLE_DEFINITIONS = new Set(['\\newcommand', '\\renewcommand', '\\providecommand',
  '\\DeclareRobustCommand', '\\DeclareMathOperator']);
const DOCUMENT_DEFINITIONS = new Set(['\\NewDocumentCommand', '\\RenewDocumentCommand',
  '\\ProvideDocumentCommand', '\\DeclareDocumentCommand']);
const ENVIRONMENT_DEFINITIONS = new Set(['\\newenvironment', '\\renewenvironment',
  '\\provideenvironment', '\\NewDocumentEnvironment', '\\RenewDocumentEnvironment',
  '\\ProvideDocumentEnvironment', '\\DeclareDocumentEnvironment']);
const PRIMITIVE_DEFINITIONS = new Set(['\\def', '\\gdef', '\\edef', '\\xdef']);
const UNSUPPORTED = new Set(['\\catcode', '\\scantokens', '\\csname', '\\endcsname',
  '\\let', '\\futurelet', '\\expandafter', '\\obeylines', '\\obeyspaces', '\\dospecials',
  '\\ExplSyntaxOn']);
const CONDITIONAL = /^\\if(?:[A-Za-z@]+)?$/;
const ORDINARY_IF_COMMANDS = new Set(['\\iff', '\\ifthenelse', '\\ifstrequal',
  '\\ifstrempty', '\\ifblank', '\\ifboolexpr', '\\ifdef', '\\ifdefempty',
  '\\ifdefequal', '\\ifdefstring', '\\ifcsdef', '\\ifcsundef', '\\ifnumcomp',
  '\\ifdimcomp', '\\ifnumequal', '\\ifdimequal']);
const isConditional = name => CONDITIONAL.test(name) && !ORDINARY_IF_COMMANDS.has(name);

function commandAt(text, start) {
  let end = start + 1;
  if (/[A-Za-z@_:]/.test(text[end] || '')) {
    while (end < text.length && /[A-Za-z@_:]/.test(text[end])) end++;
  } else if (end < text.length) end += text.codePointAt(end) > 0xffff ? 2 : 1;
  return { value: text.slice(start, end), start, end };
}

function whitespace(text, at) {
  while (at < text.length) {
    if (/\s/u.test(text[at])) { at++; continue; }
    if (text[at] === '%') {
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end + 1;
      continue;
    }
    break;
  }
  return at;
}

function verbEnd(text, at, name) {
  if (text[at] === '*') at++;
  if (name === '\\lstinline' && text[at] === '[') {
    const options = group(text, at, '[', ']');
    if (options) at = options.end;
  }
  if (at >= text.length || /\s/u.test(text[at])) return at;
  const delimiter = text[at++];
  while (at < text.length && text[at] !== delimiter && text[at] !== '\n') at++;
  return text[at] === delimiter ? at + 1 : at;
}

/** Scan a balanced literal argument without interpreting its stored content. */
function group(text, at, open = '{', close = '}') {
  if (text[at] !== open) return null;
  const start = at;
  let depth = 1;
  let braces = 0;
  for (at++; at < text.length; at++) {
    const char = text[at];
    if (char === '%') {
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end;
    } else if (char === '\\') {
      const command = commandAt(text, at);
      at = (command.value === '\\verb' || command.value === '\\lstinline'
        ? verbEnd(text, command.end, command.value) : command.end) - 1;
    } else if (open === '[' && char === '{') braces++;
    else if (open === '[' && char === '}' && braces) braces--;
    else if (!braces && char === open) depth++;
    else if (!braces && char === close && --depth === 0) return { start, end: at + 1 };
  }
  return null;
}

function definitionEnd(text, command) {
  const primitive = PRIMITIVE_DEFINITIONS.has(command.value);
  const environment = ENVIRONMENT_DEFINITIONS.has(command.value);
  const document = DOCUMENT_DEFINITIONS.has(command.value) || /DocumentEnvironment$/.test(command.value);
  if (!primitive && !environment && !document && !SIMPLE_DEFINITIONS.has(command.value)) return null;
  let at = whitespace(text, command.end);
  if (text[at] === '*') at = whitespace(text, at + 1);
  const nameGroup = group(text, at);
  if (nameGroup) at = nameGroup.end;
  else if (text[at] === '\\') at = commandAt(text, at).end;
  else return { end: text.length, bodies: [] }; // Do not scan an incomplete stored definition as document text.
  if (primitive) {
    while (at < text.length && text[at] !== '{') {
      if (text[at] === '%') at = whitespace(text, at);
      else if (text[at] === '\\') at = commandAt(text, at).end;
      else at++;
    }
  } else {
    at = whitespace(text, at);
    if (document) {
      const parameters = group(text, at);
      if (!parameters) return { end: text.length, bodies: [] };
      at = whitespace(text, parameters.end);
    } else {
      for (let n = 0; n < 2 && text[at] === '['; n++) {
        const optional = group(text, at, '[', ']');
        if (!optional) return { end: text.length, bodies: [] };
        at = whitespace(text, optional.end);
      }
    }
  }
  const body = group(text, at);
  if (!body) return { end: text.length, bodies: [] };
  const bodies = [text.slice(body.start + 1, body.end - 1)];
  at = body.end;
  if (environment) {
    const endBody = group(text, whitespace(text, at));
    if (!endBody) return { end: text.length, bodies: [] };
    bodies.push(text.slice(endBody.start + 1, endBody.end - 1));
    at = endBody.end;
  }
  return { end: at, bodies };
}

// A macro that stores half a math/environment pair can change structural state
// at its call site. Without expansion, literal source checking must abstain.
// Environment start/end definitions are considered together because their two
// halves intentionally store matching boundaries.
function storedStructureRisk(bodies) {
  const source = bodies.join('');
  const stack = [];
  const dollars = { '$': false, '$$': false };
  for (let at = 0; at < source.length;) {
    if (source[at] === '%') {
      const newline = source.indexOf('\n', at);
      at = newline < 0 ? source.length : newline + 1;
    } else if (source[at] === '\\') {
      const command = commandAt(source, at);
      at = command.end;
      if (command.value === '\\verb' || command.value === '\\lstinline') { at = verbEnd(source, at, command.value); continue; }
      // Balanced explicit groups in formatting macros do not leak structural state.
      if (command.value === '\\begingroup' || command.value === '\\bgroup') stack.push(command.value);
      else if (command.value === '\\endgroup' || command.value === '\\egroup') {
        if (stack.pop() !== (command.value === '\\endgroup' ? '\\begingroup' : '\\bgroup')) return true;
      } else if (command.value === '\\(' || command.value === '\\[') stack.push(command.value);
      else if (command.value === '\\)' || command.value === '\\]') {
        if (stack.pop() !== (command.value === '\\)' ? '\\(' : '\\[')) return true;
      } else if (command.value === '\\begin' || command.value === '\\end') {
        const argument = group(source, whitespace(source, at));
        if (!argument) return true;
        const name = source.slice(argument.start + 1, argument.end - 1).trim();
        at = argument.end;
        if (command.value === '\\begin') stack.push(name);
        else if (stack.pop() !== name) return true;
      }
    } else if (source[at] === '$') {
      const value = source[at + 1] === '$' ? '$$' : '$';
      dollars[value] = !dollars[value];
      at += value.length;
    } else at++;
  }
  return stack.length > 0 || dollars.$ || dollars.$$;
}

function skipBranch(text, at, acceptElse) {
  let depth = 1;
  while (at < text.length) {
    if (text[at] === '%') {
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end + 1;
    } else if (text[at] === '\\') {
      const command = commandAt(text, at);
      at = command.end;
      if (isConditional(command.value)) depth++;
      else if (command.value === '\\fi' && --depth === 0) return { end: at, branch: 'fi' };
      else if (command.value === '\\else' && depth === 1 && acceptElse) return { end: at, branch: 'else' };
    } else at++;
  }
  return { end: text.length, branch: 'incomplete' };
}

/**
 * @param {string} text An exact current editor buffer, including unsaved edits.
 * @param {{file?:string}} [options] Reserved file identity; no files are opened.
 * @returns {Array<{code:string,message:string,start:number,end:number,confidence:'certain'|'suspected',related?:Array<{start:number,end:number,message:string}>}>}
 */
function analyzeStructure(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('analyzeStructure requires source text.');
  if (!text.length || text.length > MAX_SOURCE_LENGTH) return [];
  const hints = [];
  const keys = new Set();
  const groups = [];
  const environments = [];
  const conditionals = [];
  let math = null;
  let textDepth = 0;
  let pendingText = -1;
  let lineStart = 0;
  let lineContent = false;
  let lineComment = false;
  let alignment = null;
  let display = null;
  let at = 0;

  function emit(code, message, position, confidence = 'suspected', related) {
    if (hints.length >= MAX_HINTS || !position || position.start >= text.length) return;
    const start = Math.max(0, position.start);
    const end = Math.min(text.length, Math.max(start + 1, position.end));
    const key = `${code}:${start}:${end}`;
    if (keys.has(key)) return;
    keys.add(key);
    const hint = { code, message, start, end, confidence };
    if (related?.length) hint.related = related.map(item => ({ start: item.start, end: Math.min(text.length, Math.max(item.start + 1, item.end)), message: item.message }));
    hints.push(hint);
  }

  function related(position, message) { return [{ start: position.start, end: position.end, message }]; }
  function refreshEnvironments() {
    alignment = environments.findLast(e => ALIGNMENTS.has(e.name)) || null;
    display = environments.findLast(e => DISPLAY_ENVIRONMENTS.has(e.name)) || null;
  }
  function skip(to) {
    // A skipped body contributes no structural events. Restore only its final
    // physical-line state so blank-line hints resume correctly afterwards.
    for (let cursor = at; cursor < to; cursor++) {
      if (text[cursor] === '\n') { lineStart = cursor + 1; lineComment = false; lineContent = false; }
      else if (!/\s/u.test(text[cursor])) lineContent = true;
    }
    return to;
  }
  function paragraph(position) {
    const paragraphSensitive = textDepth === 0 ? alignment : environments.findLast(e => COLLECTED_ALIGNMENTS.has(e.name));
    if (paragraphSensitive) emit('alignment-paragraph', `A paragraph break is not allowed in ${paragraphSensitive.name}; remove the blank line or use \\intertext{...} without blank lines for text between rows.`, position, 'certain', related(paragraphSensitive, 'This alignment starts here.'));
    if (math) emit('math-paragraph', `A paragraph break occurs before a matching ${math.close}. A closing delimiter may be missing earlier; this marks the opening context, not a unique insertion point.`, math, 'suspected', related(position, 'Paragraph break reached here.'));
  }
  function openDisplay(position) {
    if (math?.inline) {
      emit('math-display-inside-inline', 'A display starts while literal inline math appears open. An earlier missing $ or \\) may have shifted the pairing; check around this delimiter.', math, 'suspected', related(position, 'Display math starts here.'));
      math = null;
    }
  }
  function delimiter(value, position) {
    const isClose = value === '\\)' || value === '\\]';
    if (isClose) {
      if (math?.close === value) math = null;
      else if (math) {
        emit('math-mismatched', `This ${value} does not match the literal opener ${math.value}.`, position, 'suspected', related(math, 'The apparent opener is here.'));
        math = null;
      } else emit('math-unexpected-close', `No matching opening ${value === '\\)' ? '\\(' : '\\['} was found in this buffer.`, position);
      return;
    }
    if ((value === '$' || value === '$$') && math?.value === value) { math = null; return; }
    if (value === '\\[' || value === '$$') openDisplay(position);
    if (math) {
      emit('math-mismatched', `This ${value} appears inside math opened by ${math.value}; the literal delimiters do not pair.`, position, 'suspected', related(math, 'The apparent opener is here.'));
      return;
    }
    if (display && textDepth === 0) {
      emit('math-mismatched', `This ${value} appears inside the ${display.name} math environment. Check for an extra or earlier missing math delimiter.`, position, 'suspected', related(display, 'This math environment starts here.'));
      return;
    }
    math = { ...position, value, close: value === '\\(' ? '\\)' : value === '\\[' ? '\\]' : value, inline: value === '$' || value === '\\(' };
  }

  for (; at < text.length;) {
    const char = text[at];
    if (char === '\n') {
      if (!lineContent && !lineComment) paragraph({ start: lineStart, end: at + 1 });
      at++;
      lineStart = at; lineContent = false; lineComment = false;
      continue;
    }
    if (/\s/u.test(char)) { at++; continue; }
    if (char === '%') {
      lineComment = true;
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end;
      continue;
    }
    lineContent = true;
    if (char === '\\') {
      const command = commandAt(text, at);
      at = command.end;
      const definition = definitionEnd(text, command);
      if (definition !== null) {
        if (storedStructureRisk(definition.bodies)) return [];
        at = skip(definition.end); continue;
      }
      if (UNSUPPORTED.has(command.value)) return [];
      if (command.value === '\\newif') {
        const target = whitespace(text, at);
        at = skip(text[target] === '\\' ? commandAt(text, target).end : target);
        continue;
      }
      if (command.value === '\\iftrue') { conditionals.push(command); continue; }
      if (command.value === '\\iffalse') {
        const branch = skipBranch(text, at, true);
        if (branch.branch === 'else') conditionals.push(command);
        at = skip(branch.end);
        continue;
      }
      if (command.value === '\\else') {
        if (!conditionals.length) return [];
        const branch = skipBranch(text, at, false);
        conditionals.pop(); at = skip(branch.end); continue;
      }
      if (command.value === '\\fi') {
        if (!conditionals.length) return [];
        conditionals.pop(); continue;
      }
      if (isConditional(command.value)) return [];
      if (command.value === '\\verb' || command.value === '\\lstinline') {
        at = skip(verbEnd(text, at, command.value)); continue;
      }
      if (TEXT_ARGUMENTS.has(command.value)) {
        pendingText = whitespace(text, at);
        continue;
      }
      if (command.value === '\\ensuremath') {
        const body = group(text, whitespace(text, at));
        if (body) at = skip(body.end);
        continue;
      }
      if (['\\(', '\\)', '\\[', '\\]'].includes(command.value)) {
        delimiter(command.value, command); continue;
      }
      if (command.value === '\\par') { paragraph(command); continue; }
      if (command.value === '\\begin' || command.value === '\\end') {
        const nameArgument = group(text, whitespace(text, at));
        if (!nameArgument) continue; // Incomplete environment name during typing.
        const name = text.slice(nameArgument.start + 1, nameArgument.end - 1).trim();
        if (!/^[A-Za-z][A-Za-z0-9*@_-]*$/.test(name)) return [];
        const position = { start: command.start, end: nameArgument.end, name };
        at = skip(nameArgument.end);
        if (command.value === '\\begin' && OPAQUE_ENVIRONMENTS.has(name)) {
          const pattern = new RegExp('\\\\end\\s*\\{' + name.replace(/\*/g, '\\*') + '\\}', 'g');
          pattern.lastIndex = at;
          const end = pattern.exec(text);
          at = skip(end ? end.index + end[0].length : text.length);
          continue;
        }
        if (command.value === '\\begin') {
          if (DISPLAY_ENVIRONMENTS.has(name)) openDisplay(position);
          environments.push(position);
          if (environments.length > 512) return [];
        } else if (!environments.length) emit('environment-unexpected-close', `No matching \\begin{${name}} was found in this buffer.`, position);
        else {
          const opened = environments[environments.length - 1];
          if (opened.name === name) environments.pop();
          else {
            emit('environment-mismatched', `\\end{${name}} closes a different environment from \\begin{${opened.name}}.`, position, 'certain', related(opened, 'The most recent open environment is here.'));
            const matching = environments.findLastIndex(e => e.name === name);
            if (matching >= 0) environments.splice(matching);
            else environments.pop();
          }
        }
        refreshEnvironments();
        continue;
      }
      continue;
    }
    if (char === '$') {
      const end = text[at + 1] === '$' ? at + 2 : at + 1;
      delimiter(text.slice(at, end), { start: at, end });
      at = end; continue;
    }
    if (char === '{') {
      const opening = { start: at, end: at + 1, text: at === pendingText, savedMath: null };
      if (opening.text) { opening.savedMath = math; math = null; textDepth++; pendingText = -1; }
      groups.push(opening);
      if (groups.length > 512) return [];
    } else if (char === '}') {
      const opening = groups.pop();
      if (!opening) emit('brace-unexpected-close', 'No matching opening { was found in this buffer.', { start: at, end: at + 1 });
      else if (opening.text) {
        if (math) emit('math-unclosed', `No matching ${math.close} was found before this text argument ends. A delimiter may be missing earlier.`, math, 'suspected', [{ start: at, end: at + 1, message: 'The text argument ends here.' }]);
        math = opening.savedMath; textDepth--;
      }
    }
    at += text.codePointAt(at) > 0xffff ? 2 : 1;
  }
  if (math) emit('math-unclosed', `No matching ${math.close} was found later in this buffer. A closing delimiter may be missing, or an earlier missing delimiter may have shifted the pairing.`, math);
  for (const opening of groups) emit('brace-unclosed', 'No matching closing } was found later in this buffer.', opening);
  for (const opening of environments) emit('environment-unclosed', `No matching \\end{${opening.name}} was found later in this buffer.`, opening);
  return hints.sort((a, b) => a.start - b.start || a.end - b.end || a.code.localeCompare(b.code));
}

// Shared tolerant lexical primitives; the project-aware live analyzer builds on
// these while the original local checker remains available to existing callers.
module.exports = { analyzeStructure, commandAt, whitespace, group, verbEnd,
  OPAQUE_ENVIRONMENTS, TEXT_ARGUMENTS, SIMPLE_DEFINITIONS, DOCUMENT_DEFINITIONS,
  ENVIRONMENT_DEFINITIONS, PRIMITIVE_DEFINITIONS, storedStructureRisk };
