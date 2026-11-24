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
} from 'pdf-fortschreiben';

// 1. Tagesstand: Anhang ersetzen (und, Sache der App, die sichtbare Seite ändern)
let pdf = appendRevision(pdf0, (file, update) =>
  attachFile(file, update, { name: 'monat.json', data, mimeType: 'application/json' }),
);
// 2. Zeitstempel über den Gesamtstand; das Token holt die App (z. B. über den Zeitstempel-Weiterreicher)
pdf = await appendDocTimeStamp(pdf, async (sha256) => holeToken(sha256));
// 3. Prüfen: jeder Stempel, den die Datei je hatte, mit Revision, Bereich und Hash
for (const t of findDocTimeStamps(pdf)) prüfeToken(t.token, t.digest); // z. B. verifyTimestampToken
```

## Grenzen

- Schreibt nur an PDFs mit **klassischer Querverweistabelle** weiter (so legt pdf-lib sie mit
  `useObjectStreams: false` an); Querverweis- und Objektströme werden mit einem Code abgelehnt.
- Die Bibliothek prüft **keine Tokens** (Signatur, Kette, Abdruck = Hash): das macht der übergebene Prüfer.
  Sie prüft nur, dass der Bereich die Datei bis zum Ende der Revision außer genau dem Token abdeckt.
- Keine Langzeit-Prüfdaten (DSS) bisher, keine Prüfung, _was_ sich in späteren Revisionen geändert hat.
