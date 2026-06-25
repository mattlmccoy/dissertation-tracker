let _seq = 0;
const nid = () => `c_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
export const newReview = (chapter, builtFrom) =>
  ({ chapter, built_from_commit: builtFrom, synctex_present:false, cursor:null, comments:[] });
export const addComment = (r, c) => ({ ...r, comments:[...r.comments, {
  id: nid(), page:c.page, kind:c.kind||'text',
  anchor:{ quote:c.anchor?.quote||'', synctex:c.anchor?.synctex||null, rects:c.anchor?.rects||[], confirmed:!!c.anchor?.confirmed },
  tag:c.tag||'other', body:c.body||'', status:'open',
  claude:{ branch:null, commit:null, response:null, resolved_line:null, ts:null },
  created_ts:new Date().toISOString() }] });
export const updateComment = (r, id, patch) =>
  ({ ...r, comments:r.comments.map(c => c.id===id ? { ...c, ...patch } : c) });
export const deleteComment = (r, id) =>
  ({ ...r, comments:r.comments.filter(c => c.id!==id) });
export const setCursor = (r, cursor) => ({ ...r, cursor });
