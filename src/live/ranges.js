'use strict';

// All content-change offsets refer to the document before this edit event.
// Rebase untouched UTF-16 spans without depending on the order of the changes.
function moveRange(span, changes) {
  let shift = 0;
  for (const change of changes) {
    const start = change.rangeOffset, end = start + change.rangeLength;
    // Inserting at either edge can extend or change the token; clear it too.
    const touches = change.rangeLength === 0
      ? start >= span.start && start <= span.end
      : start < span.end && end > span.start;
    if (touches) return null;
    if (end <= span.start) shift += change.text.length - change.rangeLength;
  }
  return { ...span, start: span.start + shift, end: span.end + shift };
}

module.exports = { moveRange };
