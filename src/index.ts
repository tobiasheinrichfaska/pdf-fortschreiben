/** pdf-fortschreiben: append revisions to a PDF, attach files, add document time stamps, read them back. */
import { PdfFile, Update, writeUpdate } from './document.ts';
import { guard, unwrap, type Result } from './errors.ts';

export { PdfFile, Update, writeUpdate, type Revision, type Written } from './document.ts';
export {
  attachFile,
  attachmentChanges,
  readAttachments,
  type Attachment,
  type ReadAttachmentsOptions,
  type AttachmentChange,
  type FoundAttachment,
  type Relationship,
  type StreamCache,
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
export {
  name,
  ref,
  raw,
  hex,
  dict,
  latin1,
  textString,
  isDict,
  isRef,
  isName,
  isStringLike,
  hexText,
  TextSink,
  type PdfName,
  type PdfString,
  type PdfHex,
  type PdfRef,
  type PdfDict,
  type PdfRaw,
  type PdfObject,
  type PdfStream,
} from './objects.ts';
export {
  PdfError,
  type Failure,
  type FailureCode,
  type PdfLibFailure,
  type ReadFailure,
  type Result,
  type UsageFailure,
} from './errors.ts';
export { sha256Bytes } from './sha256.ts';

/**
 * Appends one revision built by `build`; the bytes before it stay as they are. `build` may return a
 * failed `Result` (e.g. from `attachFile`) to stop: nothing is written then. A `PdfError` thrown by a low-level
 * accessor inside `build` (`file.object`, `update.add`, ...) is returned as a failure; any other error is
 * the caller's and passes through.
 */
export function appendRevision(
  pdf: Uint8Array,
  build: (file: PdfFile, update: Update) => Result<unknown> | void,
): Result<Uint8Array> {
  return guard(() => {
    const file = unwrap(PdfFile.open(pdf));
    const update = new Update(file);
    const stop = build(file, update);
    if (stop !== undefined) unwrap(stop);
    return unwrap(writeUpdate(file, update)).bytes;
  });
}
