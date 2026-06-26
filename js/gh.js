export const reviewPath = ch => `reviews/${ch}.json`;
export const mergeReview = (local, remote) => {
  if (!remote) return local; const byId = Object.fromEntries((remote.comments||[]).map(c=>[c.id,c]));
  const comments = (local.comments||[]).map(lc => { const rc = byId[lc.id];
    return rc ? { ...lc, status:rc.status, claude:rc.claude } : lc; });
  // include remote-only comments (e.g. created on another machine)
  for (const rc of remote.comments||[]) if (!comments.find(c=>c.id===rc.id)) comments.push(rc);
  // read-state is app-owned; union so a section checked on any device stays checked
  const read = { ...(remote.read||{}), ...(local.read||{}) };
  return { ...remote, ...local, comments, read, secCount: local.secCount || remote.secCount };
};
const API='https://api.github.com', OWNER='mattlmccoy', REPO='dissertation-tracker-data';
const hdr = tok => ({ Authorization:`Bearer ${tok}`, Accept:'application/vnd.github+json' });
export async function getJson(tok, path){
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, { headers:hdr(tok) });
  if (r.status===404) return { json:null, sha:null };
  if (!r.ok) throw new Error('GitHub '+r.status);
  const d = await r.json();
  const txt = decodeURIComponent(escape(atob((d.content||'').replace(/\s/g,''))));   // strip GitHub's base64 newlines (atob is strict on some mobile browsers)
  return { json: JSON.parse(txt), sha:d.sha };
}
export async function putJson(tok, path, obj, sha, msg){
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(obj,null,2))));
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, { method:'PUT', headers:hdr(tok),
    body: JSON.stringify({ message:msg, content, sha:sha||undefined }) });
  if (!r.ok) throw new Error('github put failed: '+r.status); return (await r.json()).content.sha;
}
