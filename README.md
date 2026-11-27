# pdf-fortschreiben

Ein PDF **fortschreiben, ohne es neu zu bauen**: jede Änderung wird als neue Revision ans Dateiende gehängt,
die früheren Bytes bleiben Byte für Byte gleich. Dazu kommen Dateianhänge (PDF/A-3 „associated files“) und
**Dokument-Zeitstempel** (RFC 3161, PAdES `ETSI.RFC3161`) über den jeweiligen Gesamtstand – ohne Schlüssel
und ohne Zertifikat des Schreibenden.

**Stand: 0.1.0, mit Build** (`dist/`, beim Git-Install von `prepare` gebaut). Eigenes Repository. Nicht auf
npm; Tag `v0.1.0` freigegeben, noch nicht gepusht. Nicht von einem Menschen sicherheitsgeprüft, nur unter Node
getestet, nicht nach PDF/A validiert.

## Einbinden

```bash
npm install github:tobiasheinrichfaska/pdf-fortschreiben#v0.1.0
npm install pdf-lib@1.17.1   # nur für den Eingang `pdf-fortschreiben/pdflib`
```

Beim Git-Install baut `prepare` das Verzeichnis `dist/` (JavaScript und Typen); `npm run build` baut es im
Repository. Fehlt TypeScript (`--omit=dev`), überspringt `prepare` den Bau mit einer Zeile auf stderr; ein
Typfehler bricht den Bau laut ab.

## Benutzen

```ts
import {
  appendRevision,
  attachFile,
  appendDocTimeStamp,
  findDocTimeStamps,
  attachmentChanges,
} from 'pdf-fortschreiben';

// Jede öffentliche Funktion gibt ein Result zurück: { ok: true, value } oder { ok: false, code, detail }.
// 1. Tagesstand: neuer Anhang mit neuem Namen (nur hinzufügen; ein vergebener Name wird abgelehnt)
const r1 = appendRevision(pdf0, (file, update) =>
  attachFile(file, update, { name: 'monat-tag-03.json', data, mimeType: 'application/json' }),
);
if (!r1.ok) throw new Error(r1.code); // z. B. 'name-exists', 'encrypted', 'xref-stream'
// 2. Zeitstempel über den Gesamtstand; das Token holt die App (z. B. über den Zeitstempel-Weiterreicher)
const r2 = await appendDocTimeStamp(r1.value, async (sha256) => holeToken(sha256));
if (!r2.ok) throw new Error(r2.code); // z. B. 'stamper-failed', 'bad-token', 'token-too-large'
const pdf = r2.value;
// 3. Prüfen: jeder Stempel, den die Datei je hatte, mit Revision, Bereich und Hash
const stamps = findDocTimeStamps(pdf);
if (!stamps.ok) throw new Error(stamps.code);
for (const t of stamps.value) {
  if (t.error !== undefined || !t.rangeOk || !t.tokenOk)
    throw new Error(`Stempel ${t.field}: ${t.error ?? 'Bereich/Token'}`);
  prüfeToken(t.token, t.digest); // z. B. verifyTimestampToken
}
await attachmentChanges(pdf); // { ok: true, value: [] } = kein früherer Anhang später gelöscht, geändert (Namen, Bytes, MIME, AF) oder doppelt
```

### Fehler als Werte

Alle öffentlichen Funktionen (`appendRevision`, `writeUpdate`, `PdfFile.open`, `attachFile`, `readAttachments`,
`attachmentChanges`, `appendDocTimeStamp`, `findDocTimeStamps`, `prepareDrawnPages`, `appendDrawnPages`) werfen
nicht, sondern geben `Result<T>` zurück: `{ ok: true, value }` oder `{ ok: false, code, detail }`. `code` ist
ein fester Text (`FailureCode`) zum Verzweigen, `detail` nennt Objektnummern und Stellen für Menschen. Die Codes:

- **Lesen:** `syntax`, `no-startxref`, `xref-stream`, `object-stream`, `xref-loop`, `object-missing`,
  `object-mismatch`, `encrypted`, `linearized`.
- **Benutzung:** `bad-options`, `bad-name`, `bad-mime`, `name-exists`, `unsupported-name-tree`, `bad-af`,
  `empty-update`, `reserved-trailer-key`, `bad-reference`, `bad-object`, `no-revision`, `no-page`,
  `file-too-large`, `stamper-failed`, `bad-token`, `token-too-large`.
- **pdf-lib-Eingang:** `numbering`, `generation`, `changed-object`, `info-created`, `no-new-page`, `pages-changed`.

Der Rückruf von `appendRevision` darf ein fehlgeschlagenes `Result` (etwa von `attachFile`) zurückgeben: dann wird
nichts geschrieben und genau dieser Fehler kommt zurück. Die Zugriffe auf `PdfFile` und `Update` (`object`,
`pages`, `catalog`, `revisionBytes`, `add`, `set`) und die Bausteine für Objekte (`latin1`, `textString`,
`TextSink`) werfen weiter einen `PdfError` (mit demselben `code`); innerhalb des Rückrufs von `appendRevision`
wird er als Fehlschlag zurückgegeben. Fehler des Aufrufers (ein eigener `throw` im Rückruf oder im `draw`-Schritt)
laufen unverändert hindurch.

### Seiten mit pdf-lib zeichnen (Eingang `pdf-fortschreiben/pdflib`)

pdf-lib (1.17.1, optionale Peer-Abhängigkeit) zeichnet neue Seiten; angehängt werden nur die **neuen
Objekte** und die **geänderten Knoten des Seitenbaums**, als eine Revision. Andere Änderungen von pdf-lib
werden abgelehnt (Fehlercodes des pdf-lib-Eingangs, siehe oben), `/Info` wird nie übernommen. In derselben Revision können Anhänge folgen:

```ts
import { attachFile, writeUpdate } from 'pdf-fortschreiben';
import { prepareDrawnPages, reuseFont } from 'pdf-fortschreiben/pdflib';

const drawn = await prepareDrawnPages(pdf, async (doc) => {
  // Schrift der ersten Revision wiederverwenden (dort vollständig eingebettet, `subset: false`)
  const font = await reuseFont(doc, 'NotoSans-Regular', () =>
    CustomFontEmbedder.for(fontkit, schriftBytes, 'NotoSans-Regular'),
  );
  doc.addPage().drawText('Stand 03.', { x: 50, y: 780, size: 12, font });
});
if (!drawn.ok) throw new Error(drawn.code);
const { file, update } = drawn.value;
attachFile(file, update, { name: 'monat-tag-03.json', data, mimeType: 'application/json' }); // Result prüfen
const written = writeUpdate(file, update); // nur Seiten: appendDrawnPages(pdf, zeichne)
if (written.ok) pdf = written.value.bytes;
```

Ohne `reuseFont` bettet jede Revision ihre Schrift (bzw. ihre Teilmenge) neu ein.

## Grenzen

- Schreibt nur an PDFs mit **klassischer Querverweistabelle** weiter (so legt pdf-lib sie mit
  `useObjectStreams: false` an); Querverweis- und Objektströme, Hybriddateien (`/XRefStm`), verschlüsselte Dateien (`/Encrypt`) und
  linearisierte Dateien werden mit einem Code abgelehnt (`xref-stream`, `object-stream`, `encrypted`, `linearized`).
  Weitere Lese-Codes: `syntax` (auch Müll vor `%PDF`), `no-startxref`, `xref-loop`, `object-missing`,
  `object-mismatch`.
- Die Bibliothek prüft **keine Tokens** (Signatur, Kette, Abdruck = Hash): das macht der übergebene Prüfer.
  Sie prüft nur, dass der Bereich die Datei bis zum Ende der Revision außer genau dem eigenen `/Contents`
  abdeckt (`rangeOk`). `rangeOk` ist **strukturell, kein Manipulationsnachweis**: der Aufrufer muss den
  Abdruck im Token gegen `t.digest` prüfen (im Beispiel oben `prüfeToken(t.token, t.digest)`).
- `findDocTimeStamps` bricht bei einem fehlerhaften Stempel nicht ab: der Eintrag hat `error`, `rangeOk` und
  `tokenOk` sind `false`.
- `appendDocTimeStamp`: `options.reserve` (Standard 16384 Bytes) ist der Platz für das Token; erlaubt 1024..65536, sonst `bad-options`; ein längeres Token ist `token-too-large`.
- `PdfFile.revisionBytes(i)` enthält das eine Zeilenende nach `%%EOF`; es ist ein Präfix der fortgeschriebenen Datei, nicht unbedingt byte-gleich mit der ursprünglichen Basis.
- `attachmentChanges` meldet `kind` `'removed'` oder `'changed'` (auch bei doppelten Namen in einer Revision); `revision` ist die erste betroffene Revision; `maxInflatedBytes` hat den Standardwert.
- Die Antwort des `Stamper` muss genau eine DER-SEQUENCE sein; BER mit unbestimmter Länge wird abgelehnt.
- `readAttachments` entschlüsselt nur unkomprimierte oder einfach `FlateDecode`-Ströme; andere Filter kommen
  roh zurück (`unsupportedFilter`, `filter`). Ein `FlateDecode`-Strom, der über `maxInflatedBytes` (Standard 256 MiB, dritter Parameter) hinaus wächst, wird nicht entpackt: das Lesen bricht ab, der Eintrag kommt roh mit `tooLarge` zurück (Schutz vor Dekompressionsbomben). `attachFile` lehnt Namensbäume mit `/Kids` ab, das Lesen folgt ihnen.
- `attachmentChanges` vergleicht je Anhang: Daten, MIME-Typ, Beziehung, Beschreibung, Filter, Filespec `/Type`, `/F`, `/UF`,
  `/EF /UF` (eigener Strom: Daten, `/Subtype`, Filter), `/Params` (`Size`, `ModDate`), Strom-`/Type` und die Zugehörigkeit zum
  Katalog-`/AF`. Dateien, die **nur** in `/AF` stehen (mit `/EF`), liest `readAttachments` mit `source: 'af'` (Name aus `/UF`, sonst `/F`);
  für sie meldet `attachmentChanges` nur Entfernen/Ändern früher gesehener Einträge, nie ein Hinzufügen. **Nicht gelesen:**
  `/FileAttachment`-Seitenanmerkungen. Ein fehlerhafter Namensbaum-Schlüssel lässt `attachmentChanges` bewusst **scheitern**
  (`syntax`, laut statt still). `attachFile` lehnt ein Katalog-`/AF` ab, das kein Array (oder Verweis darauf) ist.
- `Update.objects`/`generations` sind schreibgeschützte Kopien.
- Keine Langzeit-Prüfdaten (DSS) bisher, keine Prüfung, _was_ sich in späteren Revisionen geändert hat (nur `attachmentChanges`: entfernte oder
  geänderte Anhänge).
- Ein Verweis mit falscher Generation (`5 1 R`, die Datei hat `5 0`) wird **absichtlich abgelehnt**
  (`object-mismatch`) und nicht, wie die PDF-Norm es für lesende Programme vorsieht, als `null` gelesen: die
  Bibliothek schreibt nur weiter und soll nichts stillschweigend übergehen.
- `FoundTimeStamp.digest` wird **erst beim Zugriff** über den Puffer des Aufrufers berechnet. Dieser Puffer
  darf sich nach `findDocTimeStamps` nicht mehr ändern.
- Die Trailer-`/ID` (PDF/A-3 verlangt sie) wird bei **jeder** Revision geschrieben: Das erste Element bleibt, das
  zweite ändert sich (erste 16 Bytes SHA-256 über die alte Datei plus die neuen Objekte, ohne Trailer;
  deterministisch, ohne Uhr und Zufall). Fehlt die `/ID` (etwa bei pdf-lib), entsteht sie mit beiden Elementen
  gleich. Eine fehlerhafte `/ID` (kein Array aus zwei Strings) ist ein Fehlschlag mit `syntax`.
- Die Zahl der Objekte (`/Size`) ist auf 2147483647 begrenzt (so viel liest `PdfFile`); `Update.add`, `set` und
  `writeUpdate` lehnen mehr ab (`bad-reference`).
