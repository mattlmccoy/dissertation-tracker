import { newReview, addComment } from './model.js';
import { anchorFromSelection } from './anchor.js';
import { reviewPath, mergeReview, getJson, putJson } from './gh.js';

const DATA_REPO = 'mattlmccoy/dissertation-tracker-data';
const CHAPTERS = [
  { id:'ch_introduction', n:1, title:'Introduction' },
  { id:'ch_background',   n:2, title:'Background: RF Dielectric Heating and Prior RFAM' },
  { id:'ch_platform',     n:3, title:'Design and Characterization of a Custom RFAM Platform' },
  { id:'ch_modeling',     n:4, title:'Computational Modeling of RF Sintering' },
  { id:'ch_compensation', n:5, title:'Simulation-Guided Compensation' },
  { id:'ch_validation',   n:6, title:'Experimental Validation' },
  { id:'ch_design_guide', n:7, title:'Design for RFAM: A Physics-Derived Capability Envelope' },
  { id:'ch_materials',    n:8, title:'Extensibility of RF in Advanced Manufacturing' },
  { id:'ch_conclusions',  n:9, title:'Conclusions' },
];
const chMeta = id => CHAPTERS.find(c => c.id === id) || { n:'?', title:id };
const TAGS = ['claim','wording','figure','citation','question'];

const read = document.getElementById('read');
let current = 'ch_modeling';
let review = loadLocalReview(current);

function loadLocalReview(ch){ return JSON.parse(localStorage.getItem('review:'+ch) || 'null') || newReview(ch, ''); }
const save = () => localStorage.setItem('review:'+current, JSON.stringify(review));
const tok = () => localStorage.getItem('ghpat');

// ---------- GitHub review sync (private data repo) ----------
let reviewSha = null, syncTimer = null, scrollSaveT = null;
async function syncDown(){
  const t = tok(); if (!t) return;
  try { const { json, sha } = await getJson(t, reviewPath(current)); reviewSha = sha;
    if (json){ review = mergeReview(review, json); save(); renderComments(); if (document.getElementById('doc')) buildNav(); } }
  catch(e){ /* offline / first time */ }
}
function syncUpSoon(){ if (!tok()) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncUp, 1200); }
async function syncUp(){
  const t = tok(); if (!t) return;
  try { const { sha } = await getJson(t, reviewPath(current)); reviewSha = await putJson(t, reviewPath(current), review, sha || reviewSha, 'review: '+current); }
  catch(e){ /* retried on next change */ }
}

// ---------- top bar ----------
function renderTopbar(){
  const m = chMeta(current);
  document.getElementById('topbar').innerHTML = `
    <button class="icbtn" id="btn-home" title="All chapters"><i class="ti ti-layout-grid"></i></button>
    <button class="chsel" id="chsel"><i class="ti ti-book-2"></i><span>Chapter ${m.n} · ${shortTitle(m.title)}</span><i class="ti ti-chevron-down" style="font-size:15px;color:var(--text-3)"></i></button>
    <div class="search"><i class="ti ti-search"></i><input id="search" placeholder="Search chapter · ⌘\\ for all"></div>
    <div style="margin-left:auto;display:flex;align-items:center;gap:3px">
      <button class="icbtn" id="btn-history" title="History"><i class="ti ti-history"></i></button>
      <button class="icbtn" id="btn-theme" title="Theme"><i class="ti ti-moon"></i></button>
      <button class="btn btn-primary" id="btn-send"><i class="ti ti-send"></i>Send to Claude</button>
      <button class="icbtn" id="btn-more"><i class="ti ti-dots"></i></button>
    </div>`;
  document.getElementById('btn-home').onclick = enterHome;
  document.getElementById('chsel').onclick = openChapterMenu;
  document.getElementById('btn-theme').onclick = toggleTheme;
  document.getElementById('btn-send').onclick = sendToClaude;
  document.getElementById('btn-history').onclick = showHistory;
  const si = document.getElementById('search');
  si.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(si.value); if (e.key === 'Escape'){ si.value=''; clearSearch(); } });
}
const shortTitle = t => { const s = t.split(':')[0].replace(/ and .*/,''); return s.length <= 30 ? s : s.slice(0,30).replace(/\s\S*$/,'') + '…'; };

function openChapterMenu(){
  const old = document.getElementById('chmenu'); if (old){ old.remove(); return; }
  const menu = document.createElement('div'); menu.id = 'chmenu';
  menu.style.cssText = 'position:absolute;top:50px;left:16px;z-index:40;background:var(--bg);border:.5px solid var(--border-2);border-radius:var(--r-md);box-shadow:0 10px 34px rgba(0,0,0,.16);padding:6px;min-width:330px';
  menu.innerHTML = CHAPTERS.map(c => `<div data-ch="${c.id}" style="display:flex;gap:8px;padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13px${c.id===current?';background:var(--accent-bg);color:var(--accent)':''}"><span style="color:var(--text-3);min-width:20px">${c.n}</span>${shortTitle(c.title)}</div>`).join('');
  menu.querySelectorAll('[data-ch]').forEach(d => { d.onmouseenter = () => { if (d.dataset.ch!==current) d.style.background='var(--bg-3)'; };
    d.onmouseleave = () => { if (d.dataset.ch!==current) d.style.background='transparent'; };
    d.onclick = () => { menu.remove(); selectChapter(d.dataset.ch); }; });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', function h(e){ if (!menu.contains(e.target) && e.target.id!=='chsel'){ menu.remove(); document.removeEventListener('click', h); } }), 0);
}
function enterChapter(ch){ current = ch; review = loadLocalReview(ch); localStorage.setItem('lastChapter', ch);
  document.getElementById('nav').style.display = ''; document.getElementById('comments').style.display = '';
  renderTopbar(); renderComments(); loadChapter(ch); }
const selectChapter = enterChapter;
function toggleTheme(){ document.documentElement.classList.toggle('dark'); localStorage.setItem('theme', document.documentElement.classList.contains('dark')?'dark':'light'); }
if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

// ---------- content (GitHub-pulled; localhost dev-fallback for UI work only) ----------
async function loadChapter(ch){
  read.innerHTML = `<div class="empty"><i class="ti ti-loader-2" style="font-size:22px"></i><div style="margin-top:8px">Loading chapter ${chMeta(ch).n}…</div></div>`;
  const dev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (dev){ try { const r = await fetch(`./chapters/${ch}.html`); if (r.ok){ renderDoc(await r.text()); return; } } catch(e){} }
  const t = tok();
  if (!t){ renderConnect(); return; }
  try {
    const r = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/content/${ch}.html`,
      { headers:{ Authorization:`Bearer ${t}`, Accept:'application/vnd.github.raw' } });
    if (!r.ok) throw new Error('HTTP '+r.status);
    renderDoc(await r.text());
  } catch(e){ read.innerHTML = `<div class="empty">Couldn't pull chapter ${chMeta(ch).n} from your private repo (${e.message}). Check the access token in <b>⋯ → Settings</b>.</div>`; }
}
function renderConnect(){
  read.innerHTML = `<div class="empty"><i class="ti ti-lock" style="font-size:24px;color:var(--text-3)"></i>
    <div style="font-size:17px;font-weight:500;margin:10px 0 6px">Connect your dissertation</div>
    <div style="font-size:13px;line-height:1.6;margin-bottom:16px">Chapters are pulled privately from your <code>${DATA_REPO}</code> repo. Paste a fine-grained token (Contents: read) — stored only in this browser.</div>
    <button class="btn" id="connect">Add access token</button></div>`;
  document.getElementById('connect').onclick = () => { const v = prompt('Fine-grained PAT (Contents read on the data repo):'); if (v){ localStorage.setItem('ghpat', v.trim()); loadChapter(current); } };
}

function renderDoc(fragment){
  read.innerHTML = `<article id="doc">${fragment}</article>`;
  runKatex(document.getElementById('doc'));
  buildNav();
  restoreCursor();
  syncDown();
}
function runKatex(el){
  if (!window.katex){ setTimeout(() => runKatex(el), 100); return; }
  el.querySelectorAll('span.math').forEach(s => { try { window.katex.render(s.textContent, s, { displayMode:s.classList.contains('display'), throwOnError:false }); } catch(e){} });
}

// ---------- left section navigator ----------
function buildNav(){
  const nav = document.getElementById('nav');
  const hs = [...document.querySelectorAll('#doc h2, #doc h3')];
  nav.innerHTML = `<div class="lbl">SECTIONS</div>`;
  hs.forEach((h, i) => {
    if (!h.id) h.id = 'sec-' + i;
    const sub = h.tagName === 'H3';
    const cnt = review.comments.filter(c => (c.anchor.section||'') === h.textContent.trim()).length;
    const a = document.createElement('a'); a.className = sub ? 'sub' : '';
    a.dataset.sec = h.id;
    a.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.textContent}</span>${cnt?`<span class="count">${cnt}</span>`:''}`;
    a.onclick = () => h.scrollIntoView({ behavior:'smooth', block:'start' });
    nav.appendChild(a);
  });
  read.onscroll = () => { let cur = null; hs.forEach(h => { if (h.getBoundingClientRect().top < 140) cur = h.id; });
    nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.sec === cur));
    const frac = read.scrollTop / Math.max(1, read.scrollHeight - read.clientHeight);
    review.cursor = { sec: cur, readFrac: Math.min(1, Math.max(review.cursor?.readFrac || 0, frac)) };
    clearTimeout(scrollSaveT); scrollSaveT = setTimeout(() => { save(); syncUpSoon(); }, 900); };
  read.onscroll();
}

// ---------- select-to-comment ----------
let pending = null;
read.addEventListener('mouseup', () => {
  if (document.getElementById('pop')) return;
  const sel = window.getSelection(); const text = sel.toString();
  if (!text.trim() || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!range.startContainer.parentElement?.closest('#doc')) return;
  const rr = read.getBoundingClientRect();
  const rects = [...range.getClientRects()].map(r => ({ x:r.x-rr.x, y:r.y-rr.y+read.scrollTop, w:r.width, h:r.height }));
  pending = anchorFromSelection({ text, page:null, rects });
  pending.section = headingFor(range.startContainer);
  showPopover(pending, rects);
});
function headingFor(node){
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && el.id !== 'doc'){ let p = el.previousElementSibling;
    while (p){ if (/^H[1-3]$/.test(p.tagName)) return p.textContent.trim(); p = p.previousElementSibling; } el = el.parentElement; }
  return '';
}
function showPopover(anchor, rects){
  document.getElementById('pop')?.remove();
  const top = Math.max(...rects.map(r => r.y + r.h)) + 10;
  const pop = document.createElement('div'); pop.id = 'pop'; pop.className = 'popover';
  pop.style.top = top + 'px'; pop.style.left = '50%'; pop.style.transform = 'translateX(-50%)';
  pop.innerHTML = `
    <div class="head"><i class="ti ti-link" style="margin-right:5px"></i>Commenting on
      <span class="loc"><i class="ti ti-circle-check-filled"></i>${anchor.section ? '§ '+anchor.section.slice(0,38) : 'this passage'}</span></div>
    <div class="snip">"${anchor.quote.slice(0,150)}"</div>
    <div class="tags" id="tags"></div>
    <textarea id="cbody" placeholder="Leave a comment…"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-primary" id="csave">Comment</button><button class="btn" id="ccancel">Cancel</button></div>`;
  read.appendChild(pop);
  let tag = 'claim'; const tr = pop.querySelector('#tags');
  TAGS.forEach(t => { const b = document.createElement('button'); b.textContent = t;
    const pick = () => { tag = t; [...tr.children].forEach(x => { x.className=''; }); b.className='on'; b.style.background=`var(--${t}-bg)`; b.style.color=`var(--${t})`; };
    b.onclick = pick; tr.appendChild(b); if (t==='claim') pick(); });
  pop.querySelector('#cbody').focus();
  pop.querySelector('#ccancel').onclick = () => { pop.remove(); window.getSelection().removeAllRanges(); };
  pop.querySelector('#csave').onclick = () => {
    review = addComment(review, { anchor:pending, tag, body:pop.querySelector('#cbody').value }); save(); syncUpSoon();
    renderComments(); buildNav(); pop.remove(); window.getSelection().removeAllRanges();
  };
}

// ---------- comments rail ----------
function renderComments(){
  const pane = document.getElementById('comments');
  const open = review.comments.filter(c => c.status === 'open').length;
  pane.innerHTML = `<div class="lbl">COMMENTS<span style="margin-left:auto">${review.comments.length} · ${open} open</span></div>`;
  if (!review.comments.length){ pane.innerHTML += `<div style="font-size:12.5px;color:var(--text-3);padding:8px 2px">Select text in the chapter to leave a comment.</div>`; return; }
  review.comments.forEach(c => {
    const stColor = c.status==='staged' ? 'var(--info)' : c.status==='merged' ? 'var(--success)' : 'var(--text-2)';
    const stBg = c.status==='staged' ? 'var(--info-bg)' : c.status==='merged' ? 'var(--success-bg)' : 'transparent';
    const card = document.createElement('div'); card.className = 'ccard';
    card.innerHTML = `<div class="row">
        <span class="chip" style="background:var(--${c.tag}-bg);color:var(--${c.tag})">${c.tag}</span>
        <span class="status" style="background:${stBg};color:${stColor}">${c.status}</span></div>
      <div class="snip">"${(c.anchor.quote||'').slice(0,52)}"</div>
      <div class="body">${escapeHtml(c.body)}</div>
      ${c.claude?.branch ? `<div class="branch"><i class="ti ti-git-branch"></i>${c.claude.branch}</div>` : ''}`;
    card.onclick = () => jumpTo(c);
    pane.appendChild(card);
  });
}
function jumpTo(c){
  const q = (c.anchor.quote||'').replace(/\s+/g,' ').trim().slice(0,40);
  const el = [...document.querySelectorAll('#doc p, #doc li, #doc figcaption, #doc h2, #doc h3')].find(p => p.textContent.replace(/\s+/g,' ').includes(q));
  if (el){ el.scrollIntoView({ behavior:'smooth', block:'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
}
const escapeHtml = s => (s||'').replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));

// ---------- search ----------
function runSearch(q){ clearSearch(); if (!q.trim()) return; const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
  let first = null; document.querySelectorAll('#doc p').forEach(p => { if (re.test(p.textContent)){ p.innerHTML = p.innerHTML.replace(re, m => `<mark style="background:var(--warn-bg)">${m}</mark>`); if (!first) first = p; } });
  if (first) first.scrollIntoView({ behavior:'smooth', block:'center' }); }
function clearSearch(){ document.querySelectorAll('#doc mark').forEach(m => m.replaceWith(...m.childNodes)); }

// ---------- send to claude / cursor ----------
async function sendToClaude(){
  const open = review.comments.filter(c => c.status === 'open');
  if (!open.length){ flash('No open comments to send.'); return; }
  const t = tok(); if (!t){ flash('Add your access token first (click a chapter → connect).'); return; }
  flash('Sending…');
  try {
    await syncUp();                                   // make sure the comments are on GitHub first
    const { json, sha } = await getJson(t, 'jobs.json');
    const jobs = Array.isArray(json) ? json : [];
    jobs.push({ id:'j_'+Date.now().toString(36), type:'apply-edits', chapter:current,
      comment_ids: open.map(c => c.id), status:'queued', requested_ts:new Date().toISOString() });
    await putJson(t, 'jobs.json', jobs, sha, 'review: queue '+current);
    flash(`Queued ${open.length} comment${open.length>1?'s':''} → review-edits/${current}`);
  } catch(e){ flash('Send failed: '+e.message); }
}
function flash(msg){ const t = document.createElement('div'); t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:9px 16px;border-radius:20px;font-size:13px;z-index:60;box-shadow:0 6px 20px rgba(0,0,0,.2)';
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600); }
function restoreCursor(){ if (review.cursor?.sec){ document.getElementById(review.cursor.sec)?.scrollIntoView(); } }

// ---------- home / chapter library ----------
const DEFENSE = '2026-10-15';
const daysToDefense = () => Math.max(0, Math.ceil((new Date(DEFENSE) - new Date()) / 86400000));
function chapterStats(ch){
  const r = JSON.parse(localStorage.getItem('review:'+ch) || 'null');
  return { open: r ? r.comments.filter(c=>c.status==='open').length : 0,
           merged: r ? r.comments.filter(c=>c.status==='merged').length : 0,
           total: r ? r.comments.length : 0, frac: r?.cursor?.readFrac || 0 };
}
function enterHome(){
  document.getElementById('nav').style.display = 'none';
  document.getElementById('comments').style.display = 'none';
  document.getElementById('topbar').innerHTML =
    `<strong style="font-size:16px;font-weight:600">Dissertation Reviewer</strong>
     <span style="margin-left:auto;font-size:12.5px;color:var(--text-2);display:inline-flex;align-items:center;gap:6px"><i class="ti ti-flag"></i>defense in ${daysToDefense()} days</span>
     <button class="icbtn" id="btn-theme"><i class="ti ti-moon"></i></button>`;
  document.getElementById('btn-theme').onclick = toggleTheme;
  read.innerHTML = homeHtml();
  read.querySelectorAll('[data-ch]').forEach(el => el.onclick = () => enterChapter(el.dataset.ch));
}
function homeHtml(){
  const last = localStorage.getItem('lastChapter');
  const lm = last && chMeta(last);
  const lr = last ? JSON.parse(localStorage.getItem('review:'+last) || 'null') : null;
  const cont = lm ? `<div style="border:.5px solid var(--accent);border-radius:var(--r-lg);padding:14px 16px;margin-bottom:26px;display:flex;align-items:center;gap:14px">
      <i class="ti ti-player-play" style="font-size:22px;color:var(--accent)"></i>
      <div style="min-width:0">
        <div style="font-size:11.5px;color:var(--text-2)">Continue where you left off</div>
        <div style="font-size:14px;font-weight:500">Chapter ${lm.n} · ${shortTitle(lm.title)}</div>
        ${lr?.comments?.length ? `<div style="font-size:11.5px;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">last comment: "${escapeHtml(lr.comments[lr.comments.length-1].body).slice(0,64)}"</div>` : ''}
      </div>
      <button class="btn" data-ch="${last}" style="margin-left:auto;flex-shrink:0">Resume</button></div>` : '';
  const cards = CHAPTERS.map(c => {
    const s = chapterStats(c.id); const pct = Math.round(s.frac*100);
    const done = s.total>0 && s.open===0 && s.merged>0;
    const bar = done ? 'var(--success)' : 'var(--accent)';
    const status = done ? `<span style="color:var(--success)">complete</span>` : s.frac>0 ? `${pct}% read` : `not started`;
    const right = s.open ? `<span style="color:var(--accent)">${s.open} open</span>` : s.merged ? `${s.merged} merged` : `<span style="color:var(--text-3)">—</span>`;
    return `<div class="chcard" data-ch="${c.id}" style="border:.5px solid var(--border);border-radius:var(--r-lg);padding:14px 15px;cursor:pointer">
        <div style="font-size:11.5px;color:var(--text-3)">Chapter ${c.n}</div>
        <div style="font-size:14px;font-weight:500;line-height:1.35;margin:3px 0 11px;min-height:38px">${shortTitle(c.title)}</div>
        <div style="height:5px;border-radius:4px;background:var(--bg-3);overflow:hidden;margin-bottom:8px"><div style="width:${done?100:pct}%;height:100%;background:${bar}"></div></div>
        <div style="font-size:11px;color:var(--text-2);display:flex"><span>${status}</span><span style="margin-left:auto">${right}</span></div></div>`;
  }).join('');
  return `<div style="max-width:900px;margin:0 auto;padding:28px 24px 90px">
      ${cont}
      <div style="font-size:11px;letter-spacing:.06em;color:var(--text-3);margin-bottom:13px">ALL CHAPTERS</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:14px">${cards}</div></div>`;
}

// ---------- history / version diff (reads phd-dissertation) ----------
const DISS_REPO = 'mattlmccoy/phd-dissertation';
async function ghApi(t, path){
  const r = await fetch('https://api.github.com/' + path, { headers:{ Authorization:`Bearer ${t}`, Accept:'application/vnd.github+json' } });
  if (!r.ok) throw new Error('HTTP '+r.status); return r.json();
}
async function showHistory(){
  const t = tok();
  document.getElementById('nav').style.display = 'none';
  document.getElementById('comments').style.display = 'none';
  if (!t){ read.innerHTML = `<div class="empty"><div style="font-size:15px;font-weight:500">History needs your access token</div><div style="font-size:13px;color:var(--text-2);margin-top:6px">Open a chapter and add a token with read access to <code>${DISS_REPO}</code>.</div></div>`; return; }
  read.innerHTML = `<div class="empty">Loading history…</div>`;
  const file = `chapters/${current}.tex`;
  try {
    const commits = await ghApi(t, `repos/${DISS_REPO}/commits?path=${encodeURIComponent(file)}&per_page=14`);
    if (!commits.length){ read.innerHTML = `<div class="empty">No commit history for ${file}.</div>`; return; }
    renderHistoryShell(commits, file); selectCommit(commits[0].sha, file);
  } catch(e){ read.innerHTML = `<div class="empty">Couldn't load history from ${DISS_REPO} — your token may not include it (${e.message}).</div>`; }
}
function renderHistoryShell(commits, file){
  const m = chMeta(current);
  read.innerHTML = `<div style="height:100%;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:.5px solid var(--border);background:var(--bg-2)">
        <i class="ti ti-history"></i><strong style="font-weight:600">History · Chapter ${m.n}</strong>
        <button class="btn" id="hist-close" style="margin-left:auto"><i class="ti ti-x"></i>Close</button></div>
      <div style="flex:1;display:flex;min-height:0">
        <div id="hist-list" style="flex:0 0 290px;border-right:.5px solid var(--border);overflow:auto;padding:12px 10px"></div>
        <div id="hist-diff" style="flex:1;min-width:0;overflow:auto;padding:16px 20px"></div></div></div>`;
  document.getElementById('hist-close').onclick = () => enterChapter(current);
  document.getElementById('hist-list').innerHTML = commits.map(c => {
    const d = new Date(c.commit.author.date), msg = c.commit.message.split('\n')[0];
    return `<div class="hcommit" data-sha="${c.sha}" style="display:flex;gap:9px;padding:9px 10px;border-radius:8px;cursor:pointer">
      <i class="ti ti-git-commit" style="color:var(--text-3);margin-top:2px"></i>
      <div style="min-width:0"><div style="font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(msg).slice(0,42)}</div>
        <div style="font-size:10.5px;color:var(--text-3)">${escapeHtml(c.commit.author.name.split(' ')[0])} · ${d.toLocaleDateString()} · ${c.sha.slice(0,7)}</div></div></div>`;
  }).join('');
  document.querySelectorAll('.hcommit').forEach(el => el.onclick = () => selectCommit(el.dataset.sha, file));
}
async function selectCommit(sha, file){
  document.querySelectorAll('.hcommit').forEach(el => el.style.background = el.dataset.sha === sha ? 'var(--accent-bg)' : 'transparent');
  const diff = document.getElementById('hist-diff'); diff.innerHTML = 'Loading diff…';
  try {
    const detail = await ghApi(tok(), `repos/${DISS_REPO}/commits/${sha}`);
    const f = (detail.files||[]).find(x => x.filename === file);
    diff.innerHTML = `<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--text-3);margin-bottom:10px">${file}</div>` +
      (f && f.patch ? renderPatch(f.patch) : `<div style="color:var(--text-3)">No textual change to this file in the commit.</div>`);
  } catch(e){ diff.innerHTML = `<div style="color:var(--text-3)">Couldn't load diff (${e.message}).</div>`; }
}
function renderPatch(patch){
  return `<div style="font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.7;border:.5px solid var(--border);border-radius:var(--r-md);overflow:hidden">` +
    patch.split('\n').slice(0,500).map(l => { const c = l[0];
      if (l.startsWith('@@')) return `<div style="padding:3px 12px;background:var(--bg-3);color:var(--text-3)">${escapeHtml(l)}</div>`;
      if (l.startsWith('+++')||l.startsWith('---')||l.startsWith('diff ')||l.startsWith('index ')) return '';
      if (c === '+') return `<div style="padding:1px 12px;background:var(--success-bg);color:var(--success)">${escapeHtml(l)}</div>`;
      if (c === '-') return `<div style="padding:1px 12px;background:var(--citation-bg);color:var(--citation)">${escapeHtml(l)}</div>`;
      return `<div style="padding:1px 12px;color:var(--text-2)">${escapeHtml(l)}</div>`;
    }).join('') + `</div>`;
}

// ---------- global search (across the dissertation) ----------
let searchIndex = null;
async function loadIndex(){
  if (searchIndex) return searchIndex;
  const dev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (dev){ try { const r = await fetch('./search_index.json'); if (r.ok){ searchIndex = await r.json(); return searchIndex; } } catch(e){} }
  const t = tok(); if (!t) return null;
  try { const r = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/search_index.json`,
      { headers:{ Authorization:`Bearer ${t}`, Accept:'application/vnd.github.raw' } });
    searchIndex = await r.json(); return searchIndex; } catch(e){ return null; }
}
async function globalSearch(q){
  if (!q.trim()) return;
  const idx = await loadIndex(); if (!idx){ flash('Global search needs your access token.'); return; }
  const ql = q.toLowerCase(), hits = [];
  for (const [ch, secs] of Object.entries(idx)) for (const s of secs)
    if ((s.h + ' ' + s.t).toLowerCase().includes(ql)) hits.push({ ch, h:s.h, snip: s.h + ' — ' + s.t });
  showSearchResults(q, hits.slice(0, 60));
}
function showSearchResults(q, hits){
  document.getElementById('searchpanel')?.remove();
  const p = document.createElement('div'); p.id = 'searchpanel';
  p.style.cssText = 'position:absolute;top:52px;left:50%;transform:translateX(-50%);z-index:50;width:min(640px,92%);max-height:72vh;overflow:auto;background:var(--bg);border:.5px solid var(--border-2);border-radius:var(--r-lg);box-shadow:0 14px 44px rgba(0,0,0,.18);padding:8px';
  p.innerHTML = `<div style="font-size:11px;color:var(--text-3);padding:6px 10px">${hits.length} result${hits.length!==1?'s':''} across the dissertation for "${escapeHtml(q)}"</div>` +
    (hits.length ? hits.map(h => `<div class="sres" data-ch="${h.ch}" data-h="${escapeHtml(h.h)}" style="padding:9px 10px;border-radius:8px;cursor:pointer">
        <div style="font-size:12px;font-weight:500">${chMeta(h.ch).n}. ${escapeHtml(shortTitle(chMeta(h.ch).title))} <span style="color:var(--text-3)">· ${escapeHtml(h.h).slice(0,42)}</span></div>
        <div style="font-size:11.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(h.snip).slice(0,120)}</div></div>`).join('') : `<div style="padding:10px;color:var(--text-3)">No matches.</div>`);
  document.body.appendChild(p);
  p.querySelectorAll('.sres').forEach(el => el.onclick = () => { p.remove(); const h = el.dataset.h; enterChapter(el.dataset.ch);
    setTimeout(() => { const hh = [...document.querySelectorAll('#doc h2, #doc h3')].find(x => x.textContent.trim() === h); hh?.scrollIntoView({ behavior:'smooth', block:'start' }); }, 1800); });
  setTimeout(() => document.addEventListener('click', function h(e){ if (!p.contains(e.target)){ p.remove(); document.removeEventListener('click', h); } }), 0);
}

// ---------- boot ----------
enterHome();
document.addEventListener('mouseover', e => { const c = e.target.closest?.('.chcard'); if (c) c.style.borderColor='var(--border-2)'; });
document.addEventListener('mouseout', e => { const c = e.target.closest?.('.chcard'); if (c) c.style.borderColor='var(--border)'; });
window.addEventListener('keydown', e => { if ((e.metaKey||e.ctrlKey) && e.key === '\\'){ e.preventDefault(); const s = document.getElementById('search'); if (s && s.value.trim()) globalSearch(s.value); else s?.focus(); } });
