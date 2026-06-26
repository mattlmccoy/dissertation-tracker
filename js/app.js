import { newReview, addComment, updateComment, deleteComment } from './model.js';
import { anchorFromSelection } from './anchor.js';
import { reviewPath, mergeReview, getJson, putJson, ghTree } from './gh.js';

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
    if (json){ review = mergeReview(review, json); save(); renderComments(); if (document.getElementById('doc')){ buildNav(); paintHighlights(); refreshStaged(); } } }
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
      <button class="icbtn" id="btn-focus" title="Focus mode (f)"><i class="ti ti-arrows-diagonal-minimize-2"></i></button>
      <button class="icbtn" id="btn-history" title="History"><i class="ti ti-history"></i></button>
      <button class="icbtn" id="btn-theme" title="Theme"><i class="ti ti-moon"></i></button>
      <button class="btn btn-primary" id="btn-send"><i class="ti ti-send"></i>Send to Claude</button>
      <button class="icbtn" id="btn-more" title="More"><i class="ti ti-dots"></i></button>
    </div>`;
  document.getElementById('btn-home').onclick = enterHome;
  document.getElementById('chsel').onclick = openChapterMenu;
  document.getElementById('btn-theme').onclick = toggleTheme;
  document.getElementById('btn-send').onclick = openSendMenu;
  document.getElementById('btn-history').onclick = showHistory;
  document.getElementById('btn-focus').onclick = toggleFocus;
  document.getElementById('btn-more').onclick = openMoreMenu;
  const si = document.getElementById('search');
  si.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(si.value); if (e.key === 'Escape'){ si.value=''; clearSearch(); } });
}
const shortTitle = t => { const s = t.split(':')[0].trim(); return s.length <= 34 ? s : s.slice(0,34).replace(/\s\S*$/,'') + '…'; };

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
  const doc = document.getElementById('doc');
  fixFootnotes(doc);
  runKatex(doc);
  wireFigures(doc);
  linkCrossRefs(doc);
  buildNav();
  paintHighlights();
  refreshStaged();
  restoreCursor();
  syncDown();
  loadAdvisorComments(current);
}
// ---------- advisor comments surfaced in the owner reviewer ----------
const ADVISOR_IDS = ['CJS','CCS'];
const ADVISOR_NAME = { CJS:'Saldaña', CCS:'Seepersad' };
let advisorComments = [];
async function loadAdvisorComments(ch){
  advisorComments = []; const dev = location.hostname==='localhost' || location.hostname==='127.0.0.1';
  for (const a of ADVISOR_IDS){
    try {
      let json = null;
      if (dev){ const r = await fetch(`./advisor/${a}/${ch}.json`); if (r.ok) json = await r.json(); }
      else { const t = tok(); if (!t) continue; json = (await getJson(t, `advisor/${a}/${ch}.json`)).json; }
      (json?.comments||[]).forEach(c => { if (c.status!=='resolved') advisorComments.push({ ...c, _advisor:a }); });
    } catch(e){}
  }
  if (current === ch){ renderComments(); paintHighlights(); }
}
// ---------- clickable cross-references (Figure / Table / Section / Chapter N.M) ----------
const chapterByNum = n => CHAPTERS.find(c => c.n === n);
function sectionNumberMap(doc){
  const n = chMeta(current).n; const map = {}; let h2 = 0, h3 = 0;
  doc.querySelectorAll('h2, h3').forEach(h => { if (h.tagName==='H2'){ h2++; h3 = 0; map[`${n}.${h2}`] = h; } else { h3++; map[`${n}.${h2}.${h3}`] = h; } });
  return map;
}
function figTableMaps(doc){   // read the real number from the numbered caption (robust to pandoc's nested subfigures)
  const fig = {}, tab = {};
  doc.querySelectorAll('figure').forEach(f => {
    const m = (f.querySelector(':scope > figcaption')?.textContent || '').match(/^\s*Figure\s+(\d+(?:\.\d+)*)\./);
    if (m) fig[m[1]] = f;
  });
  doc.querySelectorAll('table caption, figcaption').forEach(c => {
    const m = c.textContent.match(/^\s*Table\s+(\d+(?:\.\d+)*)\./);
    if (m) tab[m[1]] = c.closest('figure') || c.closest('table') || c;
  });
  return { fig, tab };
}
function linkCrossRefs(doc){
  const secMap = sectionNumberMap(doc), ftMap = figTableMaps(doc), curN = chMeta(current).n;
  const re = /\b(Figures?|Fig\.?|Tables?|Sections?|Chapters?)\s+(\d+(?:\.\d+)*)/gi;
  const reTest = /\b(Figures?|Fig\.?|Tables?|Sections?|Chapters?)\s+\d/i;   // non-global: stateless .test()
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
    acceptNode: t => { if (!t.nodeValue.trim() || !reTest.test(t.nodeValue)) return NodeFilter.FILTER_REJECT;
      const bad = t.parentElement?.closest('a, h1, h2, h3, figcaption, .math, .katex, #footnotes, script, style');
      return bad ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
  const todo = []; let node; while ((node = walker.nextNode())) todo.push(node);
  todo.forEach(text => {
    const frag = document.createDocumentFragment(); let last = 0; const s = text.nodeValue; re.lastIndex = 0; let m;
    while ((m = re.exec(s))){
      const kindWord = m[1], num = m[2], lead = parseInt(num, 10);
      const isFig = /^Fig/i.test(kindWord), isTab = /^Tab/i.test(kindWord), isChap = /^Chap/i.test(kindWord);
      let handler = null;
      if (isFig || isTab){
        if (lead === curN){ const t = (isFig ? ftMap.fig : ftMap.tab)[num]; if (t) handler = () => scrollFlash(t); }
        else { const ch = chapterByNum(lead); if (ch) handler = () => enterChapter(ch.id); } }
      else if (isChap){ const ch = chapterByNum(lead); if (ch && ch.id !== current) handler = () => enterChapter(ch.id); }
      else { // Section
        if (lead === curN){ const h = secMap[num]; if (h) handler = () => scrollFlash(h); }
        else { const ch = chapterByNum(lead); if (ch) handler = () => enterChapter(ch.id); } }
      if (last < m.index) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      if (handler){ const a = document.createElement('a'); a.className = 'xref'; a.textContent = m[0]; a.href = 'javascript:void 0';
        a.onclick = e => { e.preventDefault(); e.stopPropagation(); handler(); }; frag.appendChild(a); }
      else frag.appendChild(document.createTextNode(m[0]));
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    text.parentNode.replaceChild(frag, text);
  });
}
function scrollFlash(el){ el.scrollIntoView({ behavior:'smooth', block:'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
// ---------- figure commenting ----------
function figureLabel(fig){
  const cap = fig.querySelector('figcaption')?.textContent.trim() || '';
  const m = cap.match(/^(Figure|Fig\.?|Table)\s*[\d.]+/i);
  return { quote: cap.slice(0, 150), label: (m ? m[0] : '') , id: fig.querySelector('img')?.getAttribute('src')?.slice(-40) || '' };
}
function wireFigures(doc){
  doc.querySelectorAll('figure, img').forEach(el => {
    const fig = el.tagName === 'FIGURE' ? el : (el.closest('figure') || el);
    if (fig.dataset.figWired) return; fig.dataset.figWired = '1'; fig.classList.add('fig-commentable');
    fig.addEventListener('click', e => {
      if (window.getSelection().toString().trim()) return;     // a text drag, not a figure click
      e.stopPropagation(); document.getElementById('pop')?.remove();
      const info = figureLabel(fig);
      const rr = read.getBoundingClientRect(), fr = fig.getBoundingClientRect();
      const rects = [{ x:fr.x-rr.x, y:fr.y-rr.y+read.scrollTop, w:fr.width, h:fr.height }];
      pending = { quote: info.label ? `${info.label}${info.quote?': '+info.quote:''}` : (info.quote || 'Figure'),
                  kind:'figure', figure:info.id, section: headingFor(fig), confirmed:true, rects:[] };
      showPopover(pending, rects, 'figure');
    });
  });
}
// siunitx unit/prefix macros KaTeX doesn't know — expand to upright text so e.g. 119\,n\henry → 119 nH.
// Names that collide with real KaTeX macros (\bar accent, \square symbol) are deliberately excluded.
const SIUNITX = {
  henry:'H', farad:'F', ohm:'\\Omega', siemens:'S', volt:'V', watt:'W', ampere:'A', kelvin:'K',
  hertz:'Hz', joule:'J', newton:'N', pascal:'Pa', metre:'m', meter:'m', gram:'g',
  mole:'mol', tesla:'T', weber:'Wb', coulomb:'C', radian:'rad', steradian:'sr', lumen:'lm',
  candela:'cd', becquerel:'Bq', sievert:'Sv', katal:'kat', decibel:'dB',
  inch:'in', poise:'P',   // project-declared custom siunitx units (\bar deliberately omitted — collides with KaTeX \bar accent)
  percent:'\\%', degree:'^\\circ', arcminute:"'", arcsecond:"''",
  nano:'n', micro:'\\mu', milli:'m', pico:'p', femto:'f', kilo:'k', mega:'M', giga:'G',
  centi:'c', deci:'d', deca:'da', hecto:'h', atto:'a',
};
function expandUnits(tex){
  return tex.replace(/\\degreeCelsius\b/g, '{}^\\circ\\mathrm{C}')
            .replace(/\\([a-zA-Z]+)\b/g, (m, name) => {
              if (!(name in SIUNITX)) return m;
              const v = SIUNITX[name];
              return /^[A-Za-z]+$/.test(v) ? `\\mathrm{${v}}` : v;   // bare letters → upright; \Omega, \mu, ^\circ, % used as-is
            });
}
function runKatex(el){
  if (!window.katex){ setTimeout(() => runKatex(el), 100); return; }
  el.querySelectorAll('span.math').forEach(s => {
    const tex = expandUnits(s.textContent.replace(/\\label\{[^}]*\}/g, ''));   // \label → red error; siunitx units → upright text
    try { window.katex.render(tex, s, { displayMode:s.classList.contains('display'), throwOnError:false }); } catch(e){}
  });
}
// pandoc dumps every footnote in one section at the very end. Rather than reorder the nested
// section-divs (fragile), surface each note inline: clicking the superscript pops the note text
// right where it's referenced. The endnote list stays at the bottom under a "Notes" heading.
function fixFootnotes(doc){
  const fn = doc.querySelector('#footnotes');
  if (fn && !fn.querySelector('h2.fn-h')){ const h = document.createElement('h2'); h.className = 'fn-h'; h.textContent = 'Notes'; fn.insertBefore(h, fn.firstChild); }
  doc.querySelectorAll('a.footnote-ref').forEach(a => {
    a.onclick = e => { e.preventDefault(); e.stopPropagation();
      document.getElementById('fn-tip')?.remove();
      const li = doc.querySelector(a.getAttribute('href')); if (!li) return;
      const html = li.cloneNode(true); html.querySelectorAll('a.footnote-back').forEach(b => b.remove());
      const tip = document.createElement('div'); tip.id = 'fn-tip'; tip.className = 'fn-tip';
      tip.innerHTML = `<div class="fn-tip-h">Note ${a.textContent.replace(/[^0-9]/g,'')}</div>`;
      tip.append(...html.childNodes);   // already KaTeX-rendered by the doc pass — don't re-render (would double the math)
      read.appendChild(tip);
      const rr = read.getBoundingClientRect(), ar = a.getBoundingClientRect();
      tip.style.top = (ar.bottom - rr.top + read.scrollTop + 6) + 'px';
      tip.style.left = Math.min(ar.left - rr.left, read.clientWidth - 360) + 'px';
      const close = ev => { if (!tip.contains(ev.target)){ tip.remove(); document.removeEventListener('mousedown', close); } };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    };
  });
  doc.querySelectorAll('a.footnote-back').forEach(a => {
    a.onclick = e => { e.preventDefault(); const t = doc.querySelector(a.getAttribute('href')); if (t){ t.scrollIntoView({ behavior:'smooth', block:'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1500); } };
  });
}

// ---------- left section navigator ----------
function buildNav(){
  const nav = document.getElementById('nav');
  const hs = [...document.querySelectorAll('#doc h2, #doc h3')];
  review.read = review.read || {};
  review.secCount = hs.length;
  const doneN = hs.filter((h,i) => review.read[h.id || ('sec-'+i)]).length;
  nav.innerHTML = `<div class="lbl">SECTIONS<span style="margin-left:auto">${doneN}/${hs.length}</span></div>`;
  hs.forEach((h, i) => {
    if (!h.id) h.id = 'sec-' + i;
    const sub = h.tagName === 'H3';
    const cnt = review.comments.filter(c => (c.anchor.section||'') === h.textContent.trim()).length;
    const done = !!review.read[h.id];
    const a = document.createElement('a'); a.className = sub ? 'sub' : ''; a.dataset.sec = h.id;
    a.innerHTML = `<button class="chk${done?' on':''}" title="Mark section read"><i class="ti ti-${done?'circle-check-filled':'circle'}"></i></button>
      <span class="nav-t" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap${done?';color:var(--text-3)':''}">${h.textContent}</span>${cnt?`<span class="count">${cnt}</span>`:''}`;
    a.querySelector('.nav-t').onclick = () => h.scrollIntoView({ behavior:'smooth', block:'start' });
    a.querySelector('.chk').onclick = e => { e.stopPropagation();
      if (review.read[h.id]) delete review.read[h.id]; else review.read[h.id] = true;
      save(); syncUpSoon(); buildNav(); };
    nav.appendChild(a);
  });
  read.onscroll = () => { let cur = null; hs.forEach(h => { if (h.getBoundingClientRect().top < 140) cur = h.id; });
    nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.sec === cur));
    review.cursor = { sec: cur };   // scroll only tracks position for resume — it never marks sections read
    clearTimeout(scrollSaveT); scrollSaveT = setTimeout(() => save(), 900); };
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
function showPopover(anchor, rects, defaultTag='claim'){
  document.getElementById('pop')?.remove();
  const top = Math.max(...rects.map(r => r.y + r.h)) + 10;
  const isFig = anchor.kind === 'figure';
  const pop = document.createElement('div'); pop.id = 'pop'; pop.className = 'popover';
  pop.style.top = top + 'px'; pop.style.left = '50%'; pop.style.transform = 'translateX(-50%)';
  const modes = isFig ? '' : `<div class="pmodes" id="pmodes">
      <button data-m="note" class="on">Comment</button><button data-m="replace">Replace</button><button data-m="insert">Insert after</button><button data-m="delete">Delete</button></div>`;
  pop.innerHTML = `
    <div class="head"><i class="ti ti-${isFig?'photo':'link'}" style="margin-right:5px"></i>Commenting on ${isFig?'figure':''}
      <span class="loc"><i class="ti ti-circle-check-filled"></i>${anchor.section ? '§ '+anchor.section.slice(0,38) : (isFig?'this figure':'this passage')}</span></div>
    <div class="snip" id="psnip">"${escapeHtml(anchor.quote.slice(0,150))}"</div>
    ${modes}
    <textarea id="crepl" class="crepl" style="display:none"></textarea>
    <div class="tags" id="tags"></div>
    <textarea id="cbody" placeholder="Leave a comment…  (1–5 to tag · ⌘↵ to save)"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-primary" id="csave">Comment</button><button class="btn" id="ccancel">Cancel</button></div>`;
  read.appendChild(pop);
  let tag = defaultTag, mode = 'note'; const tr = pop.querySelector('#tags');
  TAGS.forEach(t => { const b = document.createElement('button'); b.textContent = t; b.dataset.tag = t;
    const pick = () => { tag = t;
      [...tr.children].forEach(x => { x.className = ''; x.style.background = 'transparent'; x.style.color = 'var(--text-2)'; x.style.borderColor = 'var(--border)'; });
      b.className = 'on'; b.style.background = `var(--${t}-bg)`; b.style.color = `var(--${t})`; b.style.borderColor = 'transparent'; };
    b.onclick = pick; tr.appendChild(b); if (t === defaultTag) pick(); });
  const repl = pop.querySelector('#crepl'), body = pop.querySelector('#cbody'), saveBtn = pop.querySelector('#csave');
  const setMode = m => { mode = m; pop.querySelectorAll('#pmodes button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
    const needsRepl = m === 'replace' || m === 'insert';
    repl.style.display = needsRepl ? 'block' : 'none';
    repl.placeholder = m === 'replace' ? 'Exact replacement text (verbatim)…' : 'Exact text to insert after the selection (verbatim)…';
    body.placeholder = m === 'note' ? 'Leave a comment…  (1–5 to tag · ⌘↵ to save)' : 'Optional note for this edit…';
    saveBtn.textContent = m === 'note' ? 'Comment' : m === 'delete' ? 'Suggest deletion' : m === 'insert' ? 'Suggest insertion' : 'Suggest replacement';
    saveBtn.className = 'btn ' + (m === 'delete' ? 'btn-danger' : m === 'note' ? 'btn-primary' : 'btn-suggest');
    pop.querySelector('#psnip').style.textDecoration = m === 'delete' ? 'line-through' : 'none';
    if (needsRepl) repl.focus(); else body.focus(); };
  pop.querySelectorAll('#pmodes button').forEach(b => b.onclick = () => setMode(b.dataset.m));
  body.focus();
  const close = () => { pop.remove(); window.getSelection().removeAllRanges(); };
  const commit = () => {
    let edit = null;
    if (mode === 'replace') edit = { op:'replace', find:anchor.quote, replacement:repl.value };
    else if (mode === 'insert') edit = { op:'insert', find:anchor.quote, position:'after', replacement:repl.value };
    else if (mode === 'delete') edit = { op:'delete', find:anchor.quote, replacement:'' };
    if (edit && mode !== 'delete' && !repl.value.trim()){ flash('Enter the '+(mode==='insert'?'text to insert':'replacement text')+'.'); return; }
    review = addComment(review, { anchor:pending, kind:edit?'suggestion':pending.kind, tag:edit?'edit':tag, body:body.value, edit });
    save(); syncUpSoon(); renderComments(); buildNav(); paintHighlights(); pop.remove(); window.getSelection().removeAllRanges(); };
  pop.querySelector('#ccancel').onclick = close;
  saveBtn.onclick = commit;
  pop._commit = commit; pop._pickTag = i => { const b = tr.children[i]; if (b) b.click(); };
  pop._setMode = setMode;
}

// ---------- comments rail ----------
let editingId = null, activeCommentId = null, resolvedOpen = false;
let cFilter = { status:'all', tag:'all', sort:'doc' };
const STATUS_ORDER = ['all','open','queued','staged','approved','answered','merged','declined','resolved'];
const RESOLVED_STATES = new Set(['merged','answered','declined','resolved']);   // terminal — fold into "Resolved (N)"
function docOrderIndex(){           // map comment id -> vertical position of its anchor in the doc
  const map = {}; const order = [...document.querySelectorAll('#doc p, #doc li, #doc figure, #doc figcaption, #doc h2, #doc h3')];
  review.comments.forEach(c => { const q = (c.anchor.quote||'').replace(/\s+/g,' ').trim().slice(0,30);
    const i = order.findIndex(el => el.textContent.replace(/\s+/g,' ').includes(q)); map[c.id] = i < 0 ? 1e6 : i; });
  return map;
}
function filteredComments(){
  let cs = review.comments.filter(c =>
    (cFilter.status === 'all' || c.status === cFilter.status) &&
    (cFilter.tag === 'all' || c.tag === cFilter.tag));
  if (cFilter.sort === 'new') cs = [...cs].sort((a,b) => (b.created_ts||'').localeCompare(a.created_ts||''));
  else { const ord = docOrderIndex(); cs = [...cs].sort((a,b) => (ord[a.id]-ord[b.id]) || (a.created_ts||'').localeCompare(b.created_ts||'')); }
  return cs;
}
function renderComments(){
  const pane = document.getElementById('comments');
  const open = review.comments.filter(c => c.status === 'open').length;
  pane.innerHTML = `<div class="lbl">COMMENTS<span style="margin-left:auto">${review.comments.length} · ${open} open</span></div>`;
  if (!review.comments.length){ pane.innerHTML += `<div style="font-size:12.5px;color:var(--text-3);padding:8px 2px">Select text or click a figure to leave a comment.</div>`; renderAdvisorSection(pane); return; }
  // filter / sort toolbar
  const bar = document.createElement('div'); bar.className = 'cbar';
  const present = new Set(review.comments.map(c => c.status));
  bar.innerHTML = `<select class="csel" id="fstatus">${STATUS_ORDER.filter(s => s==='all'||present.has(s)).map(s => `<option value="${s}"${cFilter.status===s?' selected':''}>${s==='all'?'all status':s}</option>`).join('')}</select>
    <select class="csel" id="ftag"><option value="all"${cFilter.tag==='all'?' selected':''}>all tags</option>${[...TAGS,'edit'].map(t => `<option value="${t}"${cFilter.tag===t?' selected':''}>${t}</option>`).join('')}</select>
    <button class="csort" id="fsort" title="Sort">${cFilter.sort==='doc'?'↓ document':'↓ newest'}</button>`;
  pane.appendChild(bar);
  bar.querySelector('#fstatus').onchange = e => { cFilter.status = e.target.value; renderComments(); };
  bar.querySelector('#ftag').onchange = e => { cFilter.tag = e.target.value; renderComments(); };
  bar.querySelector('#fsort').onclick = () => { cFilter.sort = cFilter.sort==='doc'?'new':'doc'; renderComments(); };
  const list = filteredComments();
  if (!list.length){ pane.appendChild(Object.assign(document.createElement('div'), { className:'cempty', textContent:'No comments match this filter.' })); return; }
  const fold = cFilter.status === 'all';                       // only fold when not explicitly filtering by status
  const active = fold ? list.filter(c => !RESOLVED_STATES.has(c.status)) : list;
  const resolved = fold ? list.filter(c => RESOLVED_STATES.has(c.status)) : [];
  active.forEach(c => pane.appendChild(buildCommentCard(c)));
  if (resolved.length){
    const grp = document.createElement('div'); grp.className = 'resolved-grp';
    const head = document.createElement('button'); head.className = 'resolved-head';
    head.innerHTML = `<i class="ti ti-chevron-${resolvedOpen?'down':'right'}"></i><span>Resolved</span><span class="rcount">${resolved.length}</span>`;
    const body = document.createElement('div'); body.className = 'resolved-body'; body.style.display = resolvedOpen?'block':'none';
    resolved.forEach(c => body.appendChild(buildCommentCard(c)));
    head.onclick = () => { resolvedOpen = !resolvedOpen; body.style.display = resolvedOpen?'block':'none'; head.querySelector('i').className = `ti ti-chevron-${resolvedOpen?'down':'right'}`; };
    grp.appendChild(head); grp.appendChild(body); pane.appendChild(grp);
  }
  renderAdvisorSection(pane);
}
function buildCommentCard(c){
    const card = document.createElement('div'); card.className = 'ccard'; card.dataset.id = c.id;
    if (RESOLVED_STATES.has(c.status)) card.classList.add('is-resolved');
    if (editingId === c.id){ card.style.cursor = 'default'; card.appendChild(editCard(c)); return card; }
    const st = c.status;
    const stColor = st==='staged'?'var(--info)':st==='merged'?'var(--success)':st==='queued'?'var(--warn)':st==='answered'?'var(--success)':st==='resolved'?'var(--text-3)':'var(--text-2)';
    const stBg = st==='staged'?'var(--info-bg)':st==='merged'?'var(--success-bg)':st==='queued'?'var(--warn-bg)':st==='answered'?'var(--success-bg)':'transparent';
    card.innerHTML = `<div class="row">
        <span class="chip" style="background:var(--${c.tag}-bg);color:var(--${c.tag})">${c.kind==='figure'?'<i class="ti ti-photo" style="font-size:11px;vertical-align:-1px;margin-right:2px"></i>':c.kind==='suggestion'?'<i class="ti ti-pencil" style="font-size:11px;vertical-align:-1px;margin-right:2px"></i>':''}${c.tag}</span>
        <span class="cactions" style="margin-left:auto;display:none;gap:1px">
          <button class="icbtn cact" data-act="resolve" title="${st==='resolved'?'Reopen':'Resolve'}" style="width:25px;height:25px;font-size:14px"><i class="ti ti-${st==='resolved'?'rotate-clockwise':'check'}"></i></button>
          <button class="icbtn cact" data-act="edit" title="Edit" style="width:25px;height:25px;font-size:14px"><i class="ti ti-pencil"></i></button>
          <button class="icbtn cact" data-act="del" title="Delete" style="width:25px;height:25px;font-size:14px"><i class="ti ti-trash"></i></button></span>
        <span class="status" style="background:${stBg};color:${stColor};${st==='open'?'display:none':''}">${st}</span></div>
      <div class="snip">"${escapeHtml((c.anchor.quote||'').slice(0,52))}"</div>
      <div class="body" style="${st==='resolved'?'opacity:.5;text-decoration:line-through':''}">${escapeHtml(c.body)}</div>
      ${suggHtml(c)}
      ${c.claude?.response ? `<div class="cresp"><div class="cresp-h"><i class="ti ti-robot-face"></i>Claude</div>${escapeHtml(c.claude.response)}</div>` : ''}
      ${c.claude?.branch ? `<div class="branch"><i class="ti ti-git-branch"></i>${escapeHtml(c.claude.branch)}</div>` : ''}
      ${(c.thread||[]).map(m => `<div class="cmsg ${m.author==='you'?'me':'cl'}"><span class="cmsg-h">${m.author==='you'?'You':'Claude'} · ${(m.ts||'').slice(0,10)}</span>${escapeHtml(m.text)}</div>`).join('')}
      ${st!=='resolved' ? `<div class="creply"><button class="creply-open">${(c.thread&&c.thread.length)?'Reply':(c.claude?.response||c.claude?.branch?'Reply / push back':'Add a note')}</button>
        <div class="creply-form" style="display:none"><textarea class="creply-t" rows="2" placeholder="${c.claude?.response||c.claude?.branch?'Reply to Claude / request a change…':'Add a private note…'}"></textarea><button class="btn btn-primary creply-send" style="padding:4px 11px;font-size:11.5px">Send</button></div></div>` : ''}`;
    if (c.id === activeCommentId) card.classList.add('active');
    card.onmouseenter = () => { card.querySelector('.cactions').style.display='flex'; const s=card.querySelector('.status'); if (st!=='open') s.style.visibility='hidden'; document.querySelector(`#doc .cmark[data-id="${c.id}"]`)?.classList.add('cmark-hot'); };
    card.onmouseleave = () => { card.querySelector('.cactions').style.display='none'; const s=card.querySelector('.status'); if (s) s.style.visibility=''; document.querySelector(`#doc .cmark[data-id="${c.id}"]`)?.classList.remove('cmark-hot'); };
    card.querySelector('.snip').onclick = () => jumpTo(c);
    card.querySelector('.body').onclick = () => jumpTo(c);
    card.querySelectorAll('.cact').forEach(b => b.onclick = e => { e.stopPropagation(); commentAction(c.id, b.dataset.act); });
    const ro = card.querySelector('.creply-open');
    if (ro){ const form = card.querySelector('.creply-form');
      ro.onclick = e => { e.stopPropagation(); form.style.display = form.style.display==='none'?'block':'none'; if (form.style.display==='block') form.querySelector('.creply-t').focus(); };
      card.querySelector('.creply-send').onclick = e => { e.stopPropagation(); const v = form.querySelector('.creply-t').value.trim(); if (v) replyToComment(c.id, v); };
    }
    return card;
}
// owner replies to a comment; a reply to a Claude-handled comment re-queues it for revision
async function replyToComment(id, text){
  const c = review.comments.find(x => x.id === id); if (!c) return;
  const thread = [...(c.thread||[]), { author:'you', text, ts:new Date().toISOString() }];
  const handled = !!(c.claude?.response || c.claude?.branch) || ['staged','approved','answered','merged'].includes(c.status);
  review = updateComment(review, id, { thread, status: handled ? 'queued' : c.status });
  save(); renderComments(); buildNav(); paintHighlights();
  const t = tok(); if (!t){ flash('Reply saved locally.'); return; }
  try {
    await syncUp();
    if (handled){
      const { json, sha } = await getJson(t, 'jobs.json'); const jobs = Array.isArray(json) ? json : [];
      jobs.push({ id:'j_'+Date.now().toString(36), type:'apply-edits', chapter:current, comment_ids:[id], revision:true, status:'queued', requested_ts:new Date().toISOString() });
      await putJson(t, 'jobs.json', jobs, sha, 'review: revision reply '+id);
      flash('Reply sent — Claude will revise this.');
    } else flash('Note added.');
  } catch(e){ flash('Reply saved; sync failed: '+e.message); }
}
function renderAdvisorSection(pane){
  if (!advisorComments.length) return;
  const lbl = document.createElement('div'); lbl.className = 'lbl adv-lbl';
  lbl.innerHTML = `<i class="ti ti-users" style="margin-right:5px"></i>FROM ADVISORS<span style="margin-left:auto">${advisorComments.length}</span>`;
  pane.appendChild(lbl);
  advisorComments.forEach(c => {
    const card = document.createElement('div'); card.className = 'ccard adv'; card.dataset.aid = c.id;
    card.innerHTML = `<div class="row">
        <span class="chip advchip"><i class="ti ti-user" style="font-size:11px;margin-right:3px"></i>${escapeHtml(ADVISOR_NAME[c._advisor]||c._advisor)}</span>
        ${c.tag&&c.tag!=='other'?`<span class="chip" style="margin-left:5px">${c.kind==='suggestion'?'<i class="ti ti-pencil" style="font-size:10px;margin-right:2px"></i>':''}${escapeHtml(c.tag)}</span>`:''}
        ${c.status==='submitted'?'<span class="status" style="margin-left:auto;background:var(--success-bg);color:var(--success)">submitted</span>':''}</div>
      <div class="snip">"${escapeHtml((c.anchor?.quote||'').slice(0,52))}"</div>
      <div class="body">${escapeHtml(c.body)}</div>${suggHtml(c)}${resolHtml(c)}
      <div class="advacts"><button class="btn aj" style="padding:3px 9px;font-size:11.5px"><i class="ti ti-arrow-right"></i>Jump</button><button class="btn ar" style="padding:3px 9px;font-size:11.5px"><i class="ti ti-message-check"></i>${c.resolution?'Update reply':'Mark addressed'}</button></div>
      <div class="rform" style="display:none">
        <select class="r-state"><option value="addressed"${c.resolution?.state==='addressed'?' selected':''}>Addressed — changed as suggested</option><option value="declined"${c.resolution?.state==='declined'?' selected':''}>Kept as written</option><option value="noted"${c.resolution?.state==='noted'?' selected':''}>Noted</option></select>
        <textarea class="r-note" rows="2" placeholder="How it was handled — the advisor sees this…">${escapeHtml(c.resolution?.note||'')}</textarea>
        <div style="display:flex;gap:6px;align-items:center"><button class="btn btn-primary r-save" style="padding:4px 10px;font-size:11.5px">Save to advisor</button><span class="r-stat" style="font-size:11px;color:var(--text-3)"></span></div></div>`;
    card.onmouseenter = () => document.querySelector(`#doc .cmark[data-aid="${c.id}"]`)?.classList.add('cmark-hot');
    card.onmouseleave = () => document.querySelector(`#doc .cmark[data-aid="${c.id}"]`)?.classList.remove('cmark-hot');
    card.querySelector('.snip').onclick = () => jumpToAdvisor(c);
    card.querySelector('.aj').onclick = () => jumpToAdvisor(c);
    const form = card.querySelector('.rform');
    card.querySelector('.ar').onclick = () => { form.style.display = form.style.display==='none'?'block':'none'; };
    card.querySelector('.r-save').onclick = async () => { const stat = card.querySelector('.r-stat'); stat.textContent = 'Saving…';
      const resolution = { state:card.querySelector('.r-state').value, note:card.querySelector('.r-note').value.trim(), ts:new Date().toISOString() };
      try { await recordResolution(c._advisor, current, c.id, resolution); c.resolution = resolution; stat.textContent = 'Saved — visible to the advisor.'; setTimeout(()=>renderComments(),600); }
      catch(e){ stat.textContent = 'Failed: ' + e.message; } };
    pane.appendChild(card);
  });
}
function jumpToAdvisor(c){
  const mark = document.querySelector(`#doc .cmark[data-aid="${c.id}"]`);
  const q = (c.anchor?.quote||'').replace(/\s+/g,' ').trim().slice(0,40);
  const el = mark || [...document.querySelectorAll('#doc p, #doc li, #doc figure, #doc figcaption')].find(p => p.textContent.replace(/\s+/g,' ').includes(q));
  if (el){ el.scrollIntoView({ behavior:'smooth', block:'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
}
function commentAction(id, act){
  const c = review.comments.find(x => x.id === id); if (!c) return;
  if (act === 'edit'){ editingId = id; renderComments(); return; }
  if (act === 'del'){ if (!confirm('Delete this comment?')) return; review = deleteComment(review, id); }
  else if (act === 'resolve'){ review = updateComment(review, id, { status: c.status==='resolved'?'open':'resolved' }); }
  save(); syncUpSoon(); renderComments(); buildNav(); paintHighlights();
}
function editCard(c){
  const w = document.createElement('div'); let tag = c.tag;
  w.innerHTML = `<div id="etags" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>
    <textarea id="ebody" style="width:100%;border:.5px solid var(--accent);border-radius:6px;padding:7px;font:inherit;background:var(--bg);color:var(--text);min-height:54px;outline:none">${escapeHtml(c.body)}</textarea>
    <div style="display:flex;gap:6px;margin-top:8px"><button class="btn btn-primary" id="esave" style="padding:5px 13px;font-size:12px">Save</button><button class="btn" id="ecancel" style="padding:5px 13px;font-size:12px">Cancel</button></div>`;
  const tr = w.querySelector('#etags');
  TAGS.forEach(t => { const b = document.createElement('button'); b.textContent = t;
    b.style.cssText = 'font-size:11px;padding:2px 9px;border-radius:20px;border:.5px solid var(--border);color:var(--text-2);background:transparent';
    const pick = () => { tag = t; [...tr.children].forEach(x => { x.style.background='transparent'; x.style.color='var(--text-2)'; x.style.borderColor='var(--border)'; }); b.style.background=`var(--${t}-bg)`; b.style.color=`var(--${t})`; b.style.borderColor='transparent'; };
    b.onclick = pick; tr.appendChild(b); if (t === tag) pick(); });
  w.querySelector('#ecancel').onclick = () => { editingId = null; renderComments(); };
  w.querySelector('#esave').onclick = () => { review = updateComment(review, c.id, { body:w.querySelector('#ebody').value, tag }); editingId = null; save(); syncUpSoon(); renderComments(); buildNav(); paintHighlights(); };
  return w;
}
function jumpTo(c){
  activeCommentId = c.id;
  const mark = document.querySelector(`#doc .cmark[data-id="${c.id}"], #doc .cmark-el[data-cid="${c.id}"], #doc figure[data-cid="${c.id}"]`);
  const q = (c.anchor.quote||'').replace(/\s+/g,' ').trim().slice(0,40);
  const el = mark || [...document.querySelectorAll('#doc p, #doc li, #doc figure, #doc figcaption, #doc h2, #doc h3')].find(p => p.textContent.replace(/\s+/g,' ').includes(q));
  if (el){ el.scrollIntoView({ behavior:'smooth', block:'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500); }
}
function activateComment(id){
  activeCommentId = id; renderComments();
  const card = document.querySelector(`#comments .ccard[data-id="${id}"]`);
  card?.scrollIntoView({ behavior:'smooth', block:'center' });
  card?.classList.add('flash'); setTimeout(() => card?.classList.remove('flash'), 1500);
}
// wrap each comment's quoted text in a <mark> so commented passages are visible while reading
function paintHighlights(){
  const doc = document.getElementById('doc'); if (!doc) return;
  doc.querySelectorAll('mark.cmark').forEach(m => { const p = m.parentNode; m.replaceWith(...m.childNodes); p.normalize(); });
  doc.querySelectorAll('.cmark-el').forEach(e => { e.classList.remove('cmark-el'); e.onclick = null; delete e.dataset.cid; });
  doc.querySelectorAll('figure[data-cid]').forEach(f => { f.classList.remove('cmark-fig'); delete f.dataset.cid; });
  const blocks = [...doc.querySelectorAll('p, li, figcaption')];
  review.comments.forEach(c => {
    if (c.status === 'resolved') return;
    if (c.kind === 'figure'){ markFigure(doc, c); return; }
    const q = (c.anchor.quote||'').replace(/\s+/g,' ').trim(); if (q.length < 4) return;
    const needle = q.slice(0, 50);
    const el = blocks.find(e => e.textContent.replace(/\s+/g,' ').includes(needle.slice(0,40)));
    if (!el) return;
    if (!wrapInNode(el, needle, c)){ el.classList.add('cmark-el'); el.dataset.cid = c.id; el.style.setProperty('--mk', `var(--${c.tag})`); el.onclick = () => activateComment(c.id); }
  });
  // advisor comments — distinct marker, jump to their card
  advisorComments.forEach(c => {
    if (c.kind === 'figure') return;
    const q = (c.anchor?.quote||'').replace(/\s+/g,' ').trim(); if (q.length < 4) return;
    const needle = q.slice(0, 50);
    const el = blocks.find(e => e.textContent.replace(/\s+/g,' ').includes(needle.slice(0,40)));
    if (el) wrapInNode(el, needle, c, true);
  });
}
function wrapInNode(el, needle, c, advisor){
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node, probe = needle.slice(0, 30);
  while ((node = tw.nextNode())){
    const idx = node.nodeValue.indexOf(probe);
    if (idx >= 0){
      const r = document.createRange();
      r.setStart(node, idx); r.setEnd(node, Math.min(node.nodeValue.length, idx + needle.length));
      const mk = document.createElement('mark'); mk.className = advisor ? 'cmark cmark-adv' : 'cmark';
      if (advisor) mk.dataset.aid = c.id; else { mk.dataset.id = c.id; mk.dataset.tag = c.tag; if (c.edit) mk.dataset.sugg = c.edit.op; }
      try { r.surroundContents(mk); mk.onclick = e => { e.stopPropagation(); advisor ? jumpToAdvisorCard(c.id) : activateComment(c.id); }; return true; } catch(e){ return false; }
    }
  }
  return false;
}
function jumpToAdvisorCard(aid){
  const card = document.querySelector(`#comments .ccard.adv[data-aid="${aid}"]`);
  card?.scrollIntoView({ behavior:'smooth', block:'center' }); card?.classList.add('flash'); setTimeout(() => card?.classList.remove('flash'), 1500);
}
// ---------- staged edits: show the pending change in context (before merge) ----------
function refreshStaged(){ const doc = document.getElementById('doc'); if (!doc) return; renderStagedEdits(doc); showApproveBar(); }
function renderStagedEdits(doc){
  doc.querySelectorAll('ins.tc-stage').forEach(n => n.remove());
  doc.querySelectorAll('del.tc-stage').forEach(n => { const p = n.parentNode; n.replaceWith(...n.childNodes); p.normalize(); });
  (review.comments||[]).forEach(c => {
    const se = c.staged_edit; if (!se || !['staged','approved'].includes(c.status)) return;
    const before = (se.before||'').replace(/\s+/g,' ').trim();
    const after  = (se.after ||'').replace(/\s+/g,' ').trim();
    if (!before) return;
    const probe = before.slice(0, 30);
    const blocks = [...doc.querySelectorAll('p, li, figcaption')];
    const el = blocks.find(e => e.textContent.replace(/\s+/g,' ').includes(probe));
    if (!el) return;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
    while ((node = tw.nextNode())){
      const collapsed = node.nodeValue.replace(/\s+/g,' ');
      const i = collapsed.indexOf(probe); if (i < 0) continue;
      try {
        // map the collapsed index back to a raw-node offset
        const rawStart = mapCollapsedIndex(node.nodeValue, i);
        const rawEnd = mapCollapsedIndex(node.nodeValue, i + before.length);
        const r = document.createRange(); r.setStart(node, rawStart); r.setEnd(node, Math.min(node.nodeValue.length, rawEnd));
        if (after.startsWith(before)){                 // pure append → keep before, insert the suffix
          const ins = document.createElement('ins'); ins.className = 'tc-stage'; ins.textContent = after.slice(before.length);
          r.collapse(false); r.insertNode(ins);
        } else {                                        // replace before with del+ins
          const del = document.createElement('del'); del.className = 'tc-stage';
          const ins = document.createElement('ins'); ins.className = 'tc-stage'; ins.textContent = after ? ' ' + after : '';
          r.surroundContents(del); del.after(ins);
        }
        return;
      } catch(e){ /* spans nodes — fall back to card-only */ return; }
    }
  });
}
function mapCollapsedIndex(raw, collapsedIdx){            // index in whitespace-collapsed text → index in raw text
  let ci = 0; for (let ri = 0; ri < raw.length; ri++){ if (ci === collapsedIdx) return ri;
    const isWs = /\s/.test(raw[ri]); if (isWs){ while (ri+1 < raw.length && /\s/.test(raw[ri+1])) ri++; } ci++; }
  return raw.length;
}
function showApproveBar(){
  document.getElementById('approvebar')?.remove();
  const staged = (review.comments||[]).filter(c => c.staged_edit && ['staged','approved'].includes(c.status));
  if (!staged.length) return;
  const allApproved = staged.every(c => c.status === 'approved');
  const bar = document.createElement('div'); bar.id = 'approvebar'; bar.className = 'approvebar';
  bar.innerHTML = `<i class="ti ti-git-pull-request"></i><span><b>${staged.length}</b> staged edit${staged.length>1?'s':''} in this chapter — shown inline as <span class="tc-legend"><del>old</del> <ins>new</ins></span>. Review, then merge to the dissertation.</span>
    <button class="btn ${allApproved?'':'btn-primary'}" id="approve-btn" style="margin-left:auto" ${allApproved?'disabled':''}>${allApproved?'Merge requested ✓':'Approve & merge chapter'}</button>`;
  read.prepend(bar);
  bar.querySelector('#approve-btn').onclick = approveChapter;
}
async function approveChapter(){
  const t = tok(); if (!t){ flash('Add your access token first.'); return; }
  if (!confirm(`Approve all staged edits for Chapter ${chMeta(current).n} and merge them into the dissertation?`)) return;
  flash('Requesting merge…');
  try {
    const { json, sha } = await getJson(t, 'jobs.json'); const jobs = Array.isArray(json) ? json : [];
    jobs.push({ id:'j_'+Date.now().toString(36), type:'merge', chapter:current, status:'queued', requested_ts:new Date().toISOString() });
    await putJson(t, 'jobs.json', jobs, sha, 'review: approve+merge '+current);
    review.comments.forEach(c => { if (c.staged_edit && c.status==='staged') c.status = 'approved'; });
    save(); await syncUp(); renderComments(); refreshStaged();
    flash('Approved — queued for merge into the dissertation.');
  } catch(e){ flash('Approve failed: '+e.message); }
}
function markFigure(doc, c){
  const figs = [...doc.querySelectorAll('figure')];
  const q = (c.anchor.quote||'').replace(/^[^:]*:\s*/,'').replace(/\s+/g,' ').trim().slice(0,30);
  const fig = figs.find(f => f.textContent.replace(/\s+/g,' ').includes(q)) || figs.find(f => f.querySelector('img')?.src.endsWith(c.anchor.figure||' '));
  if (fig){ fig.classList.add('cmark-fig'); fig.dataset.cid = c.id; fig.style.setProperty('--mk', `var(--${c.tag})`); }
}
const escapeHtml = s => (s||'').replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
function suggHtml(c){
  if (!c.edit) return '';
  const e = c.edit, find = escapeHtml((e.find||'').slice(0,140)), repl = escapeHtml((e.replacement||'').slice(0,240));
  const label = e.op==='replace'?'Replace':e.op==='insert'?'Insert after':'Delete';
  const inner = e.op==='delete' ? `<del>${find}</del>`
    : e.op==='insert' ? `<span style="color:var(--text-3)">…${find}</span> <ins>${repl}</ins>`
    : `<del>${find}</del> <ins>${repl}</ins>`;
  return `<div class="sugg"><div class="op"><i class="ti ti-pencil"></i>Suggested ${label} · verbatim</div>${inner}</div>`;
}

// ---------- search ----------
function runSearch(q){ clearSearch(); if (!q.trim()) return; const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
  let first = null; document.querySelectorAll('#doc p').forEach(p => { if (re.test(p.textContent)){ p.innerHTML = p.innerHTML.replace(re, m => `<mark style="background:var(--warn-bg)">${m}</mark>`); if (!first) first = p; } });
  if (first) first.scrollIntoView({ behavior:'smooth', block:'center' }); }
function clearSearch(){ document.querySelectorAll('#doc mark').forEach(m => m.replaceWith(...m.childNodes)); }

// ---------- send to claude / cursor ----------
function openSendMenu(){
  document.getElementById('sendmenu')?.remove();
  const menu = document.createElement('div'); menu.id = 'sendmenu';
  menu.style.cssText = 'position:absolute;top:50px;right:52px;z-index:45;background:var(--bg);border:.5px solid var(--border-2);border-radius:var(--r-md);box-shadow:0 10px 30px rgba(0,0,0,.16);padding:6px;min-width:248px';
  const open = review.comments.filter(c => c.status === 'open').length;
  menu.innerHTML = `
    <div class="smi" data-type="apply-edits"><i class="ti ti-git-pull-request"></i><div><div style="font-weight:500">Apply edits${open?` · ${open}`:''}</div><div class="smi-d">stage LaTeX edits on review-edits/${current}</div></div></div>
    <div class="smi" data-type="run-agents"><i class="ti ti-robot-face"></i><div><div style="font-weight:500">Run review agents</div><div class="smi-d">dissertation-adversary read-only critique</div></div></div>`;
  document.body.appendChild(menu);
  menu.querySelectorAll('.smi').forEach(el => { el.onmouseenter = () => el.style.background='var(--bg-3)'; el.onmouseleave = () => el.style.background='transparent';
    el.onclick = () => { menu.remove(); sendJob(el.dataset.type); }; });
  setTimeout(() => document.addEventListener('click', function h(e){ if (!menu.contains(e.target) && e.target.id!=='btn-send' && !e.target.closest?.('#btn-send')){ menu.remove(); document.removeEventListener('click', h); } }), 0);
}
async function sendJob(type){
  const t = tok(); if (!t){ flash('Add your access token first (click a chapter → connect).'); return; }
  try {
    await syncUp();
    const { json, sha } = await getJson(t, 'jobs.json');
    const jobs = Array.isArray(json) ? json : [];
    if (type === 'run-agents'){
      flash('Requesting agent review…');
      jobs.push({ id:'j_'+Date.now().toString(36), type:'run-agents', chapter:current,
        agents:['dissertation-adversary'], status:'queued', requested_ts:new Date().toISOString() });
      await putJson(t, 'jobs.json', jobs, sha, 'review: agents '+current);
      flash(`Requested adversary review of Chapter ${chMeta(current).n}`);
      return;
    }
    const open = review.comments.filter(c => c.status === 'open');
    if (!open.length){ flash('No open comments to send.'); return; }
    flash('Sending…');
    jobs.push({ id:'j_'+Date.now().toString(36), type:'apply-edits', chapter:current,
      comment_ids: open.map(c => c.id), status:'queued', requested_ts:new Date().toISOString() });
    await putJson(t, 'jobs.json', jobs, sha, 'review: queue '+current);
    open.forEach(c => { review = updateComment(review, c.id, { status:'queued' }); });
    save(); await syncUp(); renderComments(); buildNav(); paintHighlights();
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
  const checked = r?.read ? Object.keys(r.read).length : 0;
  const sec = r?.secCount || 0;
  return { open: r ? r.comments.filter(c=>c.status==='open').length : 0,
           merged: r ? r.comments.filter(c=>c.status==='merged').length : 0,
           total: r ? r.comments.length : 0,
           checked, sec, frac: sec ? checked/sec : 0, readDone: sec>0 && checked>=sec };
}
function enterHome(){
  document.getElementById('nav').style.display = 'none';
  document.getElementById('comments').style.display = 'none';
  document.getElementById('topbar').innerHTML =
    `<strong style="font-size:16px;font-weight:600">Dissertation Reviewer</strong>
     <span style="margin-left:auto;font-size:12.5px;color:var(--text-2);display:inline-flex;align-items:center;gap:6px"><i class="ti ti-flag"></i>defense in ${daysToDefense()} days</span>
     <button class="btn" id="btn-export" style="padding:6px 12px" title="Printable response to advisor comments"><i class="ti ti-file-text"></i>Response</button>
     <button class="btn" id="btn-releases" style="padding:6px 12px"><i class="ti ti-users"></i>Advisor releases</button>
     <a class="icbtn" href="./index.html" title="Back to dashboard"><i class="ti ti-layout-dashboard"></i></a>
     <button class="icbtn" id="btn-theme"><i class="ti ti-moon"></i></button>`;
  document.getElementById('btn-theme').onclick = toggleTheme;
  document.getElementById('btn-releases').onclick = openReleasePanel;
  document.getElementById('btn-export').onclick = exportAdvisorResponse;
  read.innerHTML = homeHtml();
  read.querySelectorAll('[data-ch]').forEach(el => el.onclick = () => enterChapter(el.dataset.ch));
  refreshInbox();
}
// ---------- inbox / triage: aggregate everything that needs the owner across all chapters ----------
async function gatherInbox(t){
  const paths = await ghTree(t);
  const has = p => paths.includes(p);
  const jr = await getJson(t, 'jobs.json').catch(() => ({ json:null }));
  const jobs = Array.isArray(jr.json) ? jr.json : [];
  const chData = await Promise.all(CHAPTERS.map(async c => {
    const p = `reviews/${c.id}.json`;
    const r = has(p) ? await getJson(t, p).catch(() => ({ json:null })) : { json:null };
    const cs = r.json?.comments || [];
    return { ch:c.id, n:c.n, title:c.title,
      open: cs.filter(x => x.status==='open').length,
      staged: cs.filter(x => x.status==='staged' || x.status==='approved').length,
      merged: cs.filter(x => x.status==='merged').length, total: cs.length };
  }));
  const advFiles = paths.filter(p => /^advisor\/[^/]+\/[^/]+\.json$/.test(p));
  const advRaw = await Promise.all(advFiles.map(async p => {
    const m = p.match(/^advisor\/([^/]+)\/(.+)\.json$/);
    const r = await getJson(t, p).catch(() => ({ json:null }));
    const fresh = (r.json?.comments || []).filter(x => x.status==='submitted' && !x.resolution);
    return fresh.length ? { advisor:m[1], ch:m[2], count:fresh.length } : null;
  }));
  return { jobs, chData, adv: advRaw.filter(Boolean) };
}
// printable "how each advisor comment was addressed" — neutral, author-facing wording (never AI)
async function exportAdvisorResponse(){
  const t = tok(); if (!t){ flash('Connect first to build the response.'); return; }
  flash('Building response…');
  try {
    const paths = await ghTree(t);
    const advFiles = paths.filter(p => /^advisor\/[^/]+\/.+\.json$/.test(p));
    const byAdv = {};
    await Promise.all(advFiles.map(async p => {
      const m = p.match(/^advisor\/([^/]+)\/(.+)\.json$/);
      const r = await getJson(t, p).catch(() => ({ json:null }));
      const cs = (r.json?.comments || []).filter(x => x.status === 'submitted');
      if (cs.length) (byAdv[m[1]] ??= []).push({ ch:m[2], comments:cs });
    }));
    const RES = { addressed:'Addressed — changed as suggested', declined:'Kept as written', noted:'Noted' };
    const advs = Object.keys(byAdv).sort();
    if (!advs.length){ flash('No advisor comments to export yet.'); return; }
    const sections = advs.map(a => {
      const name = ADVISOR_NAME[a] || a;
      const items = byAdv[a].sort((x,y) => (chMeta(x.ch).n||0)-(chMeta(y.ch).n||0)).map(g => {
        const rows = g.comments.map(c => {
          const r = c.resolution;
          const status = r ? RES[r.state] || 'Noted' : '<i style="color:#999">Pending</i>';
          return `<tr><td class="q">"${escapeHtml((c.anchor?.quote||'').slice(0,90))}"</td>
            <td class="cm">${escapeHtml(c.body)}</td>
            <td class="rs"><b>${status}</b>${r?.note?`<div>${escapeHtml(r.note)}</div>`:''}</td></tr>`;
        }).join('');
        return `<h3>Chapter ${chMeta(g.ch).n} — ${escapeHtml(shortTitle(chMeta(g.ch).title))}</h3>
          <table><thead><tr><th>Passage</th><th>Comment</th><th>Response</th></tr></thead><tbody>${rows}</tbody></table>`;
      }).join('');
      return `<section><h2>Response to ${escapeHtml(name)}</h2>${items}</section>`;
    }).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Response to reviewer comments</title>
      <style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:32px auto;padding:0 20px;color:#1a1a1a}
      h1{font-size:22px} h2{font-size:17px;margin-top:30px;border-bottom:2px solid #333;padding-bottom:4px} h3{font-size:14px;color:#444;margin:18px 0 6px}
      table{width:100%;border-collapse:collapse;margin-bottom:10px} th,td{border:1px solid #ddd;padding:7px 9px;vertical-align:top;text-align:left;font-size:12.5px}
      th{background:#f4f4f4;font-size:11px;text-transform:uppercase;letter-spacing:.04em} td.q{width:30%;color:#555;font-style:italic} td.rs b{color:#1a7a3a} td.rs div{color:#444;margin-top:3px}
      @media print{body{margin:0}}</style></head>
      <body><h1>Response to reviewer comments</h1><p style="color:#666">Prepared by the author · ${new Date().toISOString().slice(0,10)}</p>${sections}</body></html>`;
    const w = window.open('', '_blank'); if (!w){ flash('Allow pop-ups to open the response.'); return; }
    w.document.write(html); w.document.close();
  } catch(e){ flash('Export failed: '+e.message); }
}
async function refreshInbox(){
  const panel = document.getElementById('inbox-panel'); if (!panel) return;
  const t = tok(); if (!t){ panel.style.display = 'none'; return; }
  try { renderInbox(panel, await gatherInbox(t)); }
  catch(e){ panel.innerHTML = `<div class="ibx-empty">Couldn't load triage (${escapeHtml(e.message)}).</div>`; }
}
function renderInbox(panel, { jobs, chData, adv }){
  const advByCh = {}; adv.forEach(a => { advByCh[a.ch] = (advByCh[a.ch]||0) + a.count; });
  const stagedTotal = chData.reduce((s,c) => s + c.staged, 0);
  const advTotal = adv.reduce((s,a) => s + a.count, 0);
  const queued = jobs.filter(j => j.status==='queued').length;
  const running = jobs.filter(j => j.status==='running').length;
  const firstStaged = chData.find(c => c.staged);
  const firstAdv = adv[0];
  const chip = (icon, n, label, color, ch) => n
    ? `<button class="ibx-chip" ${ch?`data-ch="${ch}"`:''} style="--c:${color}"><i class="ti ti-${icon}"></i><b>${n}</b> ${label}</button>` : '';
  const chips = [
    chip('git-pull-request', stagedTotal, 'staged to approve', 'var(--info)', firstStaged?.ch),
    chip('user-exclamation', advTotal, 'new advisor comment'+(advTotal!==1?'s':''), 'var(--accent)', firstAdv?.ch),
    chip('clock-play', queued+running, 'Claude job'+(queued+running!==1?'s':'')+' running', 'var(--warn)'),
  ].filter(Boolean).join('');
  const cell = (n, cls, ch) => n
    ? `<button class="mx ${cls}" data-ch="${ch}">${n}</button>` : `<span class="mx mx0">·</span>`;
  const rows = chData.map(c => `<div class="mxrow">
      <button class="mxname" data-ch="${c.ch}">Ch ${c.n}</button>
      ${cell(c.open,'mxopen',c.ch)}${cell(c.staged,'mxstaged',c.ch)}${advByCh[c.ch]?`<button class="mx mxadv" data-ch="${c.ch}">${advByCh[c.ch]}</button>`:'<span class="mx mx0">·</span>'}${cell(c.merged,'mxmerged',c.ch)}
    </div>`).join('');
  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="ibx-head"><i class="ti ti-inbox"></i>Needs you${(stagedTotal||advTotal||queued||running)?'':' — all clear ✓'}</div>
    ${chips ? `<div class="ibx-chips">${chips}</div>` : ''}
    <div class="mxgrid">
      <div class="mxrow mxhead"><span class="mxname"></span><span class="mx">open</span><span class="mx">staged</span><span class="mx">advisor</span><span class="mx">merged</span></div>
      ${rows}
    </div>`;
  panel.querySelectorAll('[data-ch]').forEach(el => el.onclick = () => enterChapter(el.dataset.ch));
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
    const done = s.readDone;
    const bar = done ? 'var(--success)' : 'var(--accent)';
    const status = done ? `<span style="color:var(--success)">complete</span>` : s.checked>0 ? `${s.checked}/${s.sec} sections` : `not started`;
    const right = s.open ? `<span style="color:var(--accent)">${s.open} open</span>` : s.merged ? `${s.merged} merged` : `<span style="color:var(--text-3)">—</span>`;
    return `<div class="chcard" data-ch="${c.id}" style="border:.5px solid var(--border);border-radius:var(--r-lg);padding:14px 15px;cursor:pointer">
        <div style="font-size:11.5px;color:var(--text-3)">Chapter ${c.n}</div>
        <div style="font-size:14px;font-weight:500;line-height:1.35;margin:3px 0 11px;min-height:38px">${shortTitle(c.title)}</div>
        <div style="height:5px;border-radius:4px;background:var(--bg-3);overflow:hidden;margin-bottom:8px"><div style="width:${done?100:pct}%;height:100%;background:${bar}"></div></div>
        <div style="font-size:11px;color:var(--text-2);display:flex"><span>${status}</span><span style="margin-left:auto">${right}</span></div></div>`;
  }).join('');
  return `<div style="max-width:900px;margin:0 auto;padding:28px 24px 90px">
      ${cont}
      <div id="inbox-panel" class="ibx" style="display:none"></div>
      <div style="font-size:11px;letter-spacing:.06em;color:var(--text-3);margin-bottom:13px">ALL CHAPTERS</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:14px">${cards}</div></div>`;
}

// ---------- history / version timeline (data repo content commits — readable with the data-repo token) ----------
const HIST_REPO = 'mattlmccoy/dissertation-tracker-data';
async function ghApi(t, path){
  const r = await fetch('https://api.github.com/' + path, { headers:{ Authorization:`Bearer ${t}`, Accept:'application/vnd.github+json' } });
  if (!r.ok) throw new Error('HTTP '+r.status); return r.json();
}
async function showHistory(){
  const t = tok();
  document.getElementById('nav').style.display = 'none';
  document.getElementById('comments').style.display = 'none';
  if (!t){ read.innerHTML = `<div class="empty"><div style="font-size:15px;font-weight:500">History needs your access token</div><div style="font-size:13px;color:var(--text-2);margin-top:6px">Open a chapter and add your data-repo token first.</div></div>`; return; }
  if (!current){ read.innerHTML = `<div class="empty">Open a chapter first, then view its history.</div>`; return; }
  read.innerHTML = `<div class="empty">Loading history…</div>`;
  const file = `content/${current}.html`;
  try {
    const commits = await ghApi(t, `repos/${HIST_REPO}/commits?path=${encodeURIComponent(file)}&per_page=20`);
    if (!commits.length){ read.innerHTML = `<div class="empty">No revision history recorded for this chapter yet.</div>`; return; }
    renderHistoryShell(commits, file); selectCommit(commits[0].sha, file);
  } catch(e){ read.innerHTML = `<div class="empty">Couldn't load history (${e.message}).</div>`; }
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
  const diff = document.getElementById('hist-diff'); diff.innerHTML = 'Loading…';
  try {
    const detail = await ghApi(tok(), `repos/${HIST_REPO}/commits/${sha}`);
    const f = (detail.files||[]).find(x => x.filename === file) || {};
    const d = new Date(detail.commit.author.date);
    diff.innerHTML = `
      <div style="font-size:13px;color:var(--text-3);margin-bottom:4px">${d.toLocaleString()} · ${escapeHtml(detail.commit.author.name)} · ${sha.slice(0,7)}</div>
      <div style="font-size:15px;font-weight:600;white-space:pre-wrap;margin-bottom:12px">${escapeHtml(detail.commit.message)}</div>
      <div style="display:flex;gap:14px;font-size:12.5px;color:var(--text-2)">
        <span><b style="color:var(--success)">+${f.additions||0}</b> added</span>
        <span><b style="color:var(--danger)">−${f.deletions||0}</b> removed</span>
        <span>${f.changes||0} total changes to this chapter's content</span></div>
      <div style="font-size:12px;color:var(--text-3);margin-top:16px;border-top:.5px solid var(--border);padding-top:12px">This timeline records when each chapter was (re)published from the LaTeX source. The rendered content above always reflects the latest published version.</div>`;
  } catch(e){ diff.innerHTML = `<div style="color:var(--text-3)">Couldn't load this revision (${e.message}).</div>`; }
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

// ---------- panes / focus / keyboard ----------
function toggleNav(){ const n = document.getElementById('nav'); if (n) n.style.display = n.style.display==='none'?'':'none'; }
function toggleRail(){ const c = document.getElementById('comments'); if (c) c.style.display = c.style.display==='none'?'':'none'; }
function toggleFocus(){ document.body.classList.toggle('focusmode'); flash(document.body.classList.contains('focusmode')?'Focus mode on — press f to exit':'Focus mode off'); }
function cycleComment(dir){
  const list = filteredComments(); if (!list.length) return;
  let i = list.findIndex(c => c.id === activeCommentId);
  i = i < 0 ? (dir > 0 ? 0 : list.length-1) : (i + dir + list.length) % list.length;
  const c = list[i]; activeCommentId = c.id; renderComments(); jumpTo(c);
  document.querySelector(`#comments .ccard[data-id="${c.id}"]`)?.scrollIntoView({ block:'nearest' });
}
const SHORTCUTS = [['j / k','next / previous comment'],['↵ on a comment','jump to its place in the text'],['f','focus (distraction-free) mode'],['[ / ]','collapse left nav / comments rail'],['/','search this chapter'],['⌘\\','search the whole dissertation'],['⌘↵','open the Send to Claude menu'],['⌥1–5 (in popover)','pick a tag'],['Esc','close popover / overlay'],['?','show this help']];
const BUTTONS = [
  ['ti-layout-grid','Home — the chapter library'],
  ['ti-book-2','Chapter switcher'],
  ['ti-search','Search this chapter (⌘\\ = whole dissertation)'],
  ['ti-arrows-diagonal-minimize-2','Focus mode — hide both side panes'],
  ['ti-history','Version history & diffs for this chapter'],
  ['ti-moon','Light / dark theme'],
  ['ti-send','Send to Claude — apply edits or run review agents'],
  ['ti-circle','Check off a section as read (left rail)'],
  ['ti-dots','This menu — token, shortcuts, dashboard'],
];
function toggleHelp(){
  const ex = document.getElementById('helpov'); if (ex){ ex.remove(); return; }
  const ov = document.createElement('div'); ov.id = 'helpov';
  ov.innerHTML = `<div class="help-card">
    <div class="help-h">Reference</div>
    <div class="help-sub">Toolbar</div>
    ${BUTTONS.map(([ic,d]) => `<div class="help-row"><span class="help-ic"><i class="ti ${ic}"></i></span><span>${d}</span></div>`).join('')}
    <div class="help-sub" style="margin-top:14px">Keyboard</div>
    ${SHORTCUTS.map(([k,d]) => `<div class="help-row"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}
    <div style="text-align:right;margin-top:14px"><button class="btn" id="help-x">Close</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#help-x').onclick = () => ov.remove();
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
}
function openMoreMenu(){
  document.getElementById('moremenu')?.remove();
  const menu = document.createElement('div'); menu.id = 'moremenu';
  menu.style.cssText = 'position:absolute;top:50px;right:14px;z-index:45;background:var(--bg);border:.5px solid var(--border-2);border-radius:var(--r-md);box-shadow:0 10px 30px rgba(0,0,0,.16);padding:6px;min-width:220px';
  const hasTok = !!tok();
  menu.innerHTML = `
    <div class="mmi" data-act="release"><i class="ti ti-users"></i>Release to advisors…</div>
    <div class="mmi" data-act="help"><i class="ti ti-keyboard"></i>Buttons & shortcuts</div>
    <div class="mmi" data-act="token"><i class="ti ti-key"></i>Access token${hasTok?' <span style="color:var(--success);font-size:11px;margin-left:auto">connected</span>':' <span style="color:var(--warn);font-size:11px;margin-left:auto">not set</span>'}</div>
    <div class="mmi" data-act="dash"><i class="ti ti-layout-dashboard"></i>Back to dashboard</div>`;
  document.body.appendChild(menu);
  const acts = { release: openReleasePanel, help: toggleHelp, token: manageToken, dash: () => location.href = './index.html' };
  menu.querySelectorAll('.mmi').forEach(el => { el.onmouseenter = () => el.style.background='var(--bg-3)'; el.onmouseleave = () => el.style.background='transparent';
    el.onclick = () => { menu.remove(); acts[el.dataset.act](); }; });
  setTimeout(() => document.addEventListener('click', function h(e){ if (!menu.contains(e.target) && e.target.id!=='btn-more' && !e.target.closest?.('#btn-more')){ menu.remove(); document.removeEventListener('click', h); } }), 0);
}
function manageToken(){
  const cur = tok();
  const v = prompt(cur ? 'Access token is set. Paste a new one to replace it, or leave blank and OK to remove it:' : 'Paste a fine-grained PAT (Contents: read/write on the data repo):', '');
  if (v === null) return;
  if (v.trim() === ''){ if (cur && confirm('Remove the saved access token from this browser?')){ localStorage.removeItem('ghpat'); flash('Token removed.'); } return; }
  localStorage.setItem('ghpat', v.trim()); flash('Token saved.'); if (document.getElementById('doc') || current) loadChapter(current);
}
// ---------- release gate: control which chapters each advisor's portal shows ----------
async function openReleasePanel(){
  const t = tok(); if (!t){ flash('Add your access token first.'); return; }
  document.getElementById('nav').style.display = 'none';
  document.getElementById('comments').style.display = 'none';
  document.getElementById('topbar').innerHTML =
    `<strong style="font-size:16px;font-weight:600"><i class="ti ti-users" style="margin-right:7px"></i>Advisor releases</strong>
     <button class="btn" id="rel-close" style="margin-left:auto"><i class="ti ti-arrow-left"></i>Back to chapters</button>`;
  document.getElementById('rel-close').onclick = enterHome;
  read.innerHTML = `<div class="rel-page"><div id="rel-body" style="color:var(--text-3)">Loading…</div></div>`;
  let rel, sha;
  try { const r = await getJson(t, 'release.json'); rel = r.json || {}; sha = r.sha; }
  catch(e){ document.getElementById('rel-body').textContent = 'Could not load release.json ('+e.message+').'; return; }
  const advs = Object.keys(rel).filter(k => k !== '_comment');
  const base = location.origin + location.pathname.replace(/[^/]+$/, '');
  // pull each advisor's submitted comments (only for chapters they have released) for owner-side review
  const inbox = {};   // inbox[advisor] = [{chapter, comment}]
  await Promise.all(advs.flatMap(a => (rel[a].released||[]).map(async ch => {
    try { const r = await getJson(t, `advisor/${a}/${ch}.json`); (r.json?.comments||[]).forEach(c => (inbox[a] = inbox[a]||[]).push({ chapter:ch, c })); } catch(e){}
  })));
  const rows = CHAPTERS.map(c => `<tr><td>${c.n}. ${escapeHtml(shortTitle(c.title))}</td>${advs.map(a => `<td style="text-align:center"><input type="checkbox" data-a="${a}" data-ch="${c.id}" ${(rel[a].released||[]).includes(c.id)?'checked':''}></td>`).join('')}</tr>`).join('');
  const inboxHtml = advs.map(a => {
    const items = inbox[a]||[];
    return `<div class="rel-inbox"><div class="rel-inbox-h"><b>${escapeHtml(rel[a].name||a)}</b><span class="chip" style="background:var(--accent-bg);color:var(--accent)">${items.length} comment${items.length!==1?'s':''}</span></div>${
      items.length ? items.map(({chapter, c}) => `<div class="rel-cmt" data-ch="${chapter}" data-a="${a}" data-cid="${c.id}" data-q="${escapeHtml((c.anchor?.quote||'').slice(0,60))}">
          <div class="rel-cmt-h">${escapeHtml(chMeta(chapter).n+'')}. ${escapeHtml(shortTitle(chMeta(chapter).title))} · ${escapeHtml(c.anchor?.section||'')} ${c.status==='submitted'?'<span class="chip" style="background:var(--success-bg);color:var(--success);margin-left:6px">submitted</span>':c.status==='resolved'?'<span class="chip" style="margin-left:6px">withdrawn</span>':''}</div>
          <div class="rel-cmt-q">"${escapeHtml((c.anchor?.quote||'').slice(0,90))}"</div>
          <div class="rel-cmt-b">${escapeHtml(c.body||'')}</div>${c.edit?`<div class="sugg"><div class="op"><i class="ti ti-pencil"></i>Suggested ${c.edit.op}</div>${c.edit.op==='delete'?`<del>${escapeHtml(c.edit.find||'')}</del>`:`<del>${escapeHtml(c.edit.find||'')}</del> <ins>${escapeHtml(c.edit.replacement||'')}</ins>`}</div>`:''}
          ${resolHtml(c)}
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><button class="btn rel-open" style="padding:3px 10px;font-size:12px"><i class="ti ti-arrow-right"></i>Open in context</button><button class="btn rel-rec" style="padding:3px 10px;font-size:12px"><i class="ti ti-message-check"></i>${c.resolution?'Update':'Record'} resolution</button></div>
          <div class="rform" style="display:none">
            <select class="r-state"><option value="addressed"${c.resolution?.state==='addressed'?' selected':''}>Addressed — changed as suggested</option><option value="declined"${c.resolution?.state==='declined'?' selected':''}>Kept as written</option><option value="noted"${c.resolution?.state==='noted'?' selected':''}>Noted</option></select>
            <textarea class="r-note" rows="2" placeholder="How it was handled — the advisor sees this, keep it plain and reviewer-facing…">${escapeHtml(c.resolution?.note||'')}</textarea>
            <div style="display:flex;gap:6px;align-items:center"><button class="btn btn-primary r-save" style="padding:4px 11px;font-size:12px">Save to advisor</button><span class="r-stat" style="font-size:11px;color:var(--text-3)"></span></div></div></div>`).join('')
        : `<div style="font-size:12.5px;color:var(--text-3);padding:6px 2px">No comments submitted yet.</div>` }</div>`;
  }).join('');
  document.getElementById('rel-body').innerHTML = `
    <div class="rel-sec">Which chapters each advisor can see</div>
    <table class="rel-tbl"><thead><tr><th>Chapter</th>${advs.map(a => `<th>${escapeHtml(a)}<div style="font-weight:400;font-size:10px;color:var(--text-3)">${escapeHtml(rel[a].name||a)}</div></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div style="display:flex;gap:8px;margin:14px 0 6px;align-items:center"><button class="btn btn-primary" id="rel-save">Save &amp; publish</button><span id="rel-stat" style="font-size:12px;color:var(--text-3)"></span></div>
    <div class="rel-links">${advs.map(a => `<div><b>${escapeHtml(rel[a].name||a)}</b> → <code>${escapeHtml(base+a+'.html')}</code></div>`).join('')}</div>
    <div class="rel-sec" style="margin-top:26px">Comments received from advisors</div>${inboxHtml}`;
  document.querySelectorAll('.rel-cmt').forEach(el => {
    el.querySelector('.rel-open').onclick = () => {
      const ch = el.dataset.ch, q = el.dataset.q;
      enterChapter(ch); setTimeout(() => { const tg = [...document.querySelectorAll('#doc p, #doc li, #doc figcaption')].find(p => p.textContent.replace(/\s+/g,' ').includes(q.slice(0,40))); if (tg){ tg.scrollIntoView({behavior:'smooth',block:'center'}); tg.classList.add('flash'); setTimeout(()=>tg.classList.remove('flash'),1500); } }, 1900);
    };
    const form = el.querySelector('.rform');
    el.querySelector('.rel-rec').onclick = () => { form.style.display = form.style.display === 'none' ? 'block' : 'none'; };
    el.querySelector('.r-save').onclick = async () => {
      const stat = el.querySelector('.r-stat'); stat.textContent = 'Saving…';
      const resolution = { state: el.querySelector('.r-state').value, note: el.querySelector('.r-note').value.trim(), ts: new Date().toISOString() };
      try { await recordResolution(el.dataset.a, el.dataset.ch, el.dataset.cid, resolution); stat.textContent = 'Saved — the advisor will see this on their portal.'; }
      catch(e){ stat.textContent = 'Failed: ' + e.message; }
    };
  });
  document.getElementById('rel-save').onclick = async () => {
    advs.forEach(a => { rel[a].released = [...document.querySelectorAll(`input[data-a="${a}"]:checked`)].map(x => x.dataset.ch); });
    const stat = document.getElementById('rel-stat'); stat.textContent = 'Publishing…';
    try { sha = await putJson(t, 'release.json', rel, sha, 'release: update advisor chapter gate'); stat.textContent = 'Published ✓'; }
    catch(e){ stat.textContent = 'Failed: ' + e.message; }
  };
}
// resolution display (shared by the inbox + advisor portal — neutral, reviewer-facing wording)
function resolHtml(c){
  if (!c.resolution) return ''; const r = c.resolution;
  const label = r.state==='addressed'?'Addressed':r.state==='declined'?'Kept as written':'Noted';
  const icon = r.state==='addressed'?'circle-check':r.state==='declined'?'circle-x':'info-circle';
  const diff = (r.before||r.after) ? `<div class="rdiff">${r.before?`<del>${escapeHtml(r.before)}</del>`:''}${r.after?` <ins>${escapeHtml(r.after)}</ins>`:''}</div>` : '';
  return `<div class="resol resol-${r.state||'noted'}"><div class="resol-h"><i class="ti ti-${icon}"></i>${label}${r.ts?` · ${(r.ts||'').slice(0,10)}`:''}</div>${r.note?`<div>${escapeHtml(r.note)}</div>`:''}${diff}</div>`;
}
// write a resolution into an advisor's comment file so it appears on their portal
async function recordResolution(advisorId, ch, cid, resolution){
  const t = tok();
  const { json, sha } = await getJson(t, `advisor/${advisorId}/${ch}.json`);
  if (!json) throw new Error('advisor file not found');
  const c = (json.comments||[]).find(x => x.id === cid); if (!c) throw new Error('comment not found');
  c.resolution = resolution;
  await putJson(t, `advisor/${advisorId}/${ch}.json`, json, sha, `resolution: ${advisorId} ${ch} ${cid}`);
}
window.addEventListener('keydown', e => {
  const pop = document.getElementById('pop');
  if (pop){
    if (e.key === 'Escape'){ pop.querySelector('#ccancel').click(); return; }
    if ((e.metaKey||e.ctrlKey) && e.key === 'Enter'){ e.preventDefault(); pop._commit(); return; }
    if (e.altKey && e.key >= '1' && e.key <= '5'){ e.preventDefault(); pop._pickTag(+e.key - 1); return; }
    return;
  }
  if ((e.metaKey||e.ctrlKey) && e.key === '\\'){ e.preventDefault(); const s = document.getElementById('search'); if (s && s.value.trim()) globalSearch(s.value); else s?.focus(); return; }
  if ((e.metaKey||e.ctrlKey) && e.key === 'Enter'){ e.preventDefault(); if (document.getElementById('doc')) openSendMenu(); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if (typing){ if (e.key === 'Escape') document.activeElement.blur(); return; }
  if (!document.getElementById('doc') && !['?','f'].includes(e.key)) return;
  switch (e.key){
    case 'j': e.preventDefault(); cycleComment(1); break;
    case 'k': e.preventDefault(); cycleComment(-1); break;
    case 'f': toggleFocus(); break;
    case '[': toggleNav(); break;
    case ']': toggleRail(); break;
    case '/': e.preventDefault(); document.getElementById('search')?.focus(); break;
    case '?': toggleHelp(); break;
  }
});

// ---------- boot ----------
enterHome();
document.addEventListener('mouseover', e => { const c = e.target.closest?.('.chcard'); if (c) c.style.borderColor='var(--border-2)'; });
document.addEventListener('mouseout', e => { const c = e.target.closest?.('.chcard'); if (c) c.style.borderColor='var(--border)'; });
