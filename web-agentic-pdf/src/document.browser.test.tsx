import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { attachCoordinatesToOperations, buildInteractivePreviewPdf, getDocument, type ExtractedDocumentStructure } from './document';
const structure: ExtractedDocumentStructure = { totalPages: 2, pages: [1, 2].map(page => ({ page, width: 612, height: 792, paperBg: [1, 1, 1], lines: [], spans: [{ page, text: page === 1 ? 'Unique' : 'Elsewhere', bbox: [.1, .1, .2, .1], pdfRect: { x: 60, y: 600, width: 100, height: 16, fontSize: 12 } }] })) };
const edit = { id: 'a', kind: 'text' as const, page: 1, find: 'Elsewhere', replace: 'New', plainSummary: 'Change text' };
describe('Safe PDF drafts', () => {
  it('never moves an unmatched edit to another page', () => { expect(() => attachCoordinatesToOperations(structure, [edit])).toThrow(); });
  it('rejects repeated exact targets instead of choosing the first', () => {
    const duplicate = structuredClone(structure); duplicate.pages[0].spans.push(structuredClone(duplicate.pages[0].spans[0]));
    expect(() => attachCoordinatesToOperations(duplicate, [{ ...edit, find: 'Unique' }])).toThrow();
  });
  it('rejects substring and case-insensitive substitutions', () => {
    for (const find of ['Uni', 'unique']) expect(() => attachCoordinatesToOperations(structure, [{ ...edit, find }])).toThrow();
  });
  it('rejects a target that also appears with different case in another cell', () => {
    const duplicate = structuredClone(structure); duplicate.pages[0].spans.push({ ...duplicate.pages[0].spans[0], text: 'UNIQUE' });
    expect(() => attachCoordinatesToOperations(duplicate, [{ ...edit, find: 'Unique' }])).toThrow();
  });
  it('applies structural actions to original page numbers', async () => {
    const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 4; n++) pdf.addPage([400 + n, 600]).drawText(`Original page ${n}`, { x: 50, y: 500, font });
    const bytes = await buildInteractivePreviewPdf(await pdf.save(), [
      { ...edit, kind: 'delete_page', find: '', replace: '', page: 1 },
      { ...edit, id: 'b', kind: 'clone_page', find: '', replace: '', page: 3 },
    ]);
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPages().map(p => p.getWidth())).toEqual([402, 403, 403, 404]);
    const rendered = await getDocument({ data: bytes.slice() }).promise;
    const labels = [];
    for (let n = 1; n <= rendered.numPages; n++) labels.push((await (await rendered.getPage(n)).getTextContent()).items.map(i => 'str' in i ? i.str : '').join(''));
    expect(labels).toEqual(['Original page 2', 'Original page 3', 'Original page 3', 'Original page 4']);
    await rendered.loadingTask.destroy();
  });
});
