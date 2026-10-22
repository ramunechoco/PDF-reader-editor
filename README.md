# PDF Editor

A desktop PDF reader and editor for Windows, built with Electron, [pdf.js](https://github.com/mozilla/pdf.js) (rendering) and [pdf-lib](https://pdf-lib.js.org) (saving).

## Features

- **Fill forms**: text fields (single and multi-line), checkboxes, radio buttons, dropdowns and list boxes. Values are written back into the PDF's form fields, so the file stays fillable.
- **Existing text boxes**: you can edit text boxes that were added in another app ("typewriter" or "add text" comments, saved as FreeText annotations in the PDF). Click one to change its text, use the handle to move it, change its font, size or color, or press Delete to remove it. Edits are saved back into the same text box, and text boxes you don't touch are saved unchanged.
- **Add Text** (`T`): click anywhere to place a text box. You can set the font (Helvetica, Times or Courier), size, bold and color.
- **Edit Text** (`E`): click existing text to cover it and replace it with an editable copy in a matching size and font style. If you click a text box, Edit Text edits that box and doesn't cover the page text underneath it.
- **Whiteout** (`W`): drag a box to cover content. You can change its color.
- **Image** (`I`): pick a PNG, JPG, GIF, BMP or WebP file, then click to place it. You can also paste an image (`Ctrl+V`) or drag one onto a page. Drag an image to move it and use its corner handle to resize it.
- **Save / Save As** (`Ctrl+S` / `Ctrl+Shift+S`): before closing with unsaved changes, the app asks whether to save.
- Zoom with `Ctrl +/-`, `Ctrl+0` (fit width) or `Ctrl`+mouse wheel. You can open a PDF by dragging it onto the window.

Text that the standard PDF fonts can't encode (for example Polish, Czech or Turkish characters) is embedded using the Windows system fonts (Arial, Times New Roman or Courier New).

## Development

```bash
npm install
npm start
```

## Build

```bash
npm run dist
```

The installer (`PDF Editor Setup x.y.z.exe`) and a portable exe are written to `dist/`.

## Limitations

- Editing existing text works by covering it and placing new text on top. The original text stays in the file underneath the cover.
- Password-protected PDFs, XFA forms and signature fields aren't supported yet.
- Added items become part of the page when you save, so you can't select them again after saving.
- Text boxes from other apps on rotated pages, or rotated text boxes, are shown but can't be edited.
- A whiteout can hide other kinds of annotations in the app (stamps, drawings, highlights), but they still appear on top of it in the saved PDF.
