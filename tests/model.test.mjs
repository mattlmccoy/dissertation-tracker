import { test } from 'node:test'; import assert from 'node:assert/strict';
import { newReview, addComment, updateComment, deleteComment, setCursor } from '../js/model.js';

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
