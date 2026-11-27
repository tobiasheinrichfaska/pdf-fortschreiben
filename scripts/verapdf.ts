// Parsing and comparing veraPDF machine-readable reports (`--format mrr`, XML). Pure: no tools, no I/O.
// The base file written by pdf-lib is not PDF/A conformant, so the check is differential: a result may fail
// only rules the base already fails.

export interface FailedRule {
  /** `clause` + `/` + `testNumber`, e.g. `6.1.2/1`. */
  readonly id: string;
  readonly description: string;
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The failed rules of one veraPDF XML report; throws when the text is not a validation report. */
export function parseFailedRules(xml: string): Map<string, FailedRule> {
  if (!/<validationReport\b/.test(xml)) {
    throw new Error('not a veraPDF validation report (no <validationReport> element)');
  }
  const rules = new Map<string, FailedRule>();
  // Every chunk after a "<rule" start tag; the description is inside the same chunk.
  for (const chunk of xml.split(/<rule\b/).slice(1)) {
    const end = chunk.indexOf('>');
    const tag = ` ${chunk.slice(0, end)}`;
    if (attr(tag, 'status') !== 'failed') continue;
    const clause = attr(tag, 'clause');
    const testNumber = attr(tag, 'testNumber');
    if (clause === undefined || testNumber === undefined) {
      throw new Error(`failed rule without clause/testNumber: <rule${tag}>`);
    }
    const id = `${clause}/${testNumber}`;
    const description = /<description>([\s\S]*?)<\/description>/.exec(chunk)?.[1] ?? '';
    rules.set(id, { id, description: unescapeXml(description.trim()) });
  }
  return rules;
}

/** Rules a result fails that the base does not, sorted by id (clause text order). */
export function newFailures(
  base: ReadonlyMap<string, FailedRule>,
  result: ReadonlyMap<string, FailedRule>,
): FailedRule[] {
  return [...result.values()]
    .filter((r) => !base.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}
