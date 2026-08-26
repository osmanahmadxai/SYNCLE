import { ENGINE_MARKS, type EngineMark } from '@/lib/engine-marks';

/**
 * The hero picture, as simple as it can be while still saying the thing:
 * five engines on one shared wire, the wire running into Syncle. Each
 * engine's short connector has an arrowhead at both ends — sending and
 * receiving — and each mark wears its real brand colour, flat.
 *
 * No boxes around the logos, no elbows, no animation, no gradients.
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

type Geometry = {
  w: number;
  h: number;
  /** engine mark height and label size */
  mark: number;
  label: number;
  /** vertical positions: logo centre, tick start/end (the bus), node */
  logoY: number;
  tickTop: number;
  busY: number;
  coreW: number;
  coreH: number;
  coreText: number;
  /** the five logo x-centres */
  xs: number[];
  head: number;
};

const WIDE: Geometry = {
  w: 640,
  h: 214,
  mark: 30,
  label: 12,
  logoY: 36,
  tickTop: 80,
  busY: 122,
  coreW: 140,
  coreH: 46,
  coreText: 14,
  xs: [64, 192, 320, 448, 576],
  head: 6,
};

const NARROW: Geometry = {
  w: 340,
  h: 178,
  mark: 20,
  label: 8.5,
  logoY: 24,
  tickTop: 56,
  busY: 90,
  coreW: 104,
  coreH: 38,
  coreText: 11.5,
  xs: [34, 102, 170, 238, 306],
  head: 4.5,
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** a vertical two-way connector: line with a small chevron at each end */
function Tick({ g, x }: { g: Geometry; x: number }) {
  const s = g.head;
  return (
    <g stroke="currentColor" strokeOpacity={0.3} fill="none" strokeLinecap="round">
      <path d={`M ${x} ${g.tickTop} L ${x} ${g.busY}`} />
      {/* up-pointing chevron at the top, down-pointing at the bus */}
      <path d={`M ${r2(x - s * 0.7)} ${r2(g.tickTop + s)} L ${x} ${g.tickTop} L ${r2(x + s * 0.7)} ${r2(g.tickTop + s)}`} />
      <path d={`M ${r2(x - s * 0.7)} ${r2(g.busY - s)} L ${x} ${g.busY} L ${r2(x + s * 0.7)} ${r2(g.busY - s)}`} />
    </g>
  );
}

/** an engine: its bare mark in the real brand colour, label underneath */
function Engine({ g, engine, x }: { g: Geometry; engine: EngineMark; x: number }) {
  const [bx, by, bw, bh] = engine.box;
  const scale = (g.mark * engine.weight) / Math.max(bw, bh);
  return (
    <g>
      <path
        d={engine.d}
        fill={engine.light}
        transform={`translate(${r2(x - (bx + bw / 2) * scale)} ${r2(
          g.logoY - (by + bh / 2) * scale,
        )}) scale(${r2(scale)})`}
      />
      <text
        x={x}
        y={r2(g.logoY + g.mark / 2 + g.label + 5)}
        textAnchor="middle"
        fontSize={g.label}
        fontFamily={MONO}
        fill="currentColor"
        fillOpacity={0.6}
      >
        {engine.label}
      </text>
    </g>
  );
}

function Scene({ g }: { g: Geometry }) {
  const cx = g.w / 2;
  const coreTop = g.busY + 18;
  return (
    <svg viewBox={`0 0 ${g.w} ${g.h}`} className="h-full w-full text-foreground" aria-hidden>
      {/* the shared wire, and its drop into Syncle */}
      <g stroke="currentColor" strokeOpacity={0.3} fill="none" strokeLinecap="round">
        <path d={`M ${g.xs[0]} ${g.busY} L ${g.xs[g.xs.length - 1]} ${g.busY}`} />
        <path d={`M ${cx} ${g.busY} L ${cx} ${coreTop}`} />
      </g>

      {g.xs.map((x, i) => (
        <Tick key={ENGINE_MARKS[i].id} g={g} x={x} />
      ))}

      <rect
        x={r2(cx - g.coreW / 2)}
        y={coreTop}
        width={g.coreW}
        height={g.coreH}
        rx={9}
        fill="var(--background)"
        stroke="currentColor"
        strokeOpacity={0.35}
      />
      <text
        x={cx}
        y={r2(coreTop + g.coreH / 2 + g.coreText * 0.35)}
        textAnchor="middle"
        fontSize={g.coreText}
        fontFamily={MONO}
        fill="currentColor"
        fillOpacity={0.8}
        letterSpacing="0.16em"
        dx={r2(-g.coreText * 0.08)}
      >
        syncle
      </text>

      {g.xs.map((x, i) => (
        <Engine key={ENGINE_MARKS[i].id} g={g} engine={ENGINE_MARKS[i]} x={x} />
      ))}
    </svg>
  );
}

export function SyncDiagram() {
  return (
    <div
      role="img"
      aria-label="PostgreSQL, MySQL, MongoDB, SQLite and Redis on one shared wire running into Syncle, each connected by a two-way arrow"
    >
      <div className="mx-auto hidden aspect-[640/214] w-full max-w-[640px] sm:block">
        <Scene g={WIDE} />
      </div>
      <div className="mx-auto aspect-[340/178] max-w-[340px] sm:hidden">
        <Scene g={NARROW} />
      </div>
    </div>
  );
}
