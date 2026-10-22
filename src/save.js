// Builds the output PDF: applies form-field values and draws added overlays
// (text boxes, whiteout boxes, images) onto the original document with pdf-lib.

const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFBool, PDFHexString, PDFString, PDFRef, PDFDict,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, moveText, showText,
  setFillingRgbColor } = window.PDFLib;

const STANDARD = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold],
};
// System TrueType fallbacks used when text contains characters outside WinAnsi.
const UNICODE = {
  Helvetica: ['arial.ttf', 'arialbd.ttf'],
  Times: ['times.ttf', 'timesbd.ttf'],
  Courier: ['cour.ttf', 'courbd.ttf'],
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function canEncode(font, text) {
  try { font.encodeText(text); return true; } catch { return false; }
}

class FontCache {
  constructor(doc) { this.doc = doc; this.cache = new Map(); }

  async get(family, bold, text) {
    const std = await this.load(`std:${family}:${bold}`, () => this.doc.embedFont(STANDARD[family][bold ? 1 : 0]));
    if (canEncode(std, text)) return std;
    const file = UNICODE[family][bold ? 1 : 0];
    const uni = await this.load(`ttf:${file}`, async () => {
      const bytes = await window.api.readFont(file);
      return bytes ? this.doc.embedFont(bytes, { subset: true }) : null;
    });
    if (uni) return uni;
    throw new Error(`Text "${text.slice(0, 30)}" uses characters that can't be embedded (font ${file} not found).`);
  }

  async load(key, factory) {
    if (!this.cache.has(key)) this.cache.set(key, await factory());
    return this.cache.get(key);
  }
}

function applyField(field, f) {
  const v = f.value;
  if (field instanceof PDFTextField) {
    field.setText(v || undefined);
  } else if (field instanceof PDFCheckBox) {
    v ? field.check() : field.uncheck();
  } else if (field instanceof PDFRadioGroup) {
    if (v == null) field.clear();
    else field.select(v);
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const values = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
    if (values.length === 0) { field.clear(); return; }
    // pdf-lib validates against display labels; write export values straight to /V
    // so the option list isn't turned into an editable combo.
    const labels = field.getOptions();
    if (values.every((x) => labels.includes(x))) field.select(values);
    else { field.acroField.setValues(values.map((x) => PDFHexString.fromText(x))); field.markAsDirty(); }
  }
}

function refFromId(id) {
  const match = /^(\d+)R(\d*)$/.exec(id || '');
  return match ? PDFRef.of(+match[1], +(match[2] || 0)) : null;
}

const DA_FONT = { Helvetica: 'Helv', Times: 'TiRo', Courier: 'Cour' };
const CSS_FONT = { Helvetica: 'Helvetica,sans-serif', Times: 'Times New Roman,serif', Courier: 'Courier New,monospace' };

async function rewriteFreeText(pdfDoc, fonts, m, vp) {
  const ref = refFromId(m.annot.id);
  const dict = ref && pdfDoc.context.lookupMaybe(ref, PDFDict);
  if (!dict) { console.warn('Annotation not found', m.annot.id); return; }

  const text = m.text.replace(/\r/g, '').replace(/\n+$/, '');
  const lines = text.split('\n');
  const font = await fonts.get(m.font, m.bold, lines.join(''));
  const pad = 1;
  const lineH = m.size * 1.2;
  const width = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, m.size)), 1) + pad * 2;
  const height = lineH * lines.length + pad * 2;
  const [left, top] = vp.convertToPdfPoint(m.x - pad, m.y - pad);
  const rect = [left, top - height, left + width, top];

  const c = hexToRgb(m.color);
  const ops = [pushGraphicsState(), beginText(), setFontAndSize('F1', m.size),
    setFillingRgbColor(c.red, c.green, c.blue)];
  lines.forEach((line, i) => {
    const y = height - pad - m.size * (i * 1.2 + BASELINE[m.font]);
    ops.push(moveText(i === 0 ? pad : 0, i === 0 ? y : -lineH));
    if (line) ops.push(showText(font.encodeText(line)));
  });
  ops.push(endText(), popGraphicsState());
  const ap = pdfDoc.context.formXObject(ops, {
    BBox: [0, 0, width, height],
    Resources: { Font: { F1: font.ref } },
  });

  const ctx = pdfDoc.context;
  dict.set(PDFName.of('Rect'), ctx.obj(rect));
  dict.set(PDFName.of('AP'), ctx.obj({ N: ctx.register(ap) }));
  dict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
  dict.set(PDFName.of('M'), PDFString.fromDate(new Date()));
  dict.set(PDFName.of('DA'), PDFString.of(
    `/${DA_FONT[m.font]} ${m.size} Tf ${c.red.toFixed(3)} ${c.green.toFixed(3)} ${c.blue.toFixed(3)} rg`));
  dict.set(PDFName.of('DS'), PDFString.of(
    `font: ${m.bold ? 'bold ' : ''}${m.size}pt ${CSS_FONT[m.font]}; color:${m.color}`));
  dict.delete(PDFName.of('RC'));

  const popup = refFromId(m.annot.popupId);
  const popupDict = popup && ctx.lookupMaybe(popup, PDFDict);
  if (popupDict?.has(PDFName.of('Contents'))) popupDict.set(PDFName.of('Contents'), PDFHexString.fromText(text));
}

function removeAnnot(pdfDoc, page, annot) {
  const annots = page.node.Annots();
  if (!annots) return;
  for (const id of [annot.id, annot.popupId]) {
    const ref = refFromId(id);
    if (!ref) continue;
    const idx = annots.indexOf(ref);
    if (idx >= 0) annots.remove(idx);
    pdfDoc.context.delete(ref);
  }
}

/**
 * @param {Uint8Array} originalBytes
 * @param {{fields: Map, overlays: Array, deletedAnnots: Array, pages: Array}} doc
 *   pages[i].base is the pdf.js viewport at scale 1 used for overlay coordinates.
 */
export async function buildPdf(originalBytes, { fields, overlays, deletedAnnots = [], pages }) {
  const pdfDoc = await PDFDocument.load(originalBytes, { updateMetadata: false });
  pdfDoc.registerFontkit(window.fontkit);
  const fonts = new FontCache(pdfDoc);

  // ---- form fields ----
  const changed = [...fields.entries()].filter(([, f]) => f.dirty);
  if (changed.length) {
    const form = pdfDoc.getForm();
    let allText = '';
    for (const [name, f] of changed) {
      let field;
      try { field = form.getField(name); } catch { console.warn('Field not found', name); continue; }
      applyField(field, f);
      if (typeof f.value === 'string') allText += f.value;
    }
    try {
      const font = await fonts.get('Helvetica', false, allText);
      form.updateFieldAppearances(font);
    } catch (err) {
      // Fall back to asking the viewer to regenerate appearances itself.
      console.warn('Could not generate field appearances:', err);
      form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    }
  }

  const docPages = pdfDoc.getPages();

  for (const m of overlays) {
    if (m.annot?.modified) await rewriteFreeText(pdfDoc, fonts, m, pages[m.pageIndex].base);
  }
  for (const annot of deletedAnnots) removeAnnot(pdfDoc, docPages[annot.pageIndex], annot);

  // ---- overlays ----
  // Draw whiteout first so text/images placed on top of it stay visible.
  const order = { rect: 0, image: 1, text: 2 };
  const sorted = overlays.filter((m) => !m.annot).sort((a, b) => order[a.type] - order[b.type]);
  for (const m of sorted) {
    const page = docPages[m.pageIndex];
    const vp = pages[m.pageIndex].base;
    const rotate = degrees(vp.rotation);
    const toPdf = (x, y) => vp.convertToPdfPoint(x, y);

    if (m.type === 'rect') {
      const [x1, y1] = toPdf(m.x, m.y);
      const [x2, y2] = toPdf(m.x + m.w, m.y + m.h);
      page.drawRectangle({
        x: Math.min(x1, x2), y: Math.min(y1, y2),
        width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
        color: hexToRgb(m.color),
      });
    } else if (m.type === 'image') {
      const img = m.format === 'jpg' ? await pdfDoc.embedJpg(m.bytes) : await pdfDoc.embedPng(m.bytes);
      const [x, y] = toPdf(m.x, m.y + m.h);
      page.drawImage(img, { x, y, width: m.w, height: m.h, rotate });
    } else if (m.type === 'text') {
      const lines = m.text.replace(/\r/g, '').split('\n');
      if (!m.text.trim()) continue;
      const font = await fonts.get(m.font, m.bold, m.text.replace(/\n/g, ''));
      lines.forEach((line, i) => {
        if (!line) return;
        // Baseline position matches the CSS layout (line-height 1.2).
        const baseline = m.y + m.size * (i * 1.2 + BASELINE[m.font]);
        const [x, y] = toPdf(m.x, baseline);
        page.drawText(line, { x, y, size: m.size, font, color: hexToRgb(m.color), rotate });
      });
    }
  }

  return pdfDoc.save();
}

// Distance from the top of a CSS line box (line-height 1.2) to the baseline,
// in ems, for the on-screen fonts (Arial / Times New Roman / Courier New).
export const BASELINE = { Helvetica: 0.947, Times: 0.935, Courier: 0.867 };
