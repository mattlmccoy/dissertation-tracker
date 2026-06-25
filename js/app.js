import * as pdfjs from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
import { anchorFromSelection } from './anchor.js';
import { newReview, addComment } from './model.js';

const SCALE = 1.4;
const CHAPTERS = { ch_modeling: 'Chapter 4 · Computational Modeling' };
const readPane = document.getElementById('read-pane');
readPane.style.cssText = 'flex:1;min-width:0;position:relative;overflow:auto;height:calc(100vh - 49px)';

let mode = 'html';        // 'html' | 'pdf'
let currentChapter = 'ch_modeling';

document.getElementById('topbar').innerHTML =
  `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:.5px solid var(--border);background:var(--bg-2)">
     <strong style="font-weight:500">Dissertation Reviewer</strong>
     <span id="ch-label" style="color:var(--text-2);font-size:13px">${CHAPTERS[currentChapter]}</span>
     <span style="margin-left:auto;display:inline-flex;gap:6px">
       <button id="mode-html" title="Reflowed reading">Reading</button>
       <button id="mode-pdf" title="Compiled PDF (true layout)">PDF</button>
       <label style="font-size:12px;cursor:pointer;border:.5px solid var(--border-2);border-radius:8px;padding:6px 11px">Open<input type="file" id="pdf-file" accept=".pdf,.html" class="hidden"></label>
     </span>
   </div>`;

let review = JSON.parse(localStorage.getItem('review:current') || 'null') || newReview(currentChapter, '');
const save = () => localStorage.setItem('review:current', JSON.stringify(review));

function runKatex(el){
  if (!window.katex){ setTimeout(() => runKatex(el), 120); return; }
  el.querySelectorAll('span.math').forEach(s => {
    try { window.katex.render(s.textContent, s, { displayMode: s.classList.contains('display'), throwOnError:false }); }
    catch(e){ /* leave raw TeX on failure */ }
  });
}

// ---------- HTML reading surface (primary) ----------
export function renderHtml(fragment){
  mode = 'html';
  readPane.innerHTML = `<article id="doc">${fragment}</article>`;
  runKatex(document.getElementById('doc'));
}

// ---------- compiled-PDF toggle ----------
export async function renderPdf(arrayBuf){
  mode = 'pdf';
  readPane.innerHTML = '';
  const doc = await pdfjs.getDocument({ data: arrayBuf }).promise;
  window.__pdf = doc;
  for (let n = 1; n <= doc.numPages; n++){
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: SCALE });
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page'; wrap.dataset.page = n;
    wrap.style.cssText = `position:relative;margin:16px auto;width:${vp.width}px`;
    wrap.style.setProperty('--scale-factor', SCALE);
    const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.cssText = 'display:block;border:.5px solid var(--border);background:#fff;border-radius:4px';
    wrap.appendChild(canvas); readPane.appendChild(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const tl = document.createElement('div'); tl.className = 'textLayer'; wrap.appendChild(tl);
    const tc = await page.getTextContent();
    await new pdfjs.TextLayer({ textContentSource: tc, container: tl, viewport: vp }).render();
  }
}

// ---------- select-to-comment (mode-agnostic) ----------
let pendingAnchor = null;
readPane.addEventListener('mouseup', () => {
  const sel = window.getSelection();
  const text = sel.toString();
  if (!text.trim() || sel.rangeCount === 0) return;
  if (document.getElementById('anchor-pop')) return; // don't re-trigger while editing
  const range = sel.getRangeAt(0);
  const pageEl = range.startContainer.parentElement?.closest('.pdf-page');
  const rp = readPane.getBoundingClientRect();
  const rects = [...range.getClientRects()].map(r => ({ x: r.x - rp.x, y: r.y - rp.y + readPane.scrollTop, w: r.width, h: r.height }));
  const heading = headingFor(range.startContainer);
  pendingAnchor = anchorFromSelection({ text, page: pageEl ? +pageEl.dataset.page : null, rects });
  pendingAnchor.section = heading;
  showAnchorPopover(pendingAnchor, rects);
});

function headingFor(node){
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && el.id !== 'doc'){
    let p = el.previousElementSibling;
    while (p){ if (/^H[1-3]$/.test(p.tagName)) return p.textContent.trim(); p = p.previousElementSibling; }
    el = el.parentElement;
  }
  return '';
}

function showAnchorPopover(anchor, rects){
  document.getElementById('anchor-pop')?.remove();
  const top = Math.max(...rects.map(r => r.y + r.h)) + 8;
  const loc = anchor.section ? `§ ${anchor.section.slice(0,40)}` : 'this passage';
  const pop = document.createElement('div'); pop.id = 'anchor-pop';
  pop.style.cssText = `position:absolute;left:50%;transform:translateX(-50%);top:${top}px;width:min(640px,92%);background:var(--bg);border:.5px solid var(--info);border-radius:var(--r-md);padding:10px 12px;z-index:5;box-shadow:0 4px 18px rgba(0,0,0,.12)`;
  pop.innerHTML =
    `<div style="font-size:11px;color:var(--text-2);display:flex">Commenting on
       <span style="margin-left:auto;color:var(--success)">⛓ ${loc}</span></div>
     <div style="font-style:italic;font-size:12px;color:var(--text-3);border-left:2px solid var(--border-2);padding-left:8px;margin:6px 0">"${anchor.quote.slice(0,140)}"</div>
     <div id="tagrow" style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap"></div>
     <textarea id="cbody" rows="2" placeholder="comment…" style="width:100%;border:.5px solid var(--border);border-radius:6px;padding:6px;font:inherit;background:var(--bg);color:var(--text)"></textarea>
     <div style="display:flex;gap:8px;margin-top:8px"><button id="csave">Comment</button><button id="ccancel">Cancel</button></div>`;
  readPane.appendChild(pop);
  const tags = ['claim','wording','figure','citation','question']; let tag = 'claim';
  const tr = pop.querySelector('#tagrow');
  tags.forEach(t => { const b = document.createElement('button'); b.textContent = t;
    b.style.cssText = 'font-size:11px;padding:2px 9px;border-radius:10px;border:.5px solid var(--border)';
    const pick = () => { tag = t; [...tr.children].forEach(x => x.style.background = 'transparent'); b.style.background = 'var(--bg-3)'; };
    b.onclick = pick; tr.appendChild(b); if (t === 'claim') pick(); });
  pop.querySelector('#ccancel').onclick = () => pop.remove();
  pop.querySelector('#csave').onclick = () => {
    window.dispatchEvent(new CustomEvent('comment:add', { detail: { anchor: pendingAnchor, tag, body: pop.querySelector('#cbody').value } }));
    pop.remove(); window.getSelection().removeAllRanges();
  };
}

// ---------- comments rail ----------
const tagColors = { claim:['--claim-bg','--claim'], wording:['--wording-bg','--wording'],
  figure:['--figure-bg','--figure'], citation:['--citation-bg','--citation'], question:['--question-bg','--question'], other:['--wording-bg','--wording'] };
function renderComments(){
  const pane = document.getElementById('comments-pane');
  pane.style.cssText = 'width:230px;flex-shrink:0;background:var(--bg-2);padding:10px;border-left:.5px solid var(--border);overflow:auto;height:calc(100vh - 49px)';
  const open = review.comments.filter(c => c.status === 'open').length;
  pane.innerHTML = `<div style="font-size:11px;color:var(--text-3);margin-bottom:8px;display:flex">COMMENTS<span style="margin-left:auto">${review.comments.length} · ${open} open</span></div>`;
  review.comments.forEach(c => {
    const [bg,fg] = tagColors[c.tag] || tagColors.other;
    const stClr = c.status === 'staged' ? '--info' : c.status === 'merged' ? '--success' : '--text-2';
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg);border:.5px solid var(--border);border-radius:var(--r-md);padding:9px 10px;margin-bottom:8px;cursor:pointer';
    card.innerHTML = `<div style="display:flex;gap:6px;margin-bottom:6px">
        <span style="font-size:10px;font-weight:500;padding:1px 8px;border-radius:10px;background:var(${bg});color:var(${fg})">${c.tag}</span>
        <span style="margin-left:auto;font-size:10px;padding:1px 8px;border-radius:10px;color:var(${stClr})">${c.status}</span></div>
      <div style="font-size:11px;font-style:italic;color:var(--text-3);margin-bottom:5px">"${(c.anchor.quote || '').slice(0,46)}"</div>
      <div style="font-size:13px;line-height:1.5">${c.body || ''}</div>`;
    card.onclick = () => jumpToAnchor(c);
    pane.appendChild(card);
  });
}
window.addEventListener('comment:add', e => { review = addComment(review, e.detail); save(); renderComments(); });

function jumpToAnchor(c){
  if (mode === 'pdf'){
    const pageEl = document.querySelector(`.pdf-page[data-page="${c.page}"]`);
    if (!pageEl) return; pageEl.scrollIntoView({ behavior:'smooth', block:'center' });
    (c.anchor.rects || []).forEach(r => { const m = document.createElement('div');
      m.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:var(--warn-bg);opacity:.55;pointer-events:none;border-radius:2px`;
      pageEl.appendChild(m); setTimeout(() => m.remove(), 1600); });
    return;
  }
  const q = (c.anchor.quote || '').replace(/\s+/g,' ').trim().slice(0,40);
  const ps = [...document.querySelectorAll('#doc p, #doc li, #doc figcaption')];
  const hit = ps.find(p => p.textContent.replace(/\s+/g,' ').includes(q));
  if (hit){ hit.scrollIntoView({ behavior:'smooth', block:'center' });
    hit.classList.add('flash-html'); setTimeout(() => hit.classList.remove('flash-html'), 1600); }
}

// ---------- bootstrap ----------
renderComments();
document.getElementById('mode-html').onclick = () => loadChapterHtml(currentChapter);
document.getElementById('mode-pdf').onclick = () => document.getElementById('pdf-file').click();
document.getElementById('pdf-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.name.endsWith('.html')) renderHtml(await f.text());
  else renderPdf(await f.arrayBuffer());
});

async function loadChapterHtml(ch){
  try {
    const r = await fetch(`./chapters/${ch}.html`);
    if (!r.ok) throw new Error(r.status);
    renderHtml(await r.text());
  } catch (e){
    readPane.innerHTML = `<div style="max-width:640px;margin:60px auto;color:var(--text-2)">Could not load <code>chapters/${ch}.html</code> (${e}). Use <b>Open</b> to pick a generated chapter HTML or PDF.</div>`;
  }
}
loadChapterHtml(currentChapter);
