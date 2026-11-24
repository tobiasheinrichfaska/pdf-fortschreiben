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
  `useObjectStreams: false` an); Querverweis- und Objektströme sowie verschlüsselte Dateien (`/Encrypt`) werden mit einem Code abgelehnt
  (`xref-stream`, `object-stream`, `encrypted`).
- Die Bibliothek prüft **keine Tokens** (Signatur, Kette, Abdruck = Hash): das macht der übergebene Prüfer.
  Sie prüft nur, dass der Bereich die Datei bis zum Ende der Revision außer genau dem eigenen `/Contents`
  abdeckt (`rangeOk`).
- `findDocTimeStamps` bricht bei einem fehlerhaften Stempel nicht ab: der Eintrag hat `error`, `rangeOk` und
  `tokenOk` sind `false`.
- Die Antwort des `Stamper` muss genau eine DER-SEQUENCE sein; BER mit unbestimmter Länge wird abgelehnt.
- `readAttachments` entschlüsselt nur unkomprimierte oder einfach `FlateDecode`-Ströme; andere Filter kommen
  roh zurück (`unsupportedFilter`, `filter`). `attachFile` lehnt Namensbäume mit `/Kids` ab, das Lesen folgt ihnen.
- Fehlerarten gemischt: `PdfReadError` mit `code` beim Lesen, `Error`/`RangeError` bei falscher Benutzung.
  `Update.objects`/`generations` sind schreibgeschützte Kopien.
- Keine Langzeit-Prüfdaten (DSS) bisher, keine Prüfung, _was_ sich in späteren Revisionen geändert hat (nur `attachmentChanges`: entfernte oder
  geänderte Anhänge).
