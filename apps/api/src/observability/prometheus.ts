/**
 * the Prometheus text exposition format, written by hand: it is thirty lines,
 * and not a reason to add a dependency to the process that holds every
 * credential.
 */
export interface Sample {
  labels?: Record<string, string | number | boolean>;
  value: number;
}

export interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Sample[];
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** a label VALUE is somebody's free text (a bridge's name): backslash, quote and newline are escaped */
export function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function number(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

export function renderMetrics(metrics: Metric[]): string {
  const out: string[] = [];
  for (const m of metrics) {
    if (!NAME.test(m.name)) throw new Error(`Not a metric name: ${m.name}`);
    out.push(
      `# HELP ${m.name} ${m.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`,
    );
    out.push(`# TYPE ${m.name} ${m.type}`);
    for (const s of m.samples) {
      const labels = Object.entries(s.labels ?? {});
      for (const [k] of labels)
        if (!LABEL.test(k)) throw new Error(`Not a label name: ${k}`);
      const rendered = labels.length
        ? `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`).join(',')}}`
        : '';
      out.push(`${m.name}${rendered} ${number(s.value)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
