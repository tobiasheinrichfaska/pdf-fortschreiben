/** pdf-fortschreiben: append revisions to a PDF, attach files, add document time stamps, read them back. */
import { PdfFile, Update, writeUpdate } from './document.ts';

export { PdfFile, Update, writeUpdate, type Revision, type Written } from './document.ts';
export {
  attachFile,
  readAttachments,
  type Attachment,
  type FoundAttachment,
  type Relationship,
} from './attach.ts';
export {
  appendDocTimeStamp,
  findDocTimeStamps,
  derLength,
  rangeDigest,
  type FoundTimeStamp,
  type StampOptions,
  type Stamper,
} from './timestamp.ts';
export * from './objects.ts';
export { PdfReadError, type ReadFailure } from './parse.ts';
export { sha256Bytes } from './sha256.ts';

/** Appends one revision built by `build`; the bytes before it stay as they are. */
export function appendRevision(
  pdf: Uint8Array,
  build: (file: PdfFile, update: Update) => void,
): Uint8Array {
  const file = new PdfFile(pdf);
  const update = new Update(file);
  build(file, update);
  return writeUpdate(file, update).bytes;
}
