import { describe, expect, it } from 'vitest';
import { tokenMatches } from './metrics.controller';
import { escapeLabelValue, renderMetrics } from './prometheus';

describe('the Prometheus text format', () => {
  it('is HELP, TYPE, then one line per sample', () => {
    expect(
      renderMetrics([
        {
          name: 'syncle_up',
          help: 'Is it up.',
          type: 'gauge',
          samples: [{ labels: { component: 'redis' }, value: 1 }],
        },
        {
          name: 'syncle_deliveries_total',
          help: 'Deliveries.',
          type: 'counter',
          samples: [{ value: 42 }],
        },
      ]),
    ).toBe(
      [
        '# HELP syncle_up Is it up.',
        '# TYPE syncle_up gauge',
        'syncle_up{component="redis"} 1',
        '# HELP syncle_deliveries_total Deliveries.',
        '# TYPE syncle_deliveries_total counter',
        'syncle_deliveries_total 42',
        '',
      ].join('\n'),
    );
  });

  it('escapes a label value — a bridge’s name is somebody’s free text, and one line break would forge a sample', () => {
    expect(escapeLabelValue('a "quoted" \\ name\nsyncle_up 0')).toBe(
      'a \\"quoted\\" \\\\ name\\nsyncle_up 0',
    );
    const out = renderMetrics([
      {
        name: 'm',
        help: 'h',
        type: 'gauge',
        samples: [
          {
            labels: { bridge: 'x"} 1\nsyncle_up{component="database"} 0' },
            value: 7,
          },
        ],
      },
    ]);
    expect(
      out.split('\n').filter((l) => !l.startsWith('#') && l !== ''),
    ).toHaveLength(1);
  });

  it('refuses a name that is not one, rather than emit a line a scraper rejects whole', () => {
    expect(() =>
      renderMetrics([
        { name: 'bad-name', help: 'h', type: 'gauge', samples: [] },
      ]),
    ).toThrow(/metric name/);
    expect(() =>
      renderMetrics([
        {
          name: 'ok',
          help: 'h',
          type: 'gauge',
          samples: [{ labels: { 'bad-label': 'x' }, value: 1 }],
        },
      ]),
    ).toThrow(/label name/);
  });

  it('writes the numbers that are not numbers the way the format spells them', () => {
    const out = renderMetrics([
      {
        name: 'm',
        help: 'h',
        type: 'gauge',
        samples: [
          { labels: { k: 'a' }, value: NaN },
          { labels: { k: 'b' }, value: Infinity },
          { labels: { k: 'c' }, value: -Infinity },
        ],
      },
    ]);
    expect(out).toContain('m{k="a"} NaN');
    expect(out).toContain('m{k="b"} +Inf');
    expect(out).toContain('m{k="c"} -Inf');
  });
});

describe('the metrics token', () => {
  it('is a bearer token, compared whole', () => {
    expect(tokenMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(tokenMatches('bearer   s3cret ', 's3cret')).toBe(true);
    expect(tokenMatches('Bearer s3cre', 's3cret')).toBe(false);
    expect(tokenMatches('Bearer s3cret!', 's3cret')).toBe(false);
    expect(tokenMatches('Basic s3cret', 's3cret')).toBe(false);
    expect(tokenMatches('s3cret', 's3cret')).toBe(false);
    expect(tokenMatches(undefined, 's3cret')).toBe(false);
    expect(tokenMatches('Bearer ', 's3cret')).toBe(false);
  });
});
