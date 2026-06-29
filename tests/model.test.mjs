import { test } from 'node:test'; import assert from 'node:assert/strict';
import { newReview, addComment, updateComment, deleteComment, setCursor } from '../js/model.js';
import { setDecision, partitionByDecision } from '../js/model.js';

test('newReview seeds empty review for a chapter', () => {
  const r = newReview('ch_modeling', 'abc123');
  assert.equal(r.chapter, 'ch_modeling'); assert.equal(r.built_from_commit, 'abc123');
  assert.deepEqual(r.comments, []);
});
test('addComment appends with id + open status', () => {
  let r = newReview('ch_modeling','abc');
  r = addComment(r, { page:5, kind:'text', anchor:{quote:'x'}, tag:'claim', body:'check' });
  assert.equal(r.comments.length, 1);
  const c = r.comments[0];
  assert.match(c.id, /^c_/); assert.equal(c.status, 'open'); assert.equal(c.tag,'claim');
});
test('updateComment changes body, deleteComment removes', () => {
  let r = addComment(newReview('c','a'), { page:1, tag:'wording', body:'a', anchor:{quote:'q'} });
  const id = r.comments[0].id;
  r = updateComment(r, id, { body:'b' }); assert.equal(r.comments[0].body, 'b');
  r = deleteComment(r, id); assert.equal(r.comments.length, 0);
});
test('setCursor stores resume position', () => {
  const r = setCursor(newReview('c','a'), { page:3, scroll:0.5, last_comment_id:'c_1' });
  assert.equal(r.cursor.page, 3);
});

test('setDecision stamps decision + note + ts on the target comment only', () => {
  let r = addComment(newReview('c','a'), { tag:'wording', body:'b', anchor:{quote:'q'} });
  r = addComment(r, { tag:'wording', body:'b2', anchor:{quote:'q2'} });
  const id = r.comments[0].id;
  r = setDecision(r, id, 'approve');
  assert.equal(r.comments[0].decision, 'approve');
  assert.match(r.comments[0].decision_ts, /^\d{4}-/);
  assert.equal(r.comments[1].decision, undefined);
  r = setDecision(r, id, 'revise', 'please soften');
  assert.equal(r.comments[0].decision, 'revise');
  assert.equal(r.comments[0].decision_note, 'please soften');
});

test('setDecision with null clears the decision', () => {
  let r = addComment(newReview('c','a'), { tag:'x', body:'b', anchor:{quote:'q'} });
  const id = r.comments[0].id;
  r = setDecision(r, id, 'reject');
  r = setDecision(r, id, null);
  assert.equal(r.comments[0].decision, undefined);
  assert.equal(r.comments[0].decision_note, undefined);
});

test('partitionByDecision groups staged comments by decision', () => {
  const comments = [
    { id:'a', status:'staged', decision:'approve' },
    { id:'b', status:'staged', decision:'reject' },
    { id:'c', status:'staged', decision:'revise', decision_note:'n' },
    { id:'d', status:'staged' },
    { id:'e', status:'merged', decision:'approve' },
  ];
  const p = partitionByDecision(comments);
  assert.deepEqual(p.approved, ['a']);
  assert.deepEqual(p.rejected, ['b']);
  assert.deepEqual(p.revise, [{ cid:'c', note:'n' }]);
  assert.deepEqual(p.undecided, ['d']);   // 'e' is not staged -> ignored
});
