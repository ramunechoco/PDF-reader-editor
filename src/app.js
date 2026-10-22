import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import { buildPdf, BASELINE } from './save.js';

const PDFJS = new URL('../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.mjs';

const $ = (sel) => document.querySelector(sel);
const viewer = $('#viewer');
const pagesEl = $('#pages');

const FONT_CSS = {
  Helvetica: 'Arial, Helvetica, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const MAX_CANVAS_PIXELS = 16_000_000;

const state = {
  file: null,          // { path, name }
  bytes: null,         // original PDF bytes (Uint8Array)
  pdf: null,           // pdf.js document
  loadingTask: null,   // pdf.js loading task (owns the worker; destroy to release)
  pages: [],           // per-page view state, see createPage()
  scale: 1,
  tool: 'select',
  overlays: [],        // added content: text boxes, whiteout boxes, images
  selected: null,
  fields: new Map(),   // form field name -> { type, value, dirty, elements }
  dirty: false,
  pendingImage: null,
  nextId: 1,
};
const textDefaults = { font: 'Helvetica', size: 12, bold: false, color: '#000000' };
let observer = null;
const visiblePages = new Set();

// ---------------------------------------------------------------- utilities

let toastTimer;
function toast(msg, isError = false, ms = 2500) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 6000 : ms);
}

function isEditingElement(el) {
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

function markDirty() {
  if (state.dirty) return;
  state.dirty = true;
  updateTitle();
  window.api.setDirty(true);
}

function updateTitle() {
  const name = state.file?.name;
  document.title = name ? `${state.dirty ? '• ' : ''}${name} — PDF Editor` : 'PDF Editor';
}

function rectToView(vp, rect) {
  const [x1, y1] = vp.convertToViewportPoint(rect[0], rect[1]);
  const [x2, y2] = vp.convertToViewportPoint(rect[2], rect[3]);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

function pagePoint(e, page) {
  const r = page.el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
}

// ---------------------------------------------------------------- loading

async function openFile(info, keepView = false) {
  let pdf, loadingTask;
  const bytes = new Uint8Array(info.bytes);
  try {
    loadingTask = pdfjsLib.getDocument({
      data: bytes.slice(), // pdf.js transfers (detaches) the buffer it is given
      cMapUrl: PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS + 'standard_fonts/',
      wasmUrl: PDFJS + 'wasm/',
      iccUrl: PDFJS + 'iccs/',
      isEvalSupported: false,
    });
    pdf = await loadingTask.promise;
  } catch (err) {
    loadingTask?.destroy();
    console.error(err);
    toast(err.name === 'PasswordException'
      ? 'Password-protected PDFs are not supported yet.'
      : `Could not open PDF: ${err.message}`, true);
    return;
  }

  const prevScroll = keepView ? { top: viewer.scrollTop, left: viewer.scrollLeft } : null;
  observer?.disconnect();
  visiblePages.clear();
  await state.loadingTask?.destroy();
  for (const m of state.overlays) if (m.url) URL.revokeObjectURL(m.url);

  Object.assign(state, {
    file: { path: info.path, name: info.name },
    bytes, pdf, loadingTask, pages: [], overlays: [], selected: null, fields: new Map(), dirty: false,
  });
  window.api.setDirty(false);
  updateTitle();
  updateProps();
  pagesEl.replaceChildren();

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = createPage(await pdf.getPage(i), i - 1);
    state.pages.push(page);
    pagesEl.append(page.el);
  }

  $('#empty').classList.add('hidden');
  $('#btn-save').disabled = false;
  $('#btn-save-as').disabled = false;

  if (!keepView) state.scale = fitWidthScale();
  applyScale();
  if (prevScroll) { viewer.scrollTop = prevScroll.top; viewer.scrollLeft = prevScroll.left; }
  else viewer.scrollTop = 0;

  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const page = state.pages[+entry.target.dataset.index];
      if (entry.isIntersecting) { visiblePages.add(page); renderPage(page); }
      else visiblePages.delete(page);
    }
  }, { root: viewer, rootMargin: '600px 0px' });
  state.pages.forEach((p) => observer.observe(p.el));
  updatePageLabel();
}

function createPage(pdfPage, index) {
  const base = pdfPage.getViewport({ scale: 1 });
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.index = index;
  const canvas = document.createElement('canvas');
  const overlayLayer = document.createElement('div');
  overlayLayer.className = 'layer overlay-layer';
  const formLayer = document.createElement('div');
  formLayer.className = 'layer form-layer';
  for (const layer of [overlayLayer, formLayer]) {
    layer.style.width = `${base.width}px`;
    layer.style.height = `${base.height}px`;
  }
  el.append(canvas, overlayLayer, formLayer);

  const page = { index, pdfPage, base, el, canvas, overlayLayer, formLayer,
    renderedScale: 0, renderTask: null, formsBuilt: false, textContent: null };
  el.addEventListener('pointerdown', (e) => onPagePointerDown(e, page));
  return page;
}

// ---------------------------------------------------------------- rendering & zoom

function fitWidthScale() {
  const maxW = Math.max(...state.pages.map((p) => p.base.width), 1);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, (viewer.clientWidth - 60) / maxW));
}

function applyScale() {
  const s = state.scale;
  for (const p of state.pages) {
    p.el.style.width = `${p.base.width * s}px`;
    p.el.style.height = `${p.base.height * s}px`;
    p.overlayLayer.style.transform = p.formLayer.style.transform = `scale(${s})`;
  }
  $('#zoom-label').textContent = `${Math.round(s * 100)}%`;
  visiblePages.forEach(renderPage);
}

function setScale(newScale) {
  if (!state.pdf) return;
  newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  // Keep the point at the viewport centre stable while zooming.
  const cx = (viewer.scrollLeft + viewer.clientWidth / 2) / viewer.scrollWidth;
  const cy = (viewer.scrollTop + viewer.clientHeight / 2) / viewer.scrollHeight;
  state.scale = newScale;
  applyScale();
  viewer.scrollLeft = cx * viewer.scrollWidth - viewer.clientWidth / 2;
  viewer.scrollTop = cy * viewer.scrollHeight - viewer.clientHeight / 2;
}

async function renderPage(page) {
  const scale = state.scale;
  if (page.renderedScale === scale || page.renderingScale === scale) return;
  page.renderTask?.cancel();

  const area = page.base.width * page.base.height;
  const renderScale = Math.min(scale * (window.devicePixelRatio || 1), Math.sqrt(MAX_CANVAS_PIXELS / area));
  const vp = page.pdfPage.getViewport({ scale: renderScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);

  // Form widgets are drawn as HTML inputs instead of on the canvas.
  const task = page.pdfPage.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vp,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS,
  });
  page.renderTask = task;
  page.renderingScale = scale;
  try {
    await task.promise;
  } catch (err) {
    if (!(err instanceof pdfjsLib.RenderingCancelledException)) console.error(err);
    return;
  } finally {
    if (page.renderTask === task) { page.renderTask = null; page.renderingScale = 0; }
  }
  page.canvas.replaceWith(canvas);
  page.canvas = canvas;
  page.renderedScale = scale;

  if (!page.formsBuilt) {
    page.formsBuilt = true;
    await buildForms(page);
  }
}

function updatePageLabel() {
  if (!state.pages.length) { $('#page-label').textContent = ''; return; }
  const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 2;
  let current = 0;
  state.pages.forEach((p, i) => { if (p.el.getBoundingClientRect().top <= mid) current = i; });
  $('#page-label').textContent = `Page ${current + 1} / ${state.pages.length}`;
}

// ---------------------------------------------------------------- form fields

function fieldEntry(a) {
  let f = state.fields.get(a.fieldName);
  if (f) return f;
  let value;
  if (a.fieldType === 'Tx') value = a.fieldValue ?? '';
  else if (a.checkBox) value = !!a.fieldValue && a.fieldValue !== 'Off';
  else if (a.radioButton) value = a.fieldValue && a.fieldValue !== 'Off' ? a.fieldValue : null;
  else if (a.fieldType === 'Ch') value = Array.isArray(a.fieldValue) ? a.fieldValue : [a.fieldValue].filter(Boolean);
  f = { type: a.fieldType, value, dirty: false, elements: new Set() };
  state.fields.set(a.fieldName, f);
  return f;
}

function showFieldValue(el, f) {
  if (el.type === 'checkbox') el.checked = !!f.value;
  else if (el.type === 'radio') el.checked = f.value === el.dataset.value;
  else if (el.tagName === 'SELECT') {
    for (const opt of el.options) opt.selected = f.value.includes(opt.value);
  } else el.value = f.value;
}

function setFieldValue(name, value, source) {
  const f = state.fields.get(name);
  f.value = value;
  f.dirty = true;
  for (const el of f.elements) if (el !== source) showFieldValue(el, f);
  markDirty();
}

async function buildForms(page) {
  let annotations;
  try { annotations = await page.pdfPage.getAnnotations({ intent: 'display' }); }
  catch (err) { console.warn('Could not read annotations', err); return; }

  for (const a of annotations) {
    if (a.subtype !== 'Widget' || a.hidden || !a.fieldName) continue;
    const name = a.fieldName;
    const r = rectToView(page.base, a.rect);
    let el;

    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input');
      if (!a.multiLine) el.type = a.password ? 'password' : 'text';
      if (a.maxLen) el.maxLength = a.maxLen;
      el.style.textAlign = ['left', 'center', 'right'][a.textAlignment] || 'left';
      // pdf.js resolves "auto" (0) sizes to whatever fills the box, which is
      // oversized for multi-line fields; clamp to a readable size.
      const da = a.defaultAppearanceData?.fontSize || 0;
      const size = a.multiLine
        ? (da > 0 && da <= r.h / 3 ? da : Math.min(12, r.h * 0.6))
        : Math.max(6, Math.min(da || 12, r.h * 0.75));
      el.style.fontSize = `${size}px`;
      if (a.comb && a.maxLen) {
        el.style.letterSpacing = `${r.w / a.maxLen - size * 0.6}px`;
        el.style.paddingLeft = `${Math.max(0, (r.w / a.maxLen - size * 0.6) / 2)}px`;
      }
      el.addEventListener('input', () => setFieldValue(name, el.value, el));
    } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
      el = document.createElement('input');
      el.type = a.checkBox ? 'checkbox' : 'radio';
      el.classList.add('check');
      if (a.radioButton) {
        el.classList.add('radio');
        el.name = `radio:${name}`;
        el.dataset.value = a.buttonValue;
      }
      el.style.setProperty('--mark', `${Math.min(r.w, r.h) * 0.8}px`);
      el.addEventListener('change', () => {
        if (a.checkBox) setFieldValue(name, el.checked, el);
        else if (el.checked) setFieldValue(name, a.buttonValue, el);
      });
    } else if (a.fieldType === 'Ch') {
      el = document.createElement('select');
      if (!a.combo) { el.size = Math.max(2, a.options.length); el.multiple = !!a.multiSelect; }
      for (const o of a.options) el.add(new Option(o.displayValue ?? o.exportValue, o.exportValue));
      el.style.fontSize = `${Math.max(6, Math.min(r.h * 0.65, 12))}px`;
      el.addEventListener('change', () => {
        setFieldValue(name, [...el.selectedOptions].map((o) => o.value), el);
      });
    } else {
      continue; // signatures and push buttons are left as drawn by pdf.js
    }

    const f = fieldEntry(a);
    el.classList.add('field');
    el.dataset.field = name;
    el.title = a.alternativeText || name;
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    if (a.readOnly) { el.readOnly = true; if (el.tagName !== 'INPUT' || el.type !== 'text') el.disabled = true; }
    f.elements.add(el);
    showFieldValue(el, f);
    page.formLayer.append(el);
  }
}

// ---------------------------------------------------------------- overlays

function addOverlay(model) {
  model.id = state.nextId++;
  state.overlays.push(model);
  renderOverlay(model);
  select(model);
  markDirty();
  return model;
}

function removeOverlay(m) {
  m.el.remove();
  state.overlays = state.overlays.filter((o) => o !== m);
  if (m.url) URL.revokeObjectURL(m.url);
  if (state.selected === m) select(null);
  markDirty();
}

function renderOverlay(m) {
  const el = document.createElement('div');
  el.className = `ov ${m.type}`;
  m.el = el;

  if (m.type === 'text') {
    const content = document.createElement('div');
    content.className = 'content';
    content.contentEditable = 'plaintext-only';
    content.spellcheck = false;
    content.textContent = m.text;
    content.addEventListener('input', () => { m.text = content.innerText; markDirty(); });
    content.addEventListener('focus', () => select(m));
    content.addEventListener('blur', () => {
      m.text = content.innerText.replace(/\n$/, '');
      if (!m.text.trim()) removeOverlay(m);
    });
    m.content = content;
    el.append(content);
  } else if (m.type === 'image') {
    const img = document.createElement('img');
    img.src = m.url;
    img.draggable = false;
    el.append(img);
  }

  const move = document.createElement('div');
  move.className = 'handle move';
  move.title = 'Drag to move';
  const resize = document.createElement('div');
  resize.className = 'handle resize';
  resize.title = 'Drag to resize (Shift: free aspect)';
  el.append(move, resize);

  el.addEventListener('pointerdown', (e) => {
    if (state.tool !== 'select' || e.button !== 0) return;
    select(m);
    if (e.target === resize) startDrag(e, m, 'resize');
    else if (e.target === move || m.type !== 'text') startDrag(e, m, 'move');
  });

  updateOverlayEl(m);
  state.pages[m.pageIndex].overlayLayer.append(el);
}

function updateOverlayEl(m) {
  const s = m.el.style;
  s.left = `${m.x}px`;
  s.top = `${m.y}px`;
  if (m.type === 'text') {
    Object.assign(m.content.style, {
      fontFamily: FONT_CSS[m.font],
      fontSize: `${m.size}px`,
      fontWeight: m.bold ? 'bold' : 'normal',
      color: m.color,
    });
  } else {
    s.width = `${m.w}px`;
    s.height = `${m.h}px`;
    if (m.type === 'rect') s.background = m.color;
  }
}

function startDrag(e, m, mode) {
  e.preventDefault();
  e.stopPropagation();
  const start = { x: e.clientX, y: e.clientY, mx: m.x, my: m.y, w: m.w, h: m.h };
  const target = e.target;
  target.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    const dx = (ev.clientX - start.x) / state.scale;
    const dy = (ev.clientY - start.y) / state.scale;
    if (mode === 'move') {
      m.x = start.mx + dx;
      m.y = start.my + dy;
    } else {
      m.w = Math.max(4, start.w + dx);
      m.h = Math.max(4, start.h + dy);
      if (m.type === 'image' && !ev.shiftKey) m.h = m.w * (start.h / start.w);
    }
    updateOverlayEl(m);
    markDirty();
  };
  const onUp = () => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
}

function select(m) {
  if (state.selected === m) return;
  state.selected?.el.classList.remove('selected');
  state.selected = m;
  m?.el.classList.add('selected');
  updateProps();
}

function focusText(m, selectAll = false) {
  requestAnimationFrame(() => {
    m.content.focus();
    const range = document.createRange();
    range.selectNodeContents(m.content);
    if (!selectAll) range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
}

// ---------------------------------------------------------------- properties bar

function updateProps() {
  const m = state.selected;
  $('#props').classList.toggle('hidden', !m);
  if (!m) return;
  const isText = m.type === 'text';
  for (const id of ['#prop-font', '#prop-size', '#prop-bold']) $(id).classList.toggle('hidden', !isText);
  $('#prop-color').classList.toggle('hidden', m.type === 'image');
  if (isText) {
    $('#prop-font').value = m.font;
    $('#prop-size').value = m.size;
    $('#prop-bold').classList.toggle('active', m.bold);
  }
  if (m.color) $('#prop-color').value = m.color;
}

function changeProp(key, value) {
  const m = state.selected;
  if (!m) return;
  m[key] = value;
  if (m.type === 'text') textDefaults[key] = value;
  updateOverlayEl(m);
  updateProps();
  markDirty();
}

$('#prop-font').addEventListener('change', (e) => changeProp('font', e.target.value));
$('#prop-size').addEventListener('input', (e) => { const v = +e.target.value; if (v >= 4) changeProp('size', v); });
$('#prop-bold').addEventListener('click', () => changeProp('bold', !state.selected?.bold));
$('#prop-color').addEventListener('input', (e) => changeProp('color', e.target.value));
$('#prop-delete').addEventListener('click', () => state.selected && removeOverlay(state.selected));
// Keep text-box focus when clicking toolbar buttons.
$('#props').addEventListener('mousedown', (e) => { if (e.target.tagName === 'BUTTON') e.preventDefault(); });

// ---------------------------------------------------------------- tools

async function setTool(tool) {
  if (!state.pdf && tool !== 'select') return;
  if (tool === 'image') {
    const img = await pickImage();
    if (!img) tool = 'select';
    else toast('Click on a page to place the image');
  } else {
    state.pendingImage = null;
  }
  state.tool = tool;
  document.body.dataset.tool = tool;
  document.querySelectorAll('#tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  if (tool === 'edit') toast('Click on existing text to replace it');
  if (tool === 'whiteout') toast('Drag over the area to cover');
}

function onPagePointerDown(e, page) {
  if (e.button !== 0) return;
  const pt = pagePoint(e, page);
  switch (state.tool) {
    case 'select':
      if (!e.target.closest('.ov')) select(null);
      break;
    case 'text': {
      e.preventDefault();
      const m = addOverlay({ type: 'text', pageIndex: page.index, x: pt.x, y: pt.y - textDefaults.size * 0.6,
        text: '', ...textDefaults });
      setTool('select');
      focusText(m);
      break;
    }
    case 'edit':
      e.preventDefault();
      editTextAt(page, pt);
      break;
    case 'whiteout':
      e.preventDefault();
      drawWhiteout(e, page, pt);
      break;
    case 'image':
      e.preventDefault();
      if (state.pendingImage) placeImage(state.pendingImage, page, pt);
      setTool('select');
      break;
  }
}

function drawWhiteout(e, page, start) {
  const box = document.createElement('div');
  box.className = 'drag-box';
  page.overlayLayer.append(box);
  let rect = { x: start.x, y: start.y, w: 0, h: 0 };
  const onMove = (ev) => {
    const p = pagePoint(ev, page);
    rect = { x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    box.remove();
    if (rect.w > 2 && rect.h > 2) addOverlay({ type: 'rect', pageIndex: page.index, ...rect, color: '#ffffff' });
    setTool('select');
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function guessFont(page, fontId) {
  let name = '';
  try { name = page.pdfPage.commonObjs.get(fontId)?.name || ''; } catch { /* font not loaded */ }
  const family = /courier|mono/i.test(name) ? 'Courier'
    : /times|roman|serif|georgia|garamond|cambria|book/i.test(name) && !/sans/i.test(name) ? 'Times'
    : 'Helvetica';
  return { family, bold: /bold|black|heavy|semibold|demi/i.test(name) };
}

async function editTextAt(page, pt) {
  page.textContent ??= await page.pdfPage.getTextContent();
  const vp = page.base;
  let best = null;
  for (const item of page.textContent.items) {
    if (!item.str?.trim()) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fontH = Math.hypot(tx[2], tx[3]);
    if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) continue; // only upright text
    const box = { x: tx[4], y: tx[5] - fontH, w: item.width * vp.scale, h: fontH * 1.25 };
    if (pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h) {
      if (!best || box.w * box.h < best.box.w * best.box.h) best = { item, box, fontH, baseline: tx[5] };
    }
  }
  setTool('select');
  if (!best) { toast('No text found there — use Add Text to place new text.'); return; }

  const { family, bold } = guessFont(page, best.item.fontName);
  const size = Math.round(best.fontH * 10) / 10;
  const pad = Math.max(1, best.fontH * 0.1);
  addOverlay({ type: 'rect', pageIndex: page.index, color: '#ffffff',
    x: best.box.x - pad, y: best.box.y - pad, w: best.box.w + pad * 2, h: best.box.h + pad * 2 });
  const m = addOverlay({ type: 'text', pageIndex: page.index, text: best.item.str, size, font: family, bold,
    color: '#000000', x: best.box.x, y: best.baseline - size * BASELINE[family] });
  focusText(m, true);
}

// ---------------------------------------------------------------- images

async function prepareImage(bytes, ext, name) {
  let format = ext === 'png' ? 'png' : ext === 'jpg' || ext === 'jpeg' ? 'jpg' : null;
  const blob = new Blob([bytes], { type: format === 'jpg' ? 'image/jpeg' : format ? 'image/png' : '' });
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) throw new Error(`Unsupported image: ${name}`);
  if (!format) {
    // pdf-lib embeds PNG and JPEG only; convert anything else to PNG.
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    format = 'png';
  }
  const img = { bytes: new Uint8Array(bytes), format, width: bitmap.width, height: bitmap.height,
    url: URL.createObjectURL(new Blob([bytes], { type: format === 'jpg' ? 'image/jpeg' : 'image/png' })) };
  bitmap.close();
  return img;
}

async function pickImage() {
  const file = await window.api.pickImage();
  if (!file) return null;
  try {
    state.pendingImage = await prepareImage(file.bytes, file.ext, file.name);
    return state.pendingImage;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

function placeImage(img, page, center) {
  // 1 image pixel = 0.75pt (96 dpi), capped to 60% of the page width.
  let w = img.width * 0.75;
  let h = img.height * 0.75;
  const maxW = page.base.width * 0.6;
  if (w > maxW) { h *= maxW / w; w = maxW; }
  addOverlay({ type: 'image', pageIndex: page.index, x: center.x - w / 2, y: center.y - h / 2, w, h,
    bytes: img.bytes, format: img.format, url: img.url });
  state.pendingImage = null;
}

function currentPage() {
  const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 2;
  return state.pages.find((p) => p.el.getBoundingClientRect().bottom >= mid) || state.pages[0];
}

// ---------------------------------------------------------------- open / save

async function confirmDiscard() {
  return !state.dirty || window.confirm('You have unsaved changes. Discard them?');
}

async function openDialog() {
  if (!(await confirmDiscard())) return;
  const info = await window.api.openPdf();
  if (info) await openFile(info);
}

async function save(saveAs = false) {
  if (!state.pdf) return false;
  if (isEditingElement(document.activeElement)) document.activeElement.blur();
  let target = state.file.path;
  if (saveAs || !target) {
    target = await window.api.pickSavePath(state.file.path || state.file.name);
    if (!target) return false;
  }
  try {
    toast('Saving…', false, 10000);
    const out = await buildPdf(state.bytes, { fields: state.fields, overlays: state.overlays, pages: state.pages });
    const saved = await window.api.savePdf(target, out);
    // Reload from the saved bytes so added content becomes part of the document.
    await openFile({ ...saved, bytes: out }, true);
    toast(`Saved ${saved.name}`);
    return true;
  } catch (err) {
    console.error(err);
    toast(`Save failed: ${err.message}`, true);
    return false;
  }
}

// ---------------------------------------------------------------- wiring

$('#btn-open').addEventListener('click', openDialog);
$('#btn-open-empty').addEventListener('click', openDialog);
$('#btn-save').addEventListener('click', () => save());
$('#btn-save-as').addEventListener('click', () => save(true));
$('#btn-zoom-in').addEventListener('click', () => setScale(state.scale * 1.2));
$('#btn-zoom-out').addEventListener('click', () => setScale(state.scale / 1.2));
$('#btn-fit').addEventListener('click', () => setScale(fitWidthScale()));
document.querySelectorAll('#tools button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

viewer.addEventListener('scroll', updatePageLabel, { passive: true });
viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

window.api.onMenu(async (name) => {
  switch (name) {
    case 'open': return openDialog();
    case 'save': return save();
    case 'saveAs': return save(true);
    case 'saveAndClose': if (await save()) window.api.closeNow(); return;
    case 'zoomIn': return setScale(state.scale * 1.2);
    case 'zoomOut': return setScale(state.scale / 1.2);
    case 'fitWidth': return setScale(fitWidthScale());
  }
});

document.addEventListener('keydown', (e) => {
  const editing = isEditingElement(document.activeElement);
  if (e.key === 'Escape') {
    if (editing) document.activeElement.blur();
    select(null);
    setTool('select');
    return;
  }
  if (editing || e.ctrlKey || e.altKey || e.metaKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    e.preventDefault();
    removeOverlay(state.selected);
    return;
  }
  const tool = { t: 'text', e: 'edit', w: 'whiteout', i: 'image', v: 'select' }[e.key.toLowerCase()];
  if (tool) setTool(tool);
});

// Paste an image from the clipboard onto the current page.
document.addEventListener('paste', async (e) => {
  if (!state.pdf || isEditingElement(document.activeElement)) return;
  const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  try {
    const img = await prepareImage(new Uint8Array(await file.arrayBuffer()), file.type.split('/')[1], 'clipboard image');
    const page = currentPage();
    placeImage(img, page, { x: page.base.width / 2, y: page.base.height / 2 });
  } catch (err) { toast(err.message, true); }
});

// Drag & drop: a PDF opens it, an image is placed where it is dropped.
viewer.addEventListener('dragover', (e) => { e.preventDefault(); viewer.classList.add('drop-target'); });
viewer.addEventListener('dragleave', () => viewer.classList.remove('drop-target'));
viewer.addEventListener('drop', async (e) => {
  e.preventDefault();
  viewer.classList.remove('drop-target');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    if (!(await confirmDiscard())) return;
    await openFile(await window.api.readPdf(window.api.pathForFile(file)));
  } else if (file.type.startsWith('image/')) {
    const pageEl = e.target.closest('.page');
    if (!pageEl) { toast('Drop the image onto a page'); return; }
    try {
      const page = state.pages[+pageEl.dataset.index];
      placeImage(await prepareImage(new Uint8Array(await file.arrayBuffer()), ext, file.name), page, pagePoint(e, page));
    } catch (err) { toast(err.message, true); }
  }
});

window.addEventListener('resize', updatePageLabel);
document.body.dataset.tool = 'select';

const initial = await window.api.initialFile();
if (initial) {
  try { await openFile(await window.api.readPdf(initial)); }
  catch (err) { toast(`Could not open ${initial}: ${err.message}`, true); }
}
