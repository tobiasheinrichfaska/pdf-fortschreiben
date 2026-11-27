import {
  appendDocTimeStamp,
  appendRevision,
  dict,
  findDocTimeStamps,
  hex,
  latin1,
  name,
  raw,
} from '../src/index.ts';
import { ascii, basePdf, fakeStamper, must, open } from './helpers.ts';

/**
 * Revision 1 holds a 64-byte hex string; revision 2 adds a DocTimeStamp whose /ByteRange leaves out that
 * string (not its own /Contents) and ends at revision 1.
 */
async function excludingForeignHex(): Promise<{ pdf: Uint8Array; gapAt: number }> {
  const r1 = must(
    appendRevision(await basePdf(), (_f, u) => {
      u.add(dict({ Note: hex(new Uint8Array(64).fill(0xab)) }));
    }),
  );
  const gapAt = ascii(r1).indexOf('<' + 'AB'.repeat(64) + '>');
  expect(gapAt).toBeGreaterThan(0);
  const b = gapAt;
  const c = gapAt + 130;
  const file1 = open(r1);
  const endAt = file1.revisions[file1.revisions.length - 1]!.end + 1; // with the line end
  const token = new Uint8Array(64);
  token[0] = 0x04;
  token[1] = 62;
  const pdf = must(
    appendRevision(r1, (f, u) => {
      const sig = u.add(
        dict({
          Type: name('DocTimeStamp'),
          Filter: name('Adobe.PPKLite'),
          SubFilter: name('ETSI.RFC3161'),
          ByteRange: [0, b, c, endAt - c],
          Contents: hex(token),
        }),
      );
      const widget = u.add(dict({ FT: name('Sig'), T: latin1('Gefälscht'), V: sig }));
      const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
      cat.entries.set('AcroForm', dict({ Fields: [widget], SigFlags: 3 }));
      u.set(f.rootRef, cat);
    }),
  );
  return { pdf, gapAt };
}

describe('document time stamp range (exact /Contents of its own dictionary)', () => {
  it('a range that leaves out a hex string of an earlier revision is not rangeOk', async () => {
    const { pdf, gapAt } = await excludingForeignHex();
    const [t] = must(findDocTimeStamps(pdf));
    expect(t!.rangeOk).toBe(false);
    // the excluded bytes can be changed without changing the digest: that is why it must not pass
    const changed = pdf.slice();
    changed[gapAt + 1] = 'C'.charCodeAt(0);
    const [t2] = must(findDocTimeStamps(changed));
    expect(t2!.digest).toEqual(t!.digest);
    expect(t2!.rangeOk).toBe(false);
  });

  it('a stamp object written in an earlier revision than the one the range ends at is not rangeOk', async () => {
    // Revision 1 writes the stamp dictionary (not yet referenced), revision 2 the field; the range
    // leaves out exactly that /Contents but reaches the end of revision 2.
    let sigNum = 0;
    const r1 = must(
      appendRevision(await basePdf(), (_f, u) => {
        sigNum = u.add(
          dict({
            Type: name('DocTimeStamp'),
            SubFilter: name('ETSI.RFC3161'),
            ByteRange: raw('[' + ' '.repeat(34) + ']'),
            Contents: hex(Uint8Array.from([0x04, 0x02, 1, 2])),
          }),
        ).num;
      }),
    );
    const r2 = must(
      appendRevision(r1, (f, u) => {
        const widget = u.add(
          dict({ FT: name('Sig'), T: latin1('Früher'), V: { t: 'ref', num: sigNum, gen: 0 } }),
        );
        const cat = { t: 'dict' as const, entries: new Map(f.catalog.entries) };
        cat.entries.set('AcroForm', dict({ Fields: [widget], SigFlags: 3 }));
        u.set(f.rootRef, cat);
      }),
    );
    const text = ascii(r2);
    const b = text.indexOf('<04020102>');
    const c = b + 10;
    const endAt = open(r2).revisions[2]!.end + 1;
    const br = `[0 ${b} ${c} ${endAt - c}]`.padEnd(36, ' ');
    const at = text.indexOf('[' + ' '.repeat(34) + ']');
    const pdf = r2.slice();
    for (let i = 0; i < br.length; i++) pdf[at + i] = br.charCodeAt(i);
    const [t] = must(findDocTimeStamps(pdf));
    expect(t!.byteRange).toEqual([0, b, c, endAt - c]);
    expect(t!.revision).toBe(2);
    expect(t!.rangeOk).toBe(false);
  });

  it('genuine stamps still pass', async () => {
    const s1 = must(await appendDocTimeStamp(await basePdf(), fakeStamper(), { reserve: 1024 }));
    const s2 = must(await appendDocTimeStamp(s1, fakeStamper(), { reserve: 1024 }));
    expect(must(findDocTimeStamps(s2)).map((t) => [t.revision, t.rangeOk])).toEqual([
      [1, true],
      [2, true],
    ]);
  });
});
