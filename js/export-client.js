// export-client.js — in-browser export (Word .docx, Markdown, print-PDF) from the already-rendered
// reader DOM. Matches the executor's comment quality: native Word comments + tracked-change
// suggestions, attributed. Math is embedded as images; figures reuse the embedded data-URIs.
// No toolchain, no executor — works directly from the tool.

const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml = s => (s == null ? '' : String(s)).replace(/[&<>"]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));
const norm = s => (s || '').replace(/\s+/g, ' ').trim();

// ---------- dynamic deps (only loaded when exporting) ----------
let _JSZip, _h2c;
async function deps(needCanvas){
  if (!_JSZip) _JSZip = (await import('https://esm.sh/jszip@3.10.1')).default;
  if (needCanvas && !_h2c) _h2c = (await import('https://esm.sh/html2canvas@1.4.1')).default;
}

// ---------- inline + block model from the rendered DOM ----------
// run: {t, b, i, sup, sub} | {img:{data,w,h}}
async function inlineRuns(node, ctx, images){
  const runs = [];
  for (const ch of node.childNodes){
    if (ch.nodeType === 3){ if (ch.textContent) runs.push({ t: ch.textContent, ...ctx }); continue; }
    if (ch.nodeType !== 1) continue;
    const tag = ch.tagName.toLowerCase();
    if (ch.classList?.contains('katex') || tag === 'math' || ch.querySelector?.('.katex')){
      const img = await snapMath(ch, images); if (img) runs.push({ img }); continue;
    }
    if (tag === 'br'){ runs.push({ t: '\n', ...ctx }); continue; }
    const next = { ...ctx };
    if (tag === 'strong' || tag === 'b') next.b = true;
    if (tag === 'em' || tag === 'i') next.i = true;
    if (tag === 'sup') next.sup = true;
    if (tag === 'sub') next.sub = true;
    runs.push(...await inlineRuns(ch, next, images));
  }
  return runs;
}
async function snapMath(el, images){
  try { await deps(true);
    const canvas = await _h2c(el, { backgroundColor: null, scale: 2, logging: false });
    const data = canvas.toDataURL('image/png').split(',')[1];
    const id = images.length + 1; images.push({ id, data });
    return { id, w: Math.round(canvas.width / 2 * 9525), h: Math.round(canvas.height / 2 * 9525) };   // EMUs (96dpi→EMU = *9525)
  } catch(e){ return null; }
}
function imgFromDataUri(src, images){
  const m = /^data:image\/(png|jpeg|jpg);base64,(.+)$/i.exec(src || '');
  if (!m) return null;
  const id = images.length + 1; images.push({ id, data: m[2], ext: m[1] === 'jpg' ? 'jpeg' : m[1] });
  return { id };
}

// ---------- docx run/paragraph XML ----------
function runXml(r, relOffset){
  if (r.img){
    const rid = `rIdImg${r.img.id}`;
    const w = r.img.w || 2743200, h = r.img.h || 2743200;   // default ~3in if unknown
    return `<w:r><w:rPr/><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + `<wp:extent cx="${w}" cy="${h}"/><wp:docPr id="${r.img.id}" name="img${r.img.id}"/>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${r.img.id}" name="img${r.img.id}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rid}" xmlns:r="${RNS}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
      + `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
  const rpr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') + (r.sup ? '<w:vertAlign w:val="superscript"/>' : '') + (r.sub ? '<w:vertAlign w:val="subscript"/>' : '');
  const sp = (r.t !== norm(r.t) || /\s$|^\s/.test(r.t)) ? ' xml:space="preserve"' : '';
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t${sp}>${xml(r.t)}</w:t></w:r>`;
}
const paraXml = (runs, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs.map(r => runXml(r)).join('')}</w:p>`;

// split a run array at a character offset; returns new array (does not mutate)
function splitAt(runs, off){
  const out = []; let acc = 0;
  for (const r of runs){
    if (r.img || acc >= off || acc + (r.t?.length || 0) <= off){ out.push(r); acc += (r.t?.length || 0); continue; }
    const cut = off - acc; out.push({ ...r, t: r.t.slice(0, cut) }, { ...r, t: r.t.slice(cut) }); acc += r.t.length;
  }
  return out;
}
const runText = runs => runs.map(r => r.t || '').join('');
function locate(runs, quote){            // [startIdx,endIdx) over the run array, by normalized text
  const raw = runText(runs); if (!raw) return null;
  const map = [], chars = [];
  let prevWs = false;
  for (let i = 0; i < raw.length; i++){ const c = raw[i];
    if (/\s/.test(c)){ if (prevWs) continue; chars.push(' '); map.push(i); prevWs = true; }
    else { chars.push(c); map.push(i); prevWs = false; } }
  const q = norm(quote); if (!q) return null;
  const pos = chars.join('').indexOf(q); if (pos < 0) return null;
  return [map[pos], map[pos + q.length - 1] + 1];
}
// insert comment-range markers (and optional tracked change) around [s,e) by char offset
function annotateRuns(runs, s, e, cid, edit, author, date){
  let rs = splitAt(splitAt(runs, s), e);   // ensure boundaries fall between runs
  // recompute index of boundary by walking text length
  const idxAt = off => { let acc = 0, i = 0; for (; i < rs.length; i++){ if (acc >= off) break; acc += (rs[i].t?.length || 0) + (rs[i].img ? 0 : 0); } return i; };
  const si = idxAt(s), ei = idxAt(e);
  const out = rs.slice(0, si).concat([{ crs: cid }]);
  let mid = rs.slice(si, ei);
  // tracked change: wrap the matched span as deletion + add insertion
  if (edit && edit.op && (edit.replacement != null || edit.op === 'delete')){
    const ins = (edit.op === 'replace' || edit.op === 'insert') && edit.replacement ? [{ insRun: { text: edit.replacement, author, date } }] : [];
    if (edit.op === 'insert') mid = mid.concat(ins);
    else mid = [{ delStart: { id: cid, author, date } }].concat(mid, [{ delEnd: true }]).concat(ins);
  }
  return out.concat(mid, [{ cre: cid }, { cref: cid }], rs.slice(ei));
}
function serializeRuns(runs){
  let s = '', inDel = false;
  for (const r of runs){
    if (r.crs != null){ s += `<w:commentRangeStart w:id="${r.crs}"/>`; continue; }
    if (r.cre != null){ s += `<w:commentRangeEnd w:id="${r.cre}"/>`; continue; }
    if (r.cref != null){ s += `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${r.cref}"/></w:r>`; continue; }
    if (r.delStart){ s += `<w:del w:id="${r.delStart.id}" w:author="${xml(r.delStart.author)}"${r.delStart.date ? ` w:date="${xml(r.delStart.date)}"` : ''}>`; inDel = true; continue; }
    if (r.delEnd){ s += '</w:del>'; inDel = false; continue; }
    if (r.insRun){ s += `<w:ins w:id="${90000 + (r.insRun.id || 0)}" w:author="${xml(r.insRun.author)}"${r.insRun.date ? ` w:date="${xml(r.insRun.date)}"` : ''}><w:r><w:t xml:space="preserve">${xml(r.insRun.text)}</w:t></w:r></w:ins>`; continue; }
    if (r.img){ s += runXml(r); continue; }
    if (inDel){ const sp = /\s$|^\s/.test(r.t) ? ' xml:space="preserve"' : ''; const rpr = (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : ''); s += `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:delText${sp}>${xml(r.t)}</w:delText></w:r>`; }
    else s += runXml(r);
  }
  return s;
}

// ---------- walk the rendered chapter into paragraphs ----------
async function walkBlocks(docEl, images){
  const blocks = [];   // {style, runs, plain}
  const push = (runs, style) => blocks.push({ style, runs, plain: norm(runText(runs)) });
  async function block(el){
    const tag = el.tagName?.toLowerCase();
    if (!tag) return;
    if (/^h[1-6]$/.test(tag)){ const lvl = Math.min(3, +tag[1]); push(await inlineRuns(el, {}, images), `Heading${lvl}`); return; }
    if (tag === 'p'){ const r = await inlineRuns(el, {}, images); if (r.length) push(r); return; }
    if (tag === 'figure'){
      const img = el.querySelector('img'); if (img){ const i = imgFromDataUri(img.src, images); if (i) push([{ img: { ...i, w: 4572000, h: undefined } }], 'Figure'); }
      const cap = el.querySelector('figcaption'); if (cap) push(await inlineRuns(cap, { i: true }, images), 'Caption');
      return;
    }
    if (tag === 'ul' || tag === 'ol'){
      let n = 1;
      for (const li of el.querySelectorAll(':scope > li')){ const pre = tag === 'ol' ? `${n++}. ` : '• '; push([{ t: pre }].concat(await inlineRuns(li, {}, images))); }
      return;
    }
    if (tag === 'table'){ blocks.push({ table: await tableModel(el, images) }); return; }
    if (tag === 'section' || tag === 'div'){ for (const c of el.children) await block(c); return; }
    // fallback: treat as paragraph if it has text
    const r = await inlineRuns(el, {}, images); if (norm(runText(r))) push(r);
  }
  for (const c of docEl.children) await block(c);
  return blocks;
}
async function tableModel(tbl, images){
  const rows = [];
  for (const tr of tbl.querySelectorAll('tr')){
    const cells = [];
    for (const td of tr.querySelectorAll('th,td')) cells.push(await inlineRuns(td, { b: td.tagName.toLowerCase() === 'th' }, images));
    if (cells.length) rows.push(cells);
  }
  return rows;
}
function tableXml(rows){
  const cell = runs => `<w:tc><w:tcPr><w:tcBorders><w:top w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/></w:tcBorders></w:tcPr><w:p>${serializeRuns(runs)}</w:p></w:tc>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>`
    + rows.map(r => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('') + `</w:tbl>`;
}

// ---------- build the .docx ----------
async function buildDocx(docEl, comments, meta){
  await deps(false);
  const images = [];
  const blocks = await walkBlocks(docEl, comments && comments.length ? images : images);
  // anchor comments into the paragraph blocks
  const commentEntries = []; const used = new Set();
  (comments || []).forEach((c, i) => {
    const cid = i + 1; const q = c.quote || c.anchor?.quote || '';
    if (!norm(q)){ return; }
    for (const b of blocks){
      if (b.table || used.has(b) || !b.plain) continue;
      const loc = locate(b.runs, q);
      if (loc){ b.runs = annotateRuns(b.runs, loc[0], loc[1], cid, c.edit, c.author || 'Reviewer', c.date); used.add(b);
        commentEntries.push({ cid, c }); return; }
    }
    commentEntries.push({ cid, c, appendix: true });   // unanchored → appendix
  });
  // appendix for unanchored
  const appendix = commentEntries.filter(e => e.appendix);
  let bodyXml = blocks.map(b => b.table ? tableXml(b.table) : paraXml(b.runs, b.style)).join('');
  if (appendix.length){
    bodyXml += paraXml([{ t: 'Reviewer comments', b: true }], 'Heading1');
    appendix.forEach((e, n) => { const c = e.c; const who = (c.author || 'Reviewer') + (c.date ? `, ${String(c.date).slice(0,10)}` : '');
      let line = `${n+1}. [${who}]` + (c.quote || c.anchor?.quote ? ` on “${norm(c.quote || c.anchor.quote).slice(0,80)}”` : '') + ': ' + (c.body || '');
      if (c.edit) line += `  [suggested ${c.edit.op}: “${c.edit.find||''}” → “${c.edit.replacement||''}”]`;
      bodyXml += paraXml([{ t: line }]); });
  }
  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${WNS}">`
    + commentEntries.filter(e => !e.appendix).map(({ cid, c }) => {
      const body = (c.body || '') + (c.resolution?.note ? ` — ${c.resolution.state}: ${c.resolution.note}` : '');
      return `<w:comment w:id="${cid}" w:author="${xml(c.author || 'Reviewer')}"${c.date ? ` w:date="${xml(c.date)}"` : ''} w:initials="RV"><w:p><w:r><w:t xml:space="preserve">${xml(body)}</w:t></w:r></w:p></w:comment>`;
    }).join('') + `</w:comments>`;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="${WNS}" xmlns:r="${RNS}"><w:body>${bodyXml}`
    + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;

  // zip
  const zip = new _JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
    + `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="word/document.xml"/></Relationships>`);
  const rels = [`<Relationship Id="rIdStyles" Type="${RNS}/styles" Target="styles.xml"/>`, `<Relationship Id="rIdComments" Type="${RNS}/comments" Target="comments.xml"/>`]
    .concat(images.map(im => `<Relationship Id="rIdImg${im.id}" Type="${RNS}/image" Target="media/image${im.id}.${im.ext || 'png'}"/>`));
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  zip.file('word/document.xml', docXml);
  zip.file('word/comments.xml', commentsXml);
  zip.file('word/styles.xml', stylesXml());
  for (const im of images) zip.file(`word/media/image${im.id}.${im.ext || 'png'}`, im.data, { base64: true });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
function stylesXml(){
  const h = (id, name, sz) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WNS}">`
    + h('Heading1', 'heading 1', 32) + h('Heading2', 'heading 2', 28) + h('Heading3', 'heading 3', 24)
    + `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:sz w:val="18"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Figure"><w:name w:val="figure"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style></w:styles>`;
}

// ---------- markdown ----------
function buildMarkdown(docEl, comments, meta){
  const md = []; let fn = 0; const foot = [];
  const inline = el => {
    let s = '';
    for (const ch of el.childNodes){
      if (ch.nodeType === 3) s += ch.textContent;
      else if (ch.nodeType === 1){ const t = ch.tagName.toLowerCase();
        if (ch.classList?.contains('katex')){ const tex = ch.querySelector('annotation')?.textContent; s += tex ? `$${tex}$` : ch.textContent; }
        else if (t === 'strong' || t === 'b') s += `**${inline(ch)}**`;
        else if (t === 'em' || t === 'i') s += `*${inline(ch)}*`;
        else s += inline(ch);
      }
    }
    return s.replace(/\s+/g, ' ');
  };
  for (const el of docEl.children){
    const t = el.tagName?.toLowerCase();
    if (/^h([1-3])$/.test(t || '')){ md.push('\n' + '#'.repeat(+t[1]) + ' ' + inline(el).trim() + '\n'); }
    else if (t === 'p'){ md.push(inline(el).trim() + '\n'); }
    else if (t === 'figure'){ const cap = el.querySelector('figcaption'); md.push(`*[Figure${cap ? ': ' + inline(cap).trim() : ''}]*\n`); }
    else if (t === 'ul' || t === 'ol'){ let n = 1; for (const li of el.querySelectorAll(':scope > li')) md.push((t === 'ol' ? `${n++}. ` : '- ') + inline(li).trim()); md.push(''); }
    else if (t === 'section' || t === 'div'){ for (const c of el.children) md.push(inline(c).trim()); }
  }
  let out = md.join('\n');
  if (comments && comments.length){
    out += `\n\n---\n\n## Reviewer comments\n\n`;
    comments.forEach((c, i) => { const who = (c.author || 'Reviewer') + (c.date ? `, ${String(c.date).slice(0,10)}` : '');
      out += `**${i+1}. [${who}]**` + (c.quote || c.anchor?.quote ? ` on *“${norm(c.quote || c.anchor.quote).slice(0,80)}”*` : '') + `\n\n${c.body || ''}\n`;
      if (c.edit) out += `\n> _Suggested ${c.edit.op}:_ “${c.edit.find||''}” → “${c.edit.replacement||''}”\n`;
      if (c.resolution) out += `\n> _${c.resolution.state} by the author:_ ${c.resolution.note||''}\n`;
      out += '\n'; });
  }
  return out;
}

// ---------- print-to-PDF (vector, native Save dialog) ----------
function printPDF(docEl, comments, meta){
  const w = window.open('', '_blank'); if (!w){ alert('Allow pop-ups to print to PDF.'); return; }
  const cssLink = [...document.styleSheets].map(s => s.href).filter(Boolean).map(h => `<link rel="stylesheet" href="${h}">`).join('');
  const commentsHtml = (comments && comments.length) ? `<hr><h2>Reviewer comments</h2>` + comments.map((c, i) => {
    const who = (c.author || 'Reviewer') + (c.date ? `, ${String(c.date).slice(0,10)}` : '');
    return `<p><b>${i+1}. [${who}]</b>${c.quote || c.anchor?.quote ? ` on “${xml(norm(c.quote || c.anchor.quote).slice(0,90))}”` : ''}: ${xml(c.body||'')}${c.edit ? ` <i>[suggested ${c.edit.op}: “${xml(c.edit.find||'')}” → “${xml(c.edit.replacement||'')}”]</i>` : ''}</p>`;
  }).join('') : '';
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${xml(meta?.title || 'Chapter')}</title>${cssLink}
    <style>body{max-width:720px;margin:0 auto;padding:24px;font-size:12pt}@media print{@page{margin:1in}}</style></head>
    <body><article id="doc">${docEl.innerHTML}</article>${commentsHtml}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 600);
}

// ---------- public entry ----------
export async function exportClient({ docEl, comments, formats, meta, save }){
  const base = (meta?.filebase || 'chapter');
  for (const fmt of formats){
    if (fmt === 'md'){ await save(new Blob([buildMarkdown(docEl, comments, meta)], { type: 'text/markdown' }), `${base}.md`); }
    else if (fmt === 'docx'){ const blob = await buildDocx(docEl, comments, meta); await save(blob, `${base}.docx`); }
    else if (fmt === 'pdf'){ printPDF(docEl, comments, meta); }
  }
}

