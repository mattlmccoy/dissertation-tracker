// advisor.js — reviewer portal for a single named reviewer. Shows only the chapters released to
// them, lets them comment on text and figures and propose exact edits, and submits those back
// privately. Self-contained (only the anchor helper is shared) — no build tooling of any kind.
import { anchorFromSelection } from './anchor.js';

// --- comment model (self-contained) ---
let _seq = 0; const nid = () => `c_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
const newReview = chapter => ({ chapter, cursor:null, comments:[] });
const addComment = (r, c) => ({ ...r, comments:[...r.comments, {
  id:nid(), kind:c.kind||'text',
  anchor:{ quote:c.anchor?.quote||'', rects:c.anchor?.rects||[], section:c.anchor?.section||'', figure:c.anchor?.figure||null, confirmed:!!c.anchor?.confirmed },
  tag:c.tag||'other', body:c.body||'', status:'open', author:c.author||null, edit:c.edit||null, created_ts:new Date().toISOString() }] });
const updateComment = (r, id, patch) => ({ ...r, comments:r.comments.map(c => c.id===id ? { ...c, ...patch } : c) });
const deleteComment = (r, id) => ({ ...r, comments:r.comments.filter(c => c.id!==id) });
// --- data-repo I/O (self-contained) ---
const _API='https://api.github.com', _OWNER='mattlmccoy', _REPO='dissertation-tracker-data';
const _hdr = t => ({ Authorization:`Bearer ${t}`, Accept:'application/vnd.github+json' });
async function getJson(t, path){ const r=await fetch(`${_API}/repos/${_OWNER}/${_REPO}/contents/${path}`,{headers:_hdr(t)}); if(r.status===404) return {json:null,sha:null}; if(!r.ok) throw new Error('GitHub '+r.status); const d=await r.json(); return {json:JSON.parse(decodeURIComponent(escape(atob((d.content||'').replace(/\s/g,''))))),sha:d.sha}; }
async function putJson(t, path, obj, sha, msg){ const content=btoa(unescape(encodeURIComponent(JSON.stringify(obj,null,2)))); const r=await fetch(`${_API}/repos/${_OWNER}/${_REPO}/contents/${path}`,{method:'PUT',headers:_hdr(t),body:JSON.stringify({message:msg,content,sha:sha||undefined})}); if(!r.ok) throw new Error('put failed: '+r.status); return (await r.json()).content.sha; }

const ADVISOR = window.ADVISOR || { id: '?', name: 'Reviewer' };
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
const TAGS = ['suggestion','wording','question','clarity','citation'];
const shortTitle = t => { const s = t.split(':')[0].trim(); return s.length <= 34 ? s : s.slice(0,34).replace(/\s\S*$/,'') + '…'; };
const escapeHtml = s => (s||'').replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));

const read = document.getElementById('read');
let current = null, review = null, released = [];
const tok = () => localStorage.getItem('ghpat');
const reviewPath = ch => `advisor/${ADVISOR.id}/${ch}.json`;
const localKey = ch => `adv:${ADVISOR.id}:${ch}`;
const loadLocal = ch => JSON.parse(localStorage.getItem(localKey(ch)) || 'null') || newReview(ch, '');
const save = () => localStorage.setItem(localKey(current), JSON.stringify(review));
if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

// ---------- sync (this reviewer's own comment file only) ----------
let reviewSha = null, syncTimer = null;
async function syncDown(){ const t = tok(); if (!t) return;
  try { const { json, sha } = await getJson(t, reviewPath(current)); reviewSha = sha;
    if (json){ const seen = new Set(review.comments.map(c=>c.id)); json.comments?.forEach(c=>{ if(!seen.has(c.id)) review.comments.push(c); }); save(); renderComments(); if (document.getElementById('doc')) paintHighlights(); } }
  catch(e){ /* first time / offline */ } }
function syncUpSoon(){ if (!tok()) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncUp, 1200); }
async function syncUp(){ const t = tok(); if (!t) return;
  try { const { sha } = await getJson(t, reviewPath(current)); reviewSha = await putJson(t, reviewPath(current), review, sha || reviewSha, `review(${ADVISOR.id}): ${current}`); }
  catch(e){ /* retried next change */ } }

// ---------- release gate + content ----------
async function loadRelease(){
  const t = tok();
  if (location.hostname==='localhost'||location.hostname==='127.0.0.1'){ try { const r=await fetch('./release.json'); if(r.ok){ apply(await r.json()); return; } } catch(e){} }
  if (!t){ released = []; return; }
  try { const r = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/release.json`,{ headers:{ Authorization:`Bearer ${t}`, Accept:'application/vnd.github.raw' } });
    if (r.ok) apply(await r.json()); } catch(e){ released = []; }
  function apply(j){ released = (j?.[ADVISOR.id]?.released) || []; }
}
async function loadChapter(ch){
  current = ch; review = loadLocal(ch);
  read.innerHTML = `<div class="empty"><i class="ti ti-loader-2" style="font-size:22px"></i><div style="margin-top:8px">Loading Chapter ${chMeta(ch).n}…</div></div>`;
  document.getElementById('nav').style.display=''; document.getElementById('comments').style.display='';
  renderTopbar(); renderComments();
  const dev = location.hostname==='localhost'||location.hostname==='127.0.0.1';
  if (dev){ try { const r=await fetch(`./chapters/${ch}.html`); if(r.ok){ renderDoc(await r.text()); return; } } catch(e){} }
  const t = tok(); if (!t){ renderConnect(); return; }
  try { const r = await fetch(`https://api.github.com/repos/${DATA_REPO}/contents/content/${ch}.html`,{ headers:{ Authorization:`Bearer ${t}`, Accept:'application/vnd.github.raw' } });
    if (!r.ok) throw new Error('HTTP '+r.status); renderDoc(await r.text()); }
  catch(e){ read.innerHTML = `<div class="empty">Couldn't load Chapter ${chMeta(ch).n} (${e.message}). Check your access link.</div>`; }
}
function renderConnect(){
  read.innerHTML = `<div class="empty"><i class="ti ti-lock" style="font-size:24px;color:var(--text-3)"></i>
    <div style="font-size:17px;font-weight:500;margin:10px 0 6px">Enter your access key</div>
    <div style="font-size:13px;line-height:1.6;margin-bottom:16px">Paste the access key you were emailed. It's stored only in this browser.</div>
    <button class="btn" id="connect">Add access key</button></div>`;
  document.getElementById('connect').onclick = () => { const v = prompt('Access key:'); if (v){ localStorage.setItem('ghpat', v.trim()); boot(); } };
}

// ---------- document rendering (math, footnotes, figures, cross-refs) ----------
function renderDoc(fragment){
  read.innerHTML = `<article id="doc">${fragment}</article>`;
  const doc = document.getElementById('doc');
  fixFootnotes(doc); runKatex(doc); wireFigures(doc); linkCrossRefs(doc); buildNav(); paintHighlights();
  if (review.cursor?.sec) document.getElementById(review.cursor.sec)?.scrollIntoView();
  syncDown();
}
const SIUNITX = { henry:'H',farad:'F',ohm:'\\Omega',siemens:'S',volt:'V',watt:'W',ampere:'A',kelvin:'K',hertz:'Hz',joule:'J',newton:'N',pascal:'Pa',metre:'m',meter:'m',gram:'g',mole:'mol',tesla:'T',weber:'Wb',coulomb:'C',radian:'rad',decibel:'dB',percent:'\\%',degree:'^\\circ',nano:'n',micro:'\\mu',milli:'m',pico:'p',femto:'f',kilo:'k',mega:'M',giga:'G',centi:'c',deci:'d' };
function expandUnits(tex){ return tex.replace(/\\degreeCelsius\b/g,'{}^\\circ\\mathrm{C}').replace(/\\([a-zA-Z]+)\b/g,(m,name)=>{ if(!(name in SIUNITX)) return m; const v=SIUNITX[name]; return /^[A-Za-z]+$/.test(v)?`\\mathrm{${v}}`:v; }); }
function runKatex(el){ if(!window.katex){ setTimeout(()=>runKatex(el),100); return; }
  el.querySelectorAll('span.math').forEach(s=>{ const tex=expandUnits(s.textContent.replace(/\\label\{[^}]*\}/g,'')); try{ window.katex.render(tex,s,{displayMode:s.classList.contains('display'),throwOnError:false}); }catch(e){} }); }
function fixFootnotes(doc){
  const fn=doc.querySelector('#footnotes'); if(fn&&!fn.querySelector('h2.fn-h')){ const h=document.createElement('h2'); h.className='fn-h'; h.textContent='Notes'; fn.insertBefore(h,fn.firstChild); }
  doc.querySelectorAll('a.footnote-ref').forEach(a=>{ a.onclick=e=>{ e.preventDefault(); e.stopPropagation(); document.getElementById('fn-tip')?.remove();
    const li=doc.querySelector(a.getAttribute('href')); if(!li) return; const html=li.cloneNode(true); html.querySelectorAll('a.footnote-back').forEach(b=>b.remove());
    const tip=document.createElement('div'); tip.id='fn-tip'; tip.className='fn-tip'; tip.innerHTML=`<div class="fn-tip-h">Note ${a.textContent.replace(/[^0-9]/g,'')}</div>`; tip.append(...html.childNodes); read.appendChild(tip);
    const rr=read.getBoundingClientRect(), ar=a.getBoundingClientRect(); tip.style.top=(ar.bottom-rr.top+read.scrollTop+6)+'px'; tip.style.left=Math.min(ar.left-rr.left,read.clientWidth-360)+'px';
    const close=ev=>{ if(!tip.contains(ev.target)){ tip.remove(); document.removeEventListener('mousedown',close); } }; setTimeout(()=>document.addEventListener('mousedown',close),0); }; });
  doc.querySelectorAll('a.footnote-back').forEach(a=>{ a.onclick=e=>{ e.preventDefault(); const t=doc.querySelector(a.getAttribute('href')); if(t){ t.scrollIntoView({behavior:'smooth',block:'center'}); t.classList.add('flash'); setTimeout(()=>t.classList.remove('flash'),1500); } }; });
}
function figureLabel(fig){ const cap=fig.querySelector('figcaption')?.textContent.trim()||''; const m=cap.match(/^(Figure|Fig\.?|Table)\s*[\d.]+/i); return { quote:cap.slice(0,150), label:(m?m[0]:''), id:fig.querySelector('img')?.getAttribute('src')?.slice(-40)||'' }; }
function wireFigures(doc){ doc.querySelectorAll('figure, img').forEach(el=>{ const fig=el.tagName==='FIGURE'?el:(el.closest('figure')||el); if(fig.dataset.figWired) return; fig.dataset.figWired='1'; fig.classList.add('fig-commentable');
  fig.addEventListener('click',e=>{ if(window.getSelection().toString().trim()) return; e.stopPropagation(); document.getElementById('pop')?.remove(); const info=figureLabel(fig);
    const rr=read.getBoundingClientRect(), fr=fig.getBoundingClientRect(); const rects=[{x:fr.x-rr.x,y:fr.y-rr.y+read.scrollTop,w:fr.width,h:fr.height}];
    pending={ quote: info.label?`${info.label}${info.quote?': '+info.quote:''}`:(info.quote||'Figure'), kind:'figure', figure:info.id, section:headingFor(fig), confirmed:true, rects:[] }; showPopover(pending,rects,'suggestion'); }); }); }
const chapterByNum = n => CHAPTERS.find(c=>c.n===n);
function sectionNumberMap(doc){ const n=chMeta(current).n; const map={}; let h2=0,h3=0; doc.querySelectorAll('h2, h3').forEach(h=>{ if(h.tagName==='H2'){h2++;h3=0;map[`${n}.${h2}`]=h;} else {h3++;map[`${n}.${h2}.${h3}`]=h;} }); return map; }
function figTableMaps(doc){ const fig={},tab={}; doc.querySelectorAll('figure').forEach(f=>{ const m=(f.querySelector(':scope > figcaption')?.textContent||'').match(/^\s*Figure\s+(\d+(?:\.\d+)*)\./); if(m) fig[m[1]]=f; });
  doc.querySelectorAll('table caption, figcaption').forEach(c=>{ const m=c.textContent.match(/^\s*Table\s+(\d+(?:\.\d+)*)\./); if(m) tab[m[1]]=c.closest('figure')||c.closest('table')||c; }); return {fig,tab}; }
function linkCrossRefs(doc){
  const secMap=sectionNumberMap(doc), ftMap=figTableMaps(doc), curN=chMeta(current).n;
  const re=/\b(Figures?|Fig\.?|Tables?|Sections?|Chapters?)\s+(\d+(?:\.\d+)*)/gi, reTest=/\b(Figures?|Fig\.?|Tables?|Sections?|Chapters?)\s+\d/i;
  const walker=document.createTreeWalker(doc,NodeFilter.SHOW_TEXT,{ acceptNode:t=>{ if(!t.nodeValue.trim()||!reTest.test(t.nodeValue)) return NodeFilter.FILTER_REJECT; const bad=t.parentElement?.closest('a, h1, h2, h3, figcaption, .math, .katex, #footnotes, script, style'); return bad?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT; } });
  const todo=[]; let node; while((node=walker.nextNode())) todo.push(node);
  todo.forEach(text=>{ const frag=document.createDocumentFragment(); let last=0; const s=text.nodeValue; re.lastIndex=0; let m;
    while((m=re.exec(s))){ const kw=m[1], num=m[2], lead=parseInt(num,10); const isFig=/^Fig/i.test(kw), isTab=/^Tab/i.test(kw), isChap=/^Chap/i.test(kw); let handler=null;
      if(isFig||isTab){ if(lead===curN){ const t=(isFig?ftMap.fig:ftMap.tab)[num]; if(t) handler=()=>scrollFlash(t); } }
      else if(!isChap){ if(lead===curN){ const h=secMap[num]; if(h) handler=()=>scrollFlash(h); } }
      if(last<m.index) frag.appendChild(document.createTextNode(s.slice(last,m.index)));
      if(handler){ const a=document.createElement('a'); a.className='xref'; a.textContent=m[0]; a.href='javascript:void 0'; a.onclick=e=>{ e.preventDefault(); e.stopPropagation(); handler(); }; frag.appendChild(a); }
      else frag.appendChild(document.createTextNode(m[0]));
      last=m.index+m[0].length; }
    if(last<s.length) frag.appendChild(document.createTextNode(s.slice(last))); text.parentNode.replaceChild(frag,text); });
}
function scrollFlash(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'),1500); }

// ---------- section navigator ----------
function buildNav(){
  const nav=document.getElementById('nav'); const hs=[...document.querySelectorAll('#doc h2, #doc h3')];
  nav.innerHTML=`<div class="lbl">SECTIONS</div>`;
  hs.forEach((h,i)=>{ if(!h.id) h.id='sec-'+i; const sub=h.tagName==='H3'; const cnt=review.comments.filter(c=>(c.anchor.section||'')===h.textContent.trim()).length;
    const a=document.createElement('a'); a.className=sub?'sub':''; a.dataset.sec=h.id;
    a.innerHTML=`<span class="nav-t" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.textContent}</span>${cnt?`<span class="count">${cnt}</span>`:''}`;
    a.onclick=()=>h.scrollIntoView({behavior:'smooth',block:'start'}); nav.appendChild(a); });
  read.onscroll=()=>{ let cur=null; hs.forEach(h=>{ if(h.getBoundingClientRect().top<140) cur=h.id; }); nav.querySelectorAll('a').forEach(a=>a.classList.toggle('active',a.dataset.sec===cur)); review.cursor={sec:cur}; clearTimeout(scrollT); scrollT=setTimeout(save,900); };
  read.onscroll();
}
let scrollT=null;
function headingFor(node){ let el=node.nodeType===1?node:node.parentElement; while(el&&el.id!=='doc'){ let p=el.previousElementSibling; while(p){ if(/^H[1-3]$/.test(p.tagName)) return p.textContent.trim(); p=p.previousElementSibling; } el=el.parentElement; } return ''; }

// ---------- select-to-comment + suggest-edit ----------
let pending=null;
read.addEventListener('mouseup',()=>{ if(document.getElementById('pop')) return; const sel=window.getSelection(); const text=sel.toString();
  if(!text.trim()||sel.rangeCount===0) return; const range=sel.getRangeAt(0); if(!range.startContainer.parentElement?.closest('#doc')) return;
  const rr=read.getBoundingClientRect(); const rects=[...range.getClientRects()].map(r=>({x:r.x-rr.x,y:r.y-rr.y+read.scrollTop,w:r.width,h:r.height}));
  pending=anchorFromSelection({text,page:null,rects}); pending.section=headingFor(range.startContainer); showPopover(pending,rects); });
function showPopover(anchor,rects,defaultTag='wording'){
  document.getElementById('pop')?.remove(); const top=Math.max(...rects.map(r=>r.y+r.h))+10; const isFig=anchor.kind==='figure';
  const pop=document.createElement('div'); pop.id='pop'; pop.className='popover'; pop.style.top=top+'px'; pop.style.left='50%'; pop.style.transform='translateX(-50%)';
  const modes=isFig?'':`<div class="pmodes" id="pmodes"><button data-m="note" class="on">Comment</button><button data-m="replace">Replace</button><button data-m="insert">Insert after</button><button data-m="delete">Delete</button></div>`;
  pop.innerHTML=`<div class="head"><i class="ti ti-${isFig?'photo':'link'}" style="margin-right:5px"></i>Commenting on ${isFig?'figure':''}<span class="loc"><i class="ti ti-circle-check-filled"></i>${anchor.section?'§ '+anchor.section.slice(0,38):(isFig?'this figure':'this passage')}</span></div>
    <div class="snip" id="psnip">"${escapeHtml(anchor.quote.slice(0,150))}"</div>${modes}
    <textarea id="crepl" class="crepl" style="display:none"></textarea><div class="tags" id="tags"></div>
    <textarea id="cbody" placeholder="Leave a comment…"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-primary" id="csave">Comment</button><button class="btn" id="ccancel">Cancel</button></div>`;
  read.appendChild(pop);
  let tag=defaultTag, mode='note'; const tr=pop.querySelector('#tags');
  TAGS.forEach(t=>{ const b=document.createElement('button'); b.textContent=t; const pick=()=>{ tag=t; [...tr.children].forEach(x=>{x.className='';x.style.background='transparent';x.style.color='var(--text-2)';x.style.borderColor='var(--border)';}); b.className='on'; b.style.background='var(--accent-bg)'; b.style.color='var(--accent)'; b.style.borderColor='transparent'; }; b.onclick=pick; tr.appendChild(b); if(t===defaultTag) pick(); });
  const repl=pop.querySelector('#crepl'), body=pop.querySelector('#cbody'), saveBtn=pop.querySelector('#csave');
  const setMode=m=>{ mode=m; pop.querySelectorAll('#pmodes button').forEach(b=>b.classList.toggle('on',b.dataset.m===m)); const nr=m==='replace'||m==='insert'; repl.style.display=nr?'block':'none';
    repl.placeholder=m==='replace'?'Exact replacement text…':'Exact text to insert after the selection…'; body.placeholder=m==='note'?'Leave a comment…':'Optional note for this edit…';
    saveBtn.textContent=m==='note'?'Comment':m==='delete'?'Suggest deletion':m==='insert'?'Suggest insertion':'Suggest replacement'; saveBtn.className='btn '+(m==='delete'?'btn-danger':m==='note'?'btn-primary':'btn-suggest');
    pop.querySelector('#psnip').style.textDecoration=m==='delete'?'line-through':'none'; (nr?repl:body).focus(); };
  pop.querySelectorAll('#pmodes button').forEach(b=>b.onclick=()=>setMode(b.dataset.m)); body.focus();
  pop.querySelector('#ccancel').onclick=()=>{ pop.remove(); window.getSelection().removeAllRanges(); };
  saveBtn.onclick=()=>{ let edit=null;
    if(mode==='replace') edit={op:'replace',find:anchor.quote,replacement:repl.value};
    else if(mode==='insert') edit={op:'insert',find:anchor.quote,position:'after',replacement:repl.value};
    else if(mode==='delete') edit={op:'delete',find:anchor.quote,replacement:''};
    if(edit&&mode!=='delete'&&!repl.value.trim()){ flash('Enter the '+(mode==='insert'?'text to insert':'replacement text')+'.'); return; }
    review=addComment(review,{ anchor:pending, kind:edit?'suggestion':pending.kind, tag:edit?'edit':tag, body:body.value, edit, author:ADVISOR.id });
    save(); syncUpSoon(); renderComments(); buildNav(); paintHighlights(); pop.remove(); window.getSelection().removeAllRanges(); };
}

// ---------- comments rail ----------
let editingId=null, activeId=null;
function suggHtml(c){ if(!c.edit) return ''; const e=c.edit, find=escapeHtml((e.find||'').slice(0,140)), repl=escapeHtml((e.replacement||'').slice(0,240));
  const label=e.op==='replace'?'Replace':e.op==='insert'?'Insert after':'Delete'; const inner=e.op==='delete'?`<del>${find}</del>`:e.op==='insert'?`<span style="color:var(--text-3)">…${find}</span> <ins>${repl}</ins>`:`<del>${find}</del> <ins>${repl}</ins>`;
  return `<div class="sugg"><div class="op"><i class="ti ti-pencil"></i>Suggested ${label}</div>${inner}</div>`; }
function renderComments(){
  const pane=document.getElementById('comments'); const open=review.comments.filter(c=>c.status==='open').length;
  pane.innerHTML=`<div class="lbl">MY COMMENTS<span style="margin-left:auto">${review.comments.length} · ${open} open</span></div>`;
  if(!review.comments.length){ pane.innerHTML+=`<div style="font-size:12.5px;color:var(--text-3);padding:8px 2px">Select text or click a figure to leave a comment or suggest an edit.</div>`; return; }
  review.comments.forEach(c=>{ const card=document.createElement('div'); card.className='ccard'; card.dataset.id=c.id;
    if(editingId===c.id){ card.appendChild(editCard(c)); pane.appendChild(card); return; }
    const st=c.status; const resolved=st==='resolved'; const submitted=st==='submitted';
    const stBadge = resolved ? '<span class="status" style="color:var(--text-3)">resolved</span>'
      : submitted ? '<span class="status" style="background:var(--success-bg);color:var(--success)">submitted</span>' : '<span class="status" style="display:none"></span>';
    card.innerHTML=`<div class="row"><span class="chip" style="background:var(--accent-bg);color:var(--accent)">${c.kind==='figure'?'<i class="ti ti-photo" style="font-size:11px;margin-right:2px"></i>':c.kind==='suggestion'?'<i class="ti ti-pencil" style="font-size:11px;margin-right:2px"></i>':''}${c.tag}</span>
        <span class="cactions" style="margin-left:auto;display:none;gap:1px">
          <button class="icbtn cact" data-act="resolve" title="${resolved?'Reopen':'Resolve'}" style="width:25px;height:25px;font-size:14px"><i class="ti ti-${resolved?'rotate-clockwise':'check'}"></i></button>
          <button class="icbtn cact" data-act="edit" title="Edit" style="width:25px;height:25px;font-size:14px"><i class="ti ti-pencil"></i></button>
          <button class="icbtn cact" data-act="del" title="Delete" style="width:25px;height:25px;font-size:14px"><i class="ti ti-trash"></i></button></span>
        ${stBadge}</div>
      <div class="snip">"${escapeHtml((c.anchor.quote||'').slice(0,52))}"</div><div class="body" style="${resolved?'opacity:.5;text-decoration:line-through':''}">${escapeHtml(c.body)}</div>${suggHtml(c)}`;
    if(c.id===activeId) card.classList.add('active');
    card.onmouseenter=()=>{ card.querySelector('.cactions').style.display='flex'; const s=card.querySelector('.status'); if(s&&s.textContent) s.style.visibility='hidden'; document.querySelector(`#doc .cmark[data-id="${c.id}"]`)?.classList.add('cmark-hot'); };
    card.onmouseleave=()=>{ card.querySelector('.cactions').style.display='none'; const s=card.querySelector('.status'); if(s) s.style.visibility=''; document.querySelector(`#doc .cmark[data-id="${c.id}"]`)?.classList.remove('cmark-hot'); };
    card.querySelector('.snip').onclick=()=>jumpTo(c); card.querySelector('.body').onclick=()=>jumpTo(c);
    card.querySelectorAll('.cact').forEach(b=>b.onclick=e=>{ e.stopPropagation(); commentAction(c.id,b.dataset.act); });
    pane.appendChild(card); });
}
function commentAction(id,act){ const c=review.comments.find(x=>x.id===id); if(!c) return;
  if(act==='edit'){ editingId=id; renderComments(); return; }
  if(act==='del'){ if(!confirm('Delete this comment?')) return; review=deleteComment(review,id); }
  else if(act==='resolve'){ review=updateComment(review,id,{status: c.status==='resolved'?'open':'resolved'}); }
  save(); syncUpSoon(); renderComments(); buildNav(); paintHighlights(); }
function editCard(c){ const w=document.createElement('div');
  w.innerHTML=`<textarea id="ebody" style="width:100%;border:.5px solid var(--accent);border-radius:6px;padding:7px;font:inherit;background:var(--bg);color:var(--text);min-height:54px;outline:none">${escapeHtml(c.body)}</textarea>
    <div style="display:flex;gap:6px;margin-top:8px"><button class="btn btn-primary" id="esave" style="padding:5px 13px;font-size:12px">Save</button><button class="btn" id="ecancel" style="padding:5px 13px;font-size:12px">Cancel</button></div>`;
  w.querySelector('#ecancel').onclick=()=>{ editingId=null; renderComments(); };
  w.querySelector('#esave').onclick=()=>{ review=updateComment(review,c.id,{body:w.querySelector('#ebody').value}); editingId=null; save(); syncUpSoon(); renderComments(); }; return w; }
function jumpTo(c){ activeId=c.id; const mark=document.querySelector(`#doc .cmark[data-id="${c.id}"], #doc figure[data-cid="${c.id}"]`);
  const q=(c.anchor.quote||'').replace(/\s+/g,' ').trim().slice(0,40); const el=mark||[...document.querySelectorAll('#doc p, #doc li, #doc figure, #doc figcaption, #doc h2, #doc h3')].find(p=>p.textContent.replace(/\s+/g,' ').includes(q));
  if(el){ el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'),1500); } }
function activateComment(id){ activeId=id; renderComments(); document.querySelector(`#comments .ccard[data-id="${id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'}); }
function paintHighlights(){ const doc=document.getElementById('doc'); if(!doc) return;
  doc.querySelectorAll('mark.cmark').forEach(m=>{ const p=m.parentNode; m.replaceWith(...m.childNodes); p.normalize(); });
  doc.querySelectorAll('figure[data-cid]').forEach(f=>{ f.classList.remove('cmark-fig'); delete f.dataset.cid; });
  const blocks=[...doc.querySelectorAll('p, li, figcaption')];
  review.comments.forEach(c=>{ if(c.kind==='figure'){ const q=(c.anchor.quote||'').replace(/^[^:]*:\s*/,'').replace(/\s+/g,' ').trim().slice(0,30); const fig=[...doc.querySelectorAll('figure')].find(f=>f.textContent.replace(/\s+/g,' ').includes(q)); if(fig){ fig.classList.add('cmark-fig'); fig.dataset.cid=c.id; fig.style.setProperty('--mk','var(--accent)'); } return; }
    const q=(c.anchor.quote||'').replace(/\s+/g,' ').trim(); if(q.length<4) return; const needle=q.slice(0,50); const el=blocks.find(e=>e.textContent.replace(/\s+/g,' ').includes(needle.slice(0,40))); if(!el) return; wrapInNode(el,needle,c); }); }
function wrapInNode(el,needle,c){ const tw=document.createTreeWalker(el,NodeFilter.SHOW_TEXT); let node, probe=needle.slice(0,30);
  while((node=tw.nextNode())){ const idx=node.nodeValue.indexOf(probe); if(idx>=0){ const r=document.createRange(); r.setStart(node,idx); r.setEnd(node,Math.min(node.nodeValue.length,idx+needle.length));
    const mk=document.createElement('mark'); mk.className='cmark'; mk.dataset.id=c.id; mk.dataset.tag='wording'; if(c.edit) mk.dataset.sugg=c.edit.op; try{ r.surroundContents(mk); mk.onclick=e=>{ e.stopPropagation(); activateComment(c.id); }; return true; }catch(e){ return false; } } } return false; }

// ---------- top bar / home / search ----------
function renderTopbar(){ const m=chMeta(current);
  document.getElementById('topbar').innerHTML=`
    <button class="icbtn" id="btn-home" title="All chapters"><i class="ti ti-layout-grid"></i></button>
    <button class="chsel" id="chsel"><i class="ti ti-book-2"></i><span>Chapter ${m.n} · ${shortTitle(m.title)}</span><i class="ti ti-chevron-down" style="font-size:15px;color:var(--text-3)"></i></button>
    <div class="search"><i class="ti ti-search"></i><input id="search" placeholder="Search chapter"></div>
    <div style="margin-left:auto;display:flex;align-items:center;gap:3px">
      <button class="icbtn" id="btn-theme" title="Theme"><i class="ti ti-moon"></i></button>
      <button class="btn btn-primary" id="btn-submit"><i class="ti ti-send"></i>Submit comments</button>
      <button class="icbtn" id="btn-key" title="Access key"><i class="ti ti-key"></i></button>
    </div>`;
  document.getElementById('btn-home').onclick=enterHome;
  document.getElementById('chsel').onclick=openChapterMenu;
  document.getElementById('btn-theme').onclick=()=>{ document.documentElement.classList.toggle('dark'); localStorage.setItem('theme',document.documentElement.classList.contains('dark')?'dark':'light'); };
  document.getElementById('btn-submit').onclick=submitComments;
  document.getElementById('btn-key').onclick=()=>{ const v=prompt('Access key:',tok()||''); if(v!==null){ if(v.trim()) localStorage.setItem('ghpat',v.trim()); else localStorage.removeItem('ghpat'); boot(); } };
  const si=document.getElementById('search'); si.addEventListener('keydown',e=>{ if(e.key==='Enter') runSearch(si.value); if(e.key==='Escape'){ si.value=''; clearSearch(); } });
}
function openChapterMenu(){ const old=document.getElementById('chmenu'); if(old){ old.remove(); return; } const menu=document.createElement('div'); menu.id='chmenu';
  menu.style.cssText='position:absolute;top:50px;left:16px;z-index:40;background:var(--bg);border:.5px solid var(--border-2);border-radius:var(--r-md);box-shadow:0 10px 34px rgba(0,0,0,.16);padding:6px;min-width:330px';
  const list=CHAPTERS.filter(c=>released.includes(c.id));
  menu.innerHTML=list.map(c=>`<div data-ch="${c.id}" style="display:flex;gap:8px;padding:8px 10px;border-radius:7px;cursor:pointer;font-size:13px${c.id===current?';background:var(--accent-bg);color:var(--accent)':''}"><span style="color:var(--text-3);min-width:20px">${c.n}</span>${shortTitle(c.title)}</div>`).join('')||`<div style="padding:10px;color:var(--text-3);font-size:12.5px">No chapters released yet.</div>`;
  menu.querySelectorAll('[data-ch]').forEach(d=>{ d.onclick=()=>{ menu.remove(); loadChapter(d.dataset.ch); }; });
  document.body.appendChild(menu);
  setTimeout(()=>document.addEventListener('click',function h(e){ if(!menu.contains(e.target)&&e.target.id!=='chsel'){ menu.remove(); document.removeEventListener('click',h); } }),0);
}
function enterHome(){
  document.getElementById('nav').style.display='none'; document.getElementById('comments').style.display='none';
  document.getElementById('topbar').innerHTML=`<strong style="font-size:16px;font-weight:600">Dissertation review · ${escapeHtml(ADVISOR.name)}</strong>
     <button class="icbtn" id="btn-theme" style="margin-left:auto"><i class="ti ti-moon"></i></button>
     <button class="icbtn" id="btn-key" title="Access key"><i class="ti ti-key"></i></button>`;
  document.getElementById('btn-theme').onclick=()=>{ document.documentElement.classList.toggle('dark'); localStorage.setItem('theme',document.documentElement.classList.contains('dark')?'dark':'light'); };
  const askKey=()=>{ const v=prompt('Access key:',tok()||''); if(v!==null){ if(v.trim()) localStorage.setItem('ghpat',v.trim()); else localStorage.removeItem('ghpat'); boot(); } };
  document.getElementById('btn-key').onclick=askKey;
  // first-run: no access key yet — prompt for it before anything else
  if(!tok()){
    read.innerHTML=`<div class="empty"><i class="ti ti-lock" style="font-size:24px;color:var(--text-3)"></i>
      <div style="font-size:17px;font-weight:500;margin:10px 0 6px">Welcome, ${escapeHtml(ADVISOR.name)}</div>
      <div style="font-size:13px;line-height:1.6;margin-bottom:16px">Enter the access key you were emailed to open the chapters shared with you for review. It's stored only in this browser.</div>
      <button class="btn btn-primary" id="connect">Enter access key</button></div>`;
    read.querySelector('#connect').onclick=askKey; return;
  }
  const list=CHAPTERS.filter(c=>released.includes(c.id));
  const cards=list.map(c=>{ const r=JSON.parse(localStorage.getItem(localKey(c.id))||'null'); const n=r?.comments?.length||0;
    return `<div class="chcard" data-ch="${c.id}" style="border:.5px solid var(--border);border-radius:var(--r-lg);padding:14px 15px;cursor:pointer">
      <div style="font-size:11.5px;color:var(--text-3)">Chapter ${c.n}</div>
      <div style="font-size:14px;font-weight:500;line-height:1.35;margin:3px 0 11px;min-height:38px">${shortTitle(c.title)}</div>
      <div style="font-size:11px;color:var(--text-2)">${n?`${n} comment${n>1?'s':''}`:'open to review'}</div></div>`; }).join('');
  read.innerHTML=`<div style="max-width:900px;margin:0 auto;padding:28px 24px 90px">
      <div style="font-size:13px;color:var(--text-2);margin-bottom:20px">Welcome, ${escapeHtml(ADVISOR.name)}. The chapters released for your review are below. Open one to read it and leave comments or suggested edits; use <b>Submit comments</b> when you're done.</div>
      <div style="font-size:11px;letter-spacing:.06em;color:var(--text-3);margin-bottom:13px">CHAPTERS FOR REVIEW</div>
      ${list.length?`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:14px">${cards}</div>`:`<div class="empty">No chapters have been released for your review yet. You'll see them here once they're shared.</div>`}</div>`;
  read.querySelectorAll('[data-ch]').forEach(el=>el.onclick=()=>loadChapter(el.dataset.ch));
}
async function submitComments(){ const t=tok(); if(!t){ flash('Add your access key first.'); return; } const open=review.comments.filter(c=>c.status==='open'); if(!open.length){ flash('No new comments to submit.'); return; }
  flash('Submitting…'); try{ open.forEach(c=>{ review=updateComment(review,c.id,{status:'submitted'}); }); save(); await syncUp(); renderComments(); flash(`Submitted ${open.length} comment${open.length>1?'s':''}. Thank you!`); }catch(e){ flash('Submit failed — try again.'); } }
function runSearch(q){ clearSearch(); if(!q.trim()) return; const re=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'); let first=null;
  document.querySelectorAll('#doc p').forEach(p=>{ if(re.test(p.textContent)){ p.innerHTML=p.innerHTML.replace(re,m=>`<mark style="background:var(--warn-bg)">${m}</mark>`); if(!first) first=p; } }); if(first) first.scrollIntoView({behavior:'smooth',block:'center'}); }
function clearSearch(){ document.querySelectorAll('#doc mark:not(.cmark)').forEach(m=>m.replaceWith(...m.childNodes)); }
function flash(msg){ const t=document.createElement('div'); t.textContent=msg; t.style.cssText='position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:9px 16px;border-radius:20px;font-size:13px;z-index:60;box-shadow:0 6px 20px rgba(0,0,0,.2)'; document.body.appendChild(t); setTimeout(()=>t.remove(),2600); }

// ---------- boot ----------
async function boot(){ await loadRelease(); enterHome(); }
window.addEventListener('keydown',e=>{ const pop=document.getElementById('pop'); if(pop){ if(e.key==='Escape') pop.querySelector('#ccancel').click(); return; }
  if(/INPUT|TEXTAREA/.test(document.activeElement?.tagName||'')) return; if(e.key==='/'){ e.preventDefault(); document.getElementById('search')?.focus(); } });
boot();
