import { degrees, PDFDocument, PDFName, rgb, StandardFonts } from 'pdf-lib';
import { validateOperations } from '../../agentic-pdf-runner/policy';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createJob, type EditResult, fetchPdfBytes, getJob, resolveJobPdfUrl, type TemplateItem } from './api';
import type { ApprovedEditOperation, PageTextSnapshot, PdfPointRect } from './lib/backend';

GlobalWorkerOptions.workerSrc = workerUrl;
export { getDocument };
export type { PDFDocumentProxy };

export interface TargetRegion {
  page: number;
  bbox: [number, number, number, number];
  label?: string;
}

export interface ExtractedTextSpan {
  page: number;
  text: string;
  bbox: [number, number, number, number];
  pdfRect: PdfPointRect;
}

export interface ExtractedPageStructure {
  page: number;
  width: number;
  height: number;
  paperBg: [number, number, number];
  lines: string[];
  spans: ExtractedTextSpan[];
}

export interface ExtractedDocumentStructure {
  totalPages: number;
  pages: ExtractedPageStructure[];
}

export async function samplePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const roman = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  const sections: [string, string][] = [
    ['Scope of services', 'Deliverables'],
    ['Commercial terms', 'Authorized signatories'],
    ['Confidentiality', 'Data protection'],
    ['Governing law', 'Dispute resolution'],
    ['Term & renewal', 'Termination'],
    ['Notices', 'Entire agreement'],
  ];

  const descriptions = [
    'The Provider shall perform the professional services described in the agreed Statement of Work. Services include strategy, design, development and ongoing advisory support, as further detailed in each engagement.',
    'The Provider shall deliver the work products and materials set out in each Statement of Work, in accordance with the timelines, quality standards and acceptance criteria specified therein.',
    'Fees for the Services shall be set out in each Statement of Work. Unless otherwise stated, fees are exclusive of applicable taxes. All amounts are due within thirty days of the invoice date.',
    'Each party represents that the individual signing below is duly authorized to enter into this Master Services Agreement on its behalf.',
  ];

  for (let i = 0; i < 6; i++) {
    const p = pdf.addPage([612, 792]);
    p.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.961, 0.953, 0.929) });
    const ink = rgb(0.145, 0.165, 0.18);
    const text = (s: string, x: number, y: number, size = 13, font = roman) =>
      p.drawText(s, { x, y, size, font, color: ink });
    const line = (y: number) =>
      p.drawLine({
        start: { x: 55, y },
        end: { x: 557, y },
        thickness: 0.5,
        color: rgb(0.6, 0.61, 0.6),
      });
    const paragraph = (s: string, y: number) => {
      let row = '';
      let pos = y;
      for (const word of s.split(' ')) {
        if (roman.widthOfTextAtSize(`${row} ${word}`, 14) > 490) {
          text(row, 55, pos, 14);
          pos -= 23;
          row = word;
        } else {
          row += (row ? ' ' : '') + word;
        }
      }
      text(row, 55, pos, 14);
    };

    text('H A L V O R S E N', 55, 728, 17, bold);
    text('Master Services Agreement', 55, 700, 15, italic);
    text(String(i + 1).padStart(2, '0'), 534, 700, 14);
    line(678);
    text(`${i * 2 + 1}. ${sections[i][0]}`, 55, 621, 23, bold);
    paragraph(descriptions[i === 0 ? 0 : i === 1 ? 2 : 0], 583);
    text(`${i * 2 + 2}. ${sections[i][1]}`, 55, 425, 23, bold);
    paragraph(descriptions[i === 1 ? 3 : 1], 387);

    if (i === 1) {
      text('J. Halvorsen', 55, 238, 27, italic);
      line(224);
      text('Jonh Halvorsen - Chief Executive Officer', 55, 203, 12);
      text('E. Varga', 55, 143, 27, italic);
      line(129);
      text('Elena Varga - Head of Procurement', 55, 109, 12);
    }

    line(65);
    text('HALVORSEN MARITIME AS  /  PRIVATE & CONFIDENTIAL', 55, 45, 8);
    text(String(i + 1).padStart(2, '0'), 543, 45, 9);
  }
  return pdf.save();
}

export async function sampleEarningsPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const serifItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  const months = [
    {
      period: 'May 1, 2026 - May 31, 2026',
      payDate: 'May 29, 2026',
      monthLabel: 'May 2026',
      retainer: '$8,500.00',
      milestone: '$2,400.00',
      gross: '$10,900.00',
      tax: '$2,180.00',
      net: '$8,720.00',
    },
    {
      period: 'June 1, 2026 - June 30, 2026',
      payDate: 'June 30, 2026',
      monthLabel: 'June 2026',
      retainer: '$8,500.00',
      milestone: '$3,100.00',
      gross: '$11,600.00',
      tax: '$2,320.00',
      net: '$9,280.00',
    },
    {
      period: 'July 1, 2026 - July 31, 2026',
      payDate: 'July 31, 2026',
      monthLabel: 'July 2026',
      retainer: '$8,500.00',
      milestone: '$2,900.00',
      gross: '$11,400.00',
      tax: '$2,280.00',
      net: '$9,120.00',
    },
  ];

  for (let i = 0; i < months.length; i += 1) {
    const m = months[i];
    const p = pdf.addPage([612, 792]);
    p.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.961, 0.953, 0.929) });

    const ink = rgb(0.145, 0.169, 0.188);
    const muted = rgb(0.38, 0.42, 0.46);
    const rule = (y: number, weight = 0.6) =>
      p.drawLine({
        start: { x: 54, y },
        end: { x: 558, y },
        thickness: weight,
        color: rgb(0.72, 0.71, 0.67),
      });

    p.drawText('NORTHWIND ADVISORY PARTNERS', { x: 54, y: 730, size: 13, font: bold, color: ink });
    p.drawText('Monthly Compensation & Earnings Statement', {
      x: 54,
      y: 708,
      size: 13.5,
      font: serifItalic,
      color: muted,
    });
    p.drawText(`Page 0${i + 1} / 03`, { x: 492, y: 730, size: 10, font: sans, color: muted });
    rule(690, 0.9);

    p.drawText('Recipient', { x: 54, y: 660, size: 9.5, font: bold, color: muted });
    p.drawText('Clara Lindqvist — Principal Strategy Advisor', {
      x: 54,
      y: 643,
      size: 12,
      font: bold,
      color: ink,
    });

    p.drawText('Statement Period', { x: 340, y: 660, size: 9.5, font: bold, color: muted });
    p.drawText(m.period, { x: 340, y: 643, size: 11.5, font: sans, color: ink });

    p.drawText('Disbursement Date', { x: 340, y: 615, size: 9.5, font: bold, color: muted });
    p.drawText(m.payDate, { x: 340, y: 598, size: 11.5, font: sans, color: ink });

    p.drawText('Account Reference', { x: 54, y: 615, size: 9.5, font: bold, color: muted });
    p.drawText('NW-8841-SEK', { x: 54, y: 598, size: 11.5, font: sans, color: ink });

    rule(574, 0.7);

    p.drawText(`EARNINGS BREAKDOWN — ${m.monthLabel.toUpperCase()}`, {
      x: 54,
      y: 546,
      size: 10.5,
      font: bold,
      color: ink,
    });
    p.drawText('AMOUNT (USD)', { x: 472, y: 546, size: 10, font: bold, color: muted });
    rule(534, 0.5);

    p.drawText('Base Advisory Retainer', { x: 54, y: 506, size: 11.5, font: sans, color: ink });
    p.drawText(m.retainer, { x: 482, y: 506, size: 11.5, font: sans, color: ink });

    p.drawText('Performance & Delivery Bonus', { x: 54, y: 476, size: 11.5, font: sans, color: ink });
    p.drawText(m.milestone, { x: 482, y: 476, size: 11.5, font: sans, color: ink });

    rule(456, 0.5);
    p.drawText('Gross Monthly Earnings', { x: 54, y: 432, size: 12, font: bold, color: ink });
    p.drawText(m.gross, { x: 476, y: 432, size: 12, font: bold, color: ink });

    p.drawText('Estimated Tax Withholding (20%)', { x: 54, y: 398, size: 11.5, font: sans, color: muted });
    p.drawText(m.tax, { x: 482, y: 398, size: 11.5, font: sans, color: muted });

    rule(378, 0.8);
    p.drawText(`Net Payout — ${m.monthLabel}`, { x: 54, y: 350, size: 13.5, font: bold, color: ink });
    p.drawText(m.net, { x: 472, y: 350, size: 13.5, font: bold, color: ink });

    if (i === 2) {
      rule(304, 0.7);
      p.drawText('THREE-MONTH CUMULATIVE SUMMARY (MAY 2026 – JULY 2026)', {
        x: 54,
        y: 276,
        size: 10.5,
        font: bold,
        color: ink,
      });
      p.drawText('Total Gross Earnings (3 Months)', { x: 54, y: 244, size: 11.5, font: sans, color: ink });
      p.drawText('$33,900.00', { x: 476, y: 244, size: 11.5, font: bold, color: ink });

      p.drawText('Total Tax Withholding (3 Months)', { x: 54, y: 218, size: 11.5, font: sans, color: muted });
      p.drawText('$6,780.00', { x: 482, y: 218, size: 11.5, font: sans, color: muted });

      p.drawText('Total Net Disbursed (3 Months)', { x: 54, y: 188, size: 12.5, font: bold, color: ink });
      p.drawText('$27,120.00', { x: 472, y: 188, size: 12.5, font: bold, color: ink });
    }

    rule(66, 0.5);
    p.drawText('NORTHWIND ADVISORY PARTNERS LLC  ·  VERIFIED COMPENSATION RECORD', {
      x: 54,
      y: 46,
      size: 8,
      font: sans,
      color: muted,
    });
  }

  return pdf.save();
}

async function samplePagePaperRgb(
  pdf: PDFDocumentProxy,
  pageNum: number,
): Promise<[number, number, number]> {
  try {
    const page = await pdf.getPage(pageNum);
    const vp = page.getViewport({ scale: 0.25 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(8, Math.floor(vp.width));
    canvas.height = Math.max(8, Math.floor(vp.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return [0.961, 0.953, 0.929];
    await page.render({ canvas, viewport: vp }).promise;
    const samplePts: [number, number][] = [
      [3, 3],
      [canvas.width - 4, 3],
      [3, canvas.height - 4],
    ];
    let r = 0;
    let g = 0;
    let b = 0;
    for (const [sx, sy] of samplePts) {
      const px = ctx.getImageData(
        Math.max(0, Math.min(canvas.width - 1, sx)),
        Math.max(0, Math.min(canvas.height - 1, sy)),
        1,
        1,
      ).data;
      r += px[0] / 255;
      g += px[1] / 255;
      b += px[2] / 255;
    }
    canvas.width = 0;
    canvas.height = 0;
    return [
      Number((r / samplePts.length).toFixed(3)),
      Number((g / samplePts.length).toFixed(3)),
      Number((b / samplePts.length).toFixed(3)),
    ];
  } catch {
    return [0.961, 0.953, 0.929];
  }
}

export async function extractDocumentStructure(
  pdf: PDFDocumentProxy,
): Promise<ExtractedDocumentStructure> {
  if (pdf.numPages > 50) throw new Error('Editing supports at most 50 pages. No pages were omitted.');
  const maxPages = pdf.numPages;
  const pages: ExtractedPageStructure[] = [];

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    try {
      const page = await pdf.getPage(pageNum);
      const vp = page.getViewport({ scale: 1 });
      if (page.rotate !== 0 || page.view[0] !== 0 || page.view[1] !== 0) throw new Error('Rotated or cropped source pages require a normalized plain PDF copy before text editing.');
      const content = await page.getTextContent();
      const paperBg = await samplePagePaperRgb(pdf, pageNum);
      const styles = content.styles as Record<string, { fontFamily?: string }> | undefined;

      interface RawPiece {
        str: string;
        x: number;
        y: number;
        w: number;
        h: number;
        fontSize: number;
        fontName: string;
        fontFamily: string;
      }

      const pieces: RawPiece[] = [];
      for (const item of content.items) {
        if (!('str' in item) || typeof item.str !== 'string') continue;
        const text = item.str;
        if (!text.trim()) continue;
        const tx = Number(item.transform?.[4] ?? 48);
        const ty = Number(item.transform?.[5] ?? vp.height / 2);
        const scaleY = Math.abs(Number(item.transform?.[3] || item.transform?.[0] || 11.5));
        const fontSize = Math.max(6.5, Math.min(42, scaleY));
        const w = Math.max(Number(item.width || 0), fontSize * text.length * 0.48);
        const h = Math.max(Number(item.height || 0), fontSize * 1.18);
        const fontName = String(item.fontName || '');
        const fontFamily = String(styles?.[fontName]?.fontFamily || '');
        pieces.push({ str: text, x: tx, y: ty, w, h, fontSize, fontName, fontFamily });
      }

      // Sort top-to-bottom (higher PDF y first), then left-to-right
      pieces.sort((a, b) => {
        if (Math.abs(b.y - a.y) > 3.4) return b.y - a.y;
        return a.x - b.x;
      });

      // Group into visual rows first
      const rows: RawPiece[][] = [];
      for (const piece of pieces) {
        const lastRow = rows[rows.length - 1];
        if (lastRow && Math.abs(lastRow[0].y - piece.y) <= 3.4) {
          lastRow.push(piece);
        } else {
          rows.push([piece]);
        }
      }

      const lines: string[] = [];
      const spans: ExtractedTextSpan[] = [];

      for (const row of rows) {
        row.sort((a, b) => a.x - b.x);
        lines.push(row.map((r) => r.str.trim()).join('  '));

        // Merge adjacent kerning pieces (< 14pt horizontal gap) into clean addressable cells
        const mergedCells: RawPiece[] = [];
        for (const piece of row) {
          const prev = mergedCells[mergedCells.length - 1];
          if (prev) {
            const prevRight = prev.x + prev.w;
            const gap = piece.x - prevRight;
            if (gap >= -3 && gap < 14) {
              const needsSpace =
                gap > prev.fontSize * 0.2 &&
                !prev.str.endsWith(' ') &&
                !piece.str.startsWith(' ');
              prev.str = `${prev.str}${needsSpace ? ' ' : ''}${piece.str}`;
              prev.w = Math.max(prev.w, piece.x + piece.w - prev.x);
              prev.h = Math.max(prev.h, piece.h);
              continue;
            }
          }
          mergedCells.push({ ...piece });
        }

        for (let cellIdx = 0; cellIdx < mergedCells.length; cellIdx += 1) {
          const cell = mergedCells[cellIdx];
          const cleanText = cell.str.trim();
          if (!cleanText) continue;
          const nextCell = mergedCells[cellIdx + 1];
          const availableWidth = nextCell
            ? Math.max(cell.w, nextCell.x - cell.x - 8)
            : Math.max(cell.w, vp.width - 28 - cell.x);
          const descriptor = `${cell.fontName} ${cell.fontFamily}`.toLowerCase();
          const isBold = /bold|black|demi|semibold|heavy/.test(descriptor);
          const isItalic = /italic|oblique/.test(descriptor);
          const isSerif = /times|georgia|garamond|serif|roman|minion|baskerville/.test(descriptor);

          const normX = Math.max(0.02, Math.min(0.94, (cell.x - 4) / vp.width));
          const yTop = vp.height - cell.y - cell.h * 0.86;
          const normY = Math.max(0.02, Math.min(0.95, yTop / vp.height));
          const normW = Math.max(0.06, Math.min(0.96 - normX, (cell.w + 10) / vp.width));
          const normH = Math.max(0.026, Math.min(0.2, (cell.h + 8) / vp.height));

          spans.push({
            page: pageNum,
            text: cleanText,
            bbox: [normX, normY, normW, normH],
            pdfRect: {
              x: Number(cell.x.toFixed(2)),
              y: Number(cell.y.toFixed(2)),
              width: Number(cell.w.toFixed(2)),
              maxWidth: Number(availableWidth.toFixed(2)),
              height: Number(cell.h.toFixed(2)),
              fontSize: Number(cell.fontSize.toFixed(2)),
              isBold,
              isItalic,
              isSerif,
              paperBg,
              inkRgb: [0.145, 0.169, 0.188],
            },
          });
        }
      }

      pages.push({
        page: pageNum,
        width: vp.width,
        height: vp.height,
        paperBg,
        lines,
        spans,
      });
    } catch (error) {
      throw new Error(`Page ${pageNum} could not be analyzed safely. ${error instanceof Error ? error.message : 'Try a plain PDF copy.'}`);
    }
  }

  return {
    totalPages: pdf.numPages,
    pages,
  };
}

export function toPageTextSnapshots(structure: ExtractedDocumentStructure): PageTextSnapshot[] {
  return structure.pages.map((p) => ({
    page: p.page,
    lines: p.lines,
  }));
}

export function attachCoordinatesToOperations(
  structure: ExtractedDocumentStructure,
  operations: ApprovedEditOperation[],
): ApprovedEditOperation[] {
  const validated = validateOperations(operations, structure.totalPages);
  return validated.map((op) => {
    if (op.kind !== 'text') return op;
    const page = structure.pages.find(p => p.page === op.page);
    const matches = page?.spans.filter(s => s.text === op.find) || [];
    // A full exact cell must also be unique as a substring on this page because the engine uses string matching.
    const occurrences = page?.spans.reduce((n, s) => n + s.text.toLowerCase().split(op.find.toLowerCase()).length - 1, 0) || 0;
    if (matches.length !== 1 || occurrences !== 1) throw new Error(`The requested text on page ${op.page} is missing or repeated. Specify a unique exact text cell; no occurrence was guessed.`);
    const span = matches[0];
    return { ...op, bbox: span.bbox, pdfRect: span.pdfRect };
  });
}

export async function buildInteractivePreviewPdf(
  sourceBytes: Uint8Array,
  operations: ApprovedEditOperation[],
): Promise<Uint8Array> {
  if (operations.length === 0) return sourceBytes.slice();

  const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false });
  validateOperations(operations, doc.getPageCount());
  for (const key of ['AcroForm', 'Outlines', 'StructTreeRoot', 'Names', 'OpenAction', 'AA', 'Perms', 'OCProperties']) {
    if (doc.catalog.has(PDFName.of(key))) throw new Error('This PDF has advanced features that cannot yet be preserved safely. Use a plain PDF copy.');
  }
  if (doc.getPages().some(p => p.node.Annots()?.size())) throw new Error('Annotations and linked PDFs are not supported for safe editing yet.');
  const sansRegular = await doc.embedFont(StandardFonts.Helvetica);
  const sansBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const serifRegular = await doc.embedFont(StandardFonts.TimesRoman);
  const serifBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const serifItalic = await doc.embedFont(StandardFonts.TimesRomanItalic);

  const textOps = operations.filter((op) => !op.kind || op.kind === 'text');
  const structuralOps = operations.filter((op) => op.kind && op.kind !== 'text').sort((a, b) => b.page - a.page);

  for (const op of textOps) {
    const pageIdx = op.page - 1;
    if (pageIdx < 0 || pageIdx >= doc.getPageCount()) throw new Error('Invalid page in the draft.');
    const page = doc.getPage(pageIdx);
    const { width: pageW, height: pageH } = page.getSize();
    const rect = op.pdfRect;
    const bbox = op.bbox;
    if (!rect) throw new Error('This edit has no verified text position. Please clarify it before previewing.');

    const font = rect?.isSerif
      ? rect.isBold
        ? serifBold
        : rect.isItalic
          ? serifItalic
          : serifRegular
      : rect?.isBold
        ? sansBold
        : sansRegular;

    let x = 48;
    let y = pageH / 2;
    let w = 160;
    let fontSize = 11.5;

    if (rect) {
      x = rect.x;
      y = rect.y;
      fontSize = rect.fontSize;
      w = Math.max(rect.width, font.widthOfTextAtSize(op.find || op.replace, fontSize));
    } else if (bbox) {
      x = bbox[0] * pageW;
      const boxH = Math.max(11, bbox[3] * pageH * 0.78);
      fontSize = Math.max(8.5, Math.min(22, boxH * 0.8));
      y = pageH - (bbox[1] + bbox[3]) * pageH + fontSize * 0.22;
      w = Math.max(bbox[2] * pageW, font.widthOfTextAtSize(op.find || op.replace, fontSize));
    }

    const replacementWidth = font.widthOfTextAtSize(op.replace, fontSize);
    const maxAllowedWidth = rect?.maxWidth !== undefined ? Math.max(w, rect.maxWidth) : w;
    if (replacementWidth > maxAllowedWidth + 2 || x + replacementWidth > pageW - 12 || y < 0 || y > pageH) throw new Error(`The replacement on page ${op.page} does not fit its original text cell. Shorten it or use a layout-capable editor.`);
    const bg = rect?.paperBg || [0.961, 0.953, 0.929];
    const ink = rect?.inkRgb || [0.145, 0.169, 0.188];
    const eraseWidth = rect ? Math.max(rect.width, font.widthOfTextAtSize(op.find, fontSize)) : w;

    page.drawRectangle({
      x: Math.max(0, x - 1.5),
      y: Math.max(0, y - fontSize * 0.26),
      width: Math.min(pageW - x + 2, eraseWidth + 4),
      height: fontSize * 1.32,
      color: rgb(bg[0], bg[1], bg[2]),
    });

    if (op.replace.trim().length > 0) {
      page.drawText(op.replace, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(ink[0], ink[1], ink[2]),
      });
    }
  }

  for (const sOp of structuralOps) {
    const count = doc.getPageCount();
    const idx = sOp.page - 1;
    if (sOp.kind === 'clone_page' && count > 0) {
      const [cloned] = await doc.copyPages(doc, [idx]);
      doc.insertPage(idx + 1, cloned);
    } else if (sOp.kind === 'rotate_page' && count > 0) {
      const pg = doc.getPage(idx);
      pg.setRotation(degrees((pg.getRotation().angle + (sOp.rotateDegrees || 90)) % 360));
    } else if (sOp.kind === 'delete_page' && count > 1) {
      doc.removePage(idx);
    }
  }

  return doc.save();
}

export async function renderPageToBudgetedDataUrl(
  pdf: PDFDocumentProxy,
  pageNum: number,
  maxBytes = 580_000,
): Promise<string | null> {
  if (pageNum < 1 || pageNum > pdf.numPages) return null;
  try {
    const page = await pdf.getPage(pageNum);
    const ladder: ReadonlyArray<{ scale: number; quality: number }> = [
      { scale: 1.45, quality: 0.82 },
      { scale: 1.2, quality: 0.76 },
      { scale: 0.95, quality: 0.7 },
      { scale: 0.75, quality: 0.62 },
    ];

    for (const step of ladder) {
      const vp = page.getViewport({ scale: step.scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(64, Math.floor(vp.width));
      canvas.height = Math.max(64, Math.floor(vp.height));
      await page.render({ canvas, viewport: vp }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', step.quality);
      canvas.width = 0;
      canvas.height = 0;
      if (dataUrl.length <= maxBytes) {
        return dataUrl;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchServerTemplatePdfBytes(
  apiBase: string,
  tpl: TemplateItem,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const cleanTarget = tpl.targets?.find(
    (t) => t && t.trim().length >= 2 && !/\s+(?:to|with)\s+/i.test(t),
  );
  const instruction = cleanTarget
    ? `change "${cleanTarget}" to "${cleanTarget}"`
    : 'rotate page 1 360';

  const created = await createJob(
    apiBase,
    { template: tpl.key, instruction },
    signal,
  );
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    await new Promise((r) => window.setTimeout(r, 650));
    const job = await getJob(apiBase, created.job_id, signal);
    if (job.status === 'done') {
      const url = resolveJobPdfUrl(apiBase, job);
      const fetched = await fetchPdfBytes(url, signal);
      return fetched?.bytes || null;
    }
    if (['refused', 'error', 'aborted'].includes(job.status)) {
      return null;
    }
  }
  return null;
}

function extractSearchCandidates(instruction: string, results?: EditResult[]): string[] {
  const candidates: string[] = [];
  if (results) {
    for (const r of results) {
      if (r.find && r.find.trim()) candidates.push(r.find.trim());
      if (r.replace && r.replace.trim()) candidates.push(r.replace.trim());
    }
  }
  const quoted = instruction.matchAll(/["“”'‘’]([^"“”'‘’]{2,120})["“”'‘’]/g);
  for (const m of quoted) {
    if (m[1]?.trim()) candidates.push(m[1].trim());
  }
  const unquoted = instruction.match(/(?:change|replace)\s+(.+?)\s+(?:to|with)\s+(.+?)(?:;|$)/i);
  if (unquoted?.[1]) candidates.push(unquoted[1].trim().replace(/^["']|["']$/g, ''));
  return Array.from(new Set(candidates.filter((c) => c.length >= 2)));
}

export async function locateTargetOnPdf(
  pdf: PDFDocumentProxy,
  instruction: string,
  results?: EditResult[],
): Promise<TargetRegion | null> {
  const pageMatch = instruction.match(/\bpage\s+(\d+)\b/i);
  const explicitPage = pageMatch ? Number(pageMatch[1]) : undefined;
  const terms = extractSearchCandidates(instruction, results);

  if (terms.length > 0) {
    const pagesToScan =
      explicitPage && explicitPage >= 1 && explicitPage <= pdf.numPages
        ? [explicitPage]
        : Array.from({ length: Math.min(pdf.numPages, 50) }, (_, idx) => idx + 1);

    for (const pageNum of pagesToScan) {
      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        for (const term of terms) {
          const needle = term.toLowerCase();
          for (const raw of content.items) {
            if (!('str' in raw) || typeof raw.str !== 'string') continue;
            if (!raw.str.toLowerCase().includes(needle)) continue;
            const tx = Number(raw.transform?.[4] ?? 48);
            const ty = Number(raw.transform?.[5] ?? viewport.height / 2);
            const itemW = Math.max(
              Number(raw.width || 0),
              Math.abs(Number(raw.transform?.[0] || 12)) * term.length * 0.55,
            );
            const itemH = Math.max(
              Number(raw.height || 0),
              Math.abs(Number(raw.transform?.[3] || 14)) * 1.35,
            );

            const x = Math.max(0.03, Math.min(0.9, (tx - 6) / viewport.width));
            const yTop = viewport.height - ty - itemH * 0.88;
            const y = Math.max(0.03, Math.min(0.92, yTop / viewport.height));
            const w = Math.max(0.12, Math.min(0.94 - x, (itemW + 14) / viewport.width));
            const h = Math.max(0.038, Math.min(0.22, (itemH + 10) / viewport.height));
            return {
              page: pageNum,
              bbox: [x, y, w, h],
              label:
                results?.[0]?.replace && results[0].find
                  ? `${results[0].find} → ${results[0].replace}`
                  : term,
            };
          }
        }
      } catch {
        // Ignore text-extraction errors on individual pages.
      }
    }
  }

  if (explicitPage && explicitPage >= 1 && explicitPage <= pdf.numPages) {
    return {
      page: explicitPage,
      bbox: [0.07, 0.07, 0.86, 0.86],
    };
  }

  return null;
}
