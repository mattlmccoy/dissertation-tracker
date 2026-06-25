import * as pdfjs from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';

const SCALE = 1.4;
const readPane = document.getElementById('read-pane');
readPane.style.cssText = 'flex:1;min-width:0;overflow:auto;height:calc(100vh - 49px)';

document.getElementById('topbar').innerHTML =
  `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:.5px solid var(--border);background:var(--bg-2)">
     <strong style="font-weight:500">Dissertation Reviewer</strong>
     <span id="ch-label" style="color:var(--text-2);font-size:13px"></span>
     <label style="margin-left:auto;font-size:12px;cursor:pointer;border:.5px solid var(--border-2);border-radius:8px;padding:5px 11px">
       Open PDF<input type="file" id="pdf-file" accept="application/pdf" class="hidden"></label>
   </div>`;

export async function renderPdf(arrayBuf){
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
    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    canvas.style.cssText = 'display:block;border:.5px solid var(--border);background:#fff;border-radius:4px';
    wrap.appendChild(canvas);
    readPane.appendChild(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const tl = document.createElement('div'); tl.className = 'textLayer';
    wrap.appendChild(tl);
    const tc = await page.getTextContent();
    const layer = new pdfjs.TextLayer({ textContentSource: tc, container: tl, viewport: vp });
    await layer.render();
  }
}

document.getElementById('pdf-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (f) renderPdf(await f.arrayBuffer());
});

// dev-only: ?demo loads a local demo.pdf so the render path can be verified headlessly
if (new URLSearchParams(location.search).has('demo')) {
  fetch('./demo.pdf').then(r => r.arrayBuffer()).then(renderPdf).catch(e => console.error('demo load failed', e));
}
