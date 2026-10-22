// Builds the output PDF: applies form-field values and draws added overlays
// (text boxes, whiteout boxes, images) onto the original document with pdf-lib.

const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFBool, PDFHexString,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = window.PDFLib;

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

/**
 * @param {Uint8Array} originalBytes
 * @param {{fields: Map, overlays: Array, pages: Array}} doc
 *   pages[i].base is the pdf.js viewport at scale 1 used for overlay coordinates.
 */
export async function buildPdf(originalBytes, { fields, overlays, pages }) {
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

  // ---- overlays ----
  const docPages = pdfDoc.getPages();
  // Draw whiteout first so text/images placed on top of it stay visible.
  const order = { rect: 0, image: 1, text: 2 };
  const sorted = [...overlays].sort((a, b) => order[a.type] - order[b.type]);
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
