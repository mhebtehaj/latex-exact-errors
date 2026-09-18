'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { moveRange } = require('../src/live/ranges');
const edit = (rangeOffset, rangeLength, text) => ({ rangeOffset, rangeLength, text });

test('untouched spans track preceding multiline and UTF-16 edits', () => {
  const source = 'é $\\alhpa$ tail';
  const span = { start: 3, end: 9 };
  const insertion = '😀\n';
  const moved = moveRange(span, [edit(0, 0, insertion)]);
  assert.deepEqual(moved, { start: 6, end: 12 });
  assert.equal((insertion + source).slice(moved.start, moved.end), '\\alhpa');
  assert.deepEqual(moveRange(moved, [edit(0, insertion.length, '')]), span);
});

test('inserting, deleting or replacing within a token clears it', () => {
  const span = { start: 5, end: 11 };
  for (const change of [edit(7, 0, 'x'), edit(7, 1, ''), edit(6, 2, 'ph'), edit(0, 20, ''), edit(5, 6, '\\alpha')]) {
    assert.equal(moveRange(span, [change]), null);
  }
});

test('insertion at either edge clears a potentially extended token', () => {
  const span = { start: 5, end: 11 };
  assert.equal(moveRange(span, [edit(5, 0, '\\')]), null);
  assert.equal(moveRange(span, [edit(11, 0, 'x')]), null);
});

test('edits beside or after the token preserve its range correctly', () => {
  const span = { start: 5, end: 11 };
  assert.deepEqual(moveRange(span, [edit(2, 3, '')]), { start: 2, end: 8 });
  assert.deepEqual(moveRange(span, [edit(11, 3, '')]), span);
  assert.deepEqual(moveRange(span, [edit(20, 0, 'text')]), span);
});

test('multiple edits use original coordinates regardless of their order', () => {
  const span = { start: 20, end: 26 };
  const changes = [edit(30, 2, ''), edit(0, 0, '😀\n'), edit(10, 2, '')];
  assert.deepEqual(moveRange(span, changes), { start: 21, end: 27 });
  assert.deepEqual(moveRange(span, changes.toReversed()), { start: 21, end: 27 });
  assert.equal(moveRange(span, [...changes, edit(22, 1, '')]), null);
});

test('one touched finding does not clear another untouched finding', () => {
  const changes = [edit(6, 1, 'x')];
  assert.equal(moveRange({ start: 5, end: 11 }, changes), null);
  assert.deepEqual(moveRange({ start: 20, end: 26 }, changes), { start: 20, end: 26 });
});
