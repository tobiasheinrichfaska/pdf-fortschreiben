# pdf-fortschreiben

Ein PDF **fortschreiben, ohne es neu zu bauen**: jede Änderung wird als neue Revision ans Dateiende gehängt,
die früheren Bytes bleiben Byte für Byte gleich. Dazu kommen Dateianhänge (PDF/A-3 „associated files“) und
**Dokument-Zeitstempel** (RFC 3161, PAdES `ETSI.RFC3161`) über den jeweiligen Gesamtstand – ohne Schlüssel
und ohne Zertifikat des Schreibenden.

**Stand: 0.0.1, Entwurf.** Liegt vorläufig als Unterverzeichnis im Repo `Zeiterfassung`, wird in ein eigenes
Repo herausgelöst (`HERAUSLOESEN.md`). Nicht auf npm, nicht getaggt, nicht von einem Menschen
sicherheitsgeprüft, nur unter Node getestet, nicht nach PDF/A validiert.

## Benutzen

```ts
import {
  appendRevision,
  attachFile,
  appendDocTimeStamp,
  findDocTimeStamps,
  attachmentChanges,
} from 'pdf-fortschreiben';

// 1. Tagesstand: neuer Anhang mit neuem Namen (nur hinzufügen; ein vergebener Name wird abgelehnt)
let pdf = appendRevision(pdf0, (file, update) =>
  attachFile(file, update, { name: 'monat-tag-03.json', data, mimeType: 'application/json' }),
);
// 2. Zeitstempel über den Gesamtstand; das Token holt die App (z. B. über den Zeitstempel-Weiterreicher)
pdf = await appendDocTimeStamp(pdf, async (sha256) => holeToken(sha256));
// 3. Prüfen: jeder Stempel, den die Datei je hatte, mit Revision, Bereich und Hash
for (const t of findDocTimeStamps(pdf)) {
  if (t.error !== undefined || !t.rangeOk || !t.tokenOk)
    throw new Error(`Stempel ${t.field}: ${t.error ?? 'Bereich/Token'}`);
  prüfeToken(t.token, t.digest); // z. B. verifyTimestampToken
}
await attachmentChanges(pdf); // [] = kein früherer Anhang wurde später gelöscht oder geändert
```

## Grenzen

- Schreibt nur an PDFs mit **klassischer Querverweistabelle** weiter (so legt pdf-lib sie mit
  `useObjectStreams: false` an); Querverweis- und Objektströme, Hybriddateien (`/XRefStm`), verschlüsselte Dateien (`/Encrypt`) und
  linearisierte Dateien werden mit einem Code abgelehnt (`xref-stream`, `object-stream`, `encrypted`, `linearized`).
  Weitere `PdfReadError`-Codes: `syntax` (auch Müll vor `%PDF`), `no-startxref`, `xref-loop`, `object-missing`,
  `object-mismatch`.
- Die Bibliothek prüft **keine Tokens** (Signatur, Kette, Abdruck = Hash): das macht der übergebene Prüfer.
  Sie prüft nur, dass der Bereich die Datei bis zum Ende der Revision außer genau dem eigenen `/Contents`
  abdeckt (`rangeOk`). `rangeOk` ist **strukturell, kein Manipulationsnachweis**: der Aufrufer muss den
  Abdruck im Token gegen `t.digest` prüfen (im Beispiel oben `prüfeToken(t.token, t.digest)`).
- `findDocTimeStamps` bricht bei einem fehlerhaften Stempel nicht ab: der Eintrag hat `error`, `rangeOk` und
  `tokenOk` sind `false`.
- `appendDocTimeStamp`: `options.reserve` (Standard 16384 Bytes) ist der Platz für das Token; erlaubt 1024..65536, sonst `RangeError`; ein längeres Token ebenfalls `RangeError`.
- `PdfFile.revisionBytes(i)` enthält das eine Zeilenende nach `%%EOF`; es ist ein Präfix der fortgeschriebenen Datei, nicht unbedingt byte-gleich mit der ursprünglichen Basis.
- `attachmentChanges` meldet `kind` `'removed'` oder `'changed'` (auch bei doppelten Namen in einer Revision); `revision` ist die erste betroffene Revision; `maxInflatedBytes` hat den Standardwert.
- Die Antwort des `Stamper` muss genau eine DER-SEQUENCE sein; BER mit unbestimmter Länge wird abgelehnt.
- `readAttachments` entschlüsselt nur unkomprimierte oder einfach `FlateDecode`-Ströme; andere Filter kommen
  roh zurück (`unsupportedFilter`, `filter`). Ein `FlateDecode`-Strom, der über `maxInflatedBytes` (Standard 256 MiB, dritter Parameter) hinaus wächst, wird nicht entpackt: das Lesen bricht ab, der Eintrag kommt roh mit `tooLarge` zurück (Schutz vor Dekompressionsbomben). `attachFile` lehnt Namensbäume mit `/Kids` ab, das Lesen folgt ihnen.
- `attachmentChanges` vergleicht je Anhang: Daten, MIME-Typ, Beziehung, Beschreibung, Filter, Filespec `/Type`, `/F`, `/UF`,
  `/EF /UF` (eigener Strom: Daten, `/Subtype`, Filter), `/Params` (`Size`, `ModDate`), Strom-`/Type` und die Zugehörigkeit zum
  Katalog-`/AF`. Dateien, die **nur** in `/AF` stehen (mit `/EF`), liest `readAttachments` mit `source: 'af'` (Name aus `/UF`, sonst `/F`);
  für sie meldet `attachmentChanges` nur Entfernen/Ändern früher gesehener Einträge, nie ein Hinzufügen. **Nicht gelesen:**
  `/FileAttachment`-Seitenanmerkungen. Ein fehlerhafter Namensbaum-Schlüssel lässt `attachmentChanges` bewusst **werfen**
  (`PdfReadError`, laut statt still). `attachFile` lehnt ein Katalog-`/AF` ab, das kein Array (oder Verweis darauf) ist.
- Fehlerarten gemischt: `PdfReadError` mit `code` beim Lesen, `Error`/`RangeError` bei falscher Benutzung.
  `Update.objects`/`generations` sind schreibgeschützte Kopien.
- Keine Langzeit-Prüfdaten (DSS) bisher, keine Prüfung, _was_ sich in späteren Revisionen geändert hat (nur `attachmentChanges`: entfernte oder
  geänderte Anhänge).
- Ein Verweis mit falscher Generation (`5 1 R`, die Datei hat `5 0`) wird **absichtlich abgelehnt**
  (`object-mismatch`) und nicht, wie die PDF-Norm es für lesende Programme vorsieht, als `null` gelesen: die
  Bibliothek schreibt nur weiter und soll nichts stillschweigend übergehen.
- `FoundTimeStamp.digest` wird **erst beim Zugriff** über den Puffer des Aufrufers berechnet. Dieser Puffer
  darf sich nach `findDocTimeStamps` nicht mehr ändern.
- Die Trailer-`/ID` wird aus der Basisdatei **übernommen, nicht ergänzt**. PDF/A-3 verlangt sie: die Basisdatei
  des Aufrufers muss eine haben. Eine Basisdatei von pdf-lib hat **keine** Trailer-`/ID`; mit
  `doc.context.trailerInfo.ID` lässt sie sich vor `doc.save()` setzen.
- Die Zahl der Objekte (`/Size`) ist auf 2147483647 begrenzt (so viel liest `PdfFile`); `Update.add`, `set` und
  `writeUpdate` lehnen mehr mit einem `Error` ab.
