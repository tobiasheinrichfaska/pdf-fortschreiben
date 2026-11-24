import { PDFDocument, StandardFonts } from 'pdf-lib';

/** A small PDF as pdf-lib writes it with a classic cross-reference table (what the library accepts). */
export async function basePdf(pages = 1, objectStreams = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Seite ${i + 1}`, { x: 50, y: 780, size: 14, font });
  }
  doc.setTitle('Test');
  doc.setCreationDate(new Date('2026-11-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-11-01T00:00:00Z'));
  return doc.save({ useObjectStreams: objectStreams });
}

/** A stand-in "token": one DER OCTET STRING holding the digest (checks the plumbing, proves nothing). */
export const fakeStamper =
  (seen: Uint8Array[] = []) =>
  async (digest: Uint8Array): Promise<Uint8Array> => {
    seen.push(digest);
    return Uint8Array.from([0x04, digest.length, ...digest]);
  };

export const text = (s: string): Uint8Array => new TextEncoder().encode(s);
export const ascii = (b: Uint8Array): string => String.fromCharCode(...b);
