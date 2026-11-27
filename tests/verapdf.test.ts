import { newFailures, parseFailedRules } from '../scripts/verapdf.ts';

const report = (rules: string) =>
  `<?xml version="1.0" encoding="utf-8"?><report><jobs><job><validationReport profileName="PDF/A-3B validation profile" isCompliant="false"><details passedRules="100" failedRules="2">${rules}</details></validationReport></job></jobs></report>`;

const rule = (clause: string, test: number, status: string, description: string) =>
  `<rule specification="ISO 19005-3:2012" clause="${clause}" testNumber="${test}" status="${status}" failedChecks="1"><description>${description}</description><object>CosDocument</object><test>x</test><check status="failed"><context>root</context></check></rule>`;

describe('parseFailedRules', () => {
  it('returns only failed rules, keyed by clause and test number', () => {
    const xml = report(
      rule('6.1.2', 1, 'failed', 'The file header shall contain &lt;x&gt; &amp; more') +
        rule('6.2.3', 2, 'passed', 'fine') +
        rule('6.1.13', 1, 'failed', 'Other'),
    );
    const m = parseFailedRules(xml);
    expect([...m.keys()].sort()).toEqual(['6.1.13/1', '6.1.2/1']);
    expect(m.get('6.1.2/1')?.description).toBe('The file header shall contain <x> & more');
  });

  it('treats a compliant report as an empty set', () => {
    expect(parseFailedRules(report('')).size).toBe(0);
  });

  it('rejects text that is not a validation report (a crashed tool must not count as a pass)', () => {
    expect(() => parseFailedRules('')).toThrow(/validation report/);
    expect(() =>
      parseFailedRules('<report><jobs><job><taskException/></job></jobs></report>'),
    ).toThrow(/validation report/);
  });

  it('rejects a failed rule without an id', () => {
    expect(() =>
      parseFailedRules(report('<rule status="failed"><description>d</description></rule>')),
    ).toThrow(/clause/);
  });
});

describe('newFailures', () => {
  const base = parseFailedRules(
    report(rule('6.1.2', 1, 'failed', 'a') + rule('6.2.11.2', 1, 'failed', 'b')),
  );

  it('is empty when the result fails a subset of the base rules', () => {
    const result = parseFailedRules(report(rule('6.1.2', 1, 'failed', 'a')));
    expect(newFailures(base, result)).toEqual([]);
    expect(newFailures(base, base)).toEqual([]);
  });

  it('lists every rule the base does not fail, with its description, in clause order', () => {
    const result = parseFailedRules(
      report(
        rule('6.1.2', 1, 'failed', 'a') +
          rule('6.4.3', 2, 'failed', 'second') +
          rule('6.4.3', 1, 'failed', 'first') +
          rule('6.10.2', 1, 'failed', 'later'),
      ),
    );
    expect(newFailures(base, result).map((r) => `${r.id} ${r.description}`)).toEqual([
      '6.4.3/1 first',
      '6.4.3/2 second',
      '6.10.2/1 later',
    ]);
  });

  it('is not fooled by the same clause with another test number', () => {
    const result = parseFailedRules(report(rule('6.1.2', 2, 'failed', 'new test')));
    expect(newFailures(base, result).map((r) => r.id)).toEqual(['6.1.2/2']);
  });
});
