'use strict';

/**
 * Select a prefix of a growing TeX transcript that is safe to pass to the
 * ordinary log parser. A trailing source split is not complete merely because
 * its first continuation has a newline: print-width wrapping can add physical
 * lines. Require a subsequent, complete context-boundary line as well.
 *
 * This does not establish source/dependency freshness. The caller must do that
 * independently, and must decode subprocess bytes with a streaming decoder.
 */

function errorHeader(line) {
  if (/^!\s+\S/.test(line)) return true;
  // Paths/messages may wrap. The final physical path fragment still contains
  // :line:, even if the extension itself was split by the engine's print width.
  return !/^(?:\s|<|\\|l\.\d)/.test(line) && /^[^\r\n]+:\d+:/.test(line);
}

function sourceFrame(line) { return /^l\.\d+(?:\s|$)/.test(line); }

function expansionFrame(line) {
  return /^<[^>]+>/.test(line) || /^\\(?:[A-Za-z@_:]+|.)[^\r\n]*?(?:->|\s+\.\.\.)/.test(line);
}

function contextBoundary(line) {
  // A truly empty line separates stdout records. A whitespace-only line can
  // instead be part of a wrapped, indented context and is not a boundary.
  if (line === '' || errorHeader(line)) return true;
  return /^(?:The control sequence at the end|I've (?:inserted|deleted)|I suspect|Try typing|Type (?:H |<return>|X )|See the .*(?:manual|documentation)|Output written on |Transcript written on |No pages of output\.|Here is how much of TeX's memory|Emergency stop\.|Fatal error occurred)/.test(line);
}

/**
 * @param {string} text Decoded, append-only stdout or the current fresh .log.
 * @returns {string} Original text through the last confirmed complete source
 * context, or an empty string if none is complete. Returned offsets preserve
 * original LF/CRLF bytes-as-text; a trailing split CRLF is never completed here.
 */
function completedErrorLog(text) {
  if (typeof text !== 'string') throw new TypeError('completedErrorLog requires decoded log text.');
  let phase = 'idle';
  let sourcePrefixLines = 0;
  let suffixLines = 0;
  let pendingEnd = 0;
  let completedEnd = 0;
  let from = 0;

  for (;;) {
    const newline = text.indexOf('\n', from);
    if (newline < 0) break; // Incomplete physical line, including a trailing CR.
    let line = text.slice(from, newline);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const end = newline + 1;
    const header = errorHeader(line);

    if (phase === 'source-suffix') {
      if (contextBoundary(line)) {
        completedEnd = pendingEnd;
        phase = header ? 'context' : 'idle';
      } else if (sourceFrame(line) || expansionFrame(line) || ++suffixLines > 32) {
        // A source-like fragment embedded in expansion output is not a final
        // source frame. Do not let a later record validate the earlier fragment.
        phase = 'invalid';
      } else pendingEnd = end;
    } else if (header) {
      phase = 'context';
    } else if (phase === 'context' && sourceFrame(line)) {
      phase = 'source-prefix';
      sourcePrefixLines = 1;
    } else if (phase === 'source-prefix') {
      if (/^[ \t]/.test(line)) {
        phase = 'source-suffix';
        suffixLines = 1;
        pendingEnd = end;
      } else if (!line || sourceFrame(line) || expansionFrame(line) || ++sourcePrefixLines > 8) {
        phase = 'invalid';
      }
      // Otherwise this is a possible hard-wrapped prefix fragment. The core
      // parser supports at most eight such physical lines; keep the same bound.
    }
    from = end;
  }
  return text.slice(0, completedEnd);
}

module.exports = { completedErrorLog };
