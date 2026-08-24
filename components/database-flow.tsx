/**
 * The hero animation: a source database streaming rows into three destinations
 * of different engines, live.
 *
 * Monochrome by construction — everything is `currentColor` at varying
 * opacity, so it inverts with the theme and there is no palette to maintain.
 * Depth comes from layered opacity and a blur, not from colour.
 *
 * Three things move on different clocks, so the loop never reads as a
 * metronome: a marching dash along each lane, discrete rows riding it, and a
 * glow on each destination that lights as its rows land.
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

type Lane = {
  d: string;
  op: string;
  labelY: number;
  /** seconds for one row to cross — also the destination's pulse period */
  dur: number;
};

const LANES: Lane[] = [
  { d: 'M 214 132 C 360 96, 566 46, 742 44', op: 'insert', labelY: 62, dur: 5.4 },
  { d: 'M 214 144 C 360 144, 566 148, 742 148', op: 'update', labelY: 128, dur: 6.1 },
  { d: 'M 214 156 C 360 194, 566 250, 742 252', op: 'delete', labelY: 196, dur: 6.8 },
];

const DESTINATIONS = [
  { label: 'mongodb', top: 20, lane: 0 },
  { label: 'mysql', top: 124, lane: 1 },
  { label: 'redis', top: 228, lane: 2 },
];

/** a database drum, with a lit rim and a floor shadow so it has volume */
function Drum({
  cx,
  top,
  rx,
  ry,
  height,
  bands,
  emphasis = 1,
}: {
  cx: number;
  top: number;
  rx: number;
  ry: number;
  height: number;
  bands: number;
  emphasis?: number;
}) {
  const bandGap = height / (bands + 1);
  return (
    <g>
      {/* contact shadow — grounds the drum instead of letting it float */}
      <ellipse
        cx={cx}
        cy={top + height + ry * 1.7}
        rx={rx * 0.92}
        ry={ry * 0.44}
        fill="currentColor"
        fillOpacity={0.13 * emphasis}
        filter="url(#dfBlur)"
      />
      {/* barrel */}
      <path
        d={`M ${cx - rx} ${top} v ${height} a ${rx} ${ry} 0 0 0 ${rx * 2} 0 v ${-height} z`}
        fill="url(#dfBarrel)"
        stroke="currentColor"
        strokeOpacity={0.42 * emphasis}
        strokeWidth={1.4}
      />
      {/* stacked bands — what makes it a database and not a can */}
      {Array.from({ length: bands }).map((_, i) => (
        <path
          key={i}
          d={`M ${cx - rx} ${top + bandGap * (i + 1)} a ${rx} ${ry} 0 0 0 ${rx * 2} 0`}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.24 * emphasis}
          strokeWidth={1.1}
        />
      ))}
      {/* lid, with a brighter arc along the far edge to catch the light */}
      <ellipse
        cx={cx}
        cy={top}
        rx={rx}
        ry={ry}
        fill="url(#dfLid)"
        stroke="currentColor"
        strokeOpacity={0.55 * emphasis}
        strokeWidth={1.4}
      />
      <path
        d={`M ${cx - rx} ${top} a ${rx} ${ry} 0 0 1 ${rx * 2} 0`}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.75 * emphasis}
        strokeWidth={1.4}
      />
    </g>
  );
}

export function DatabaseFlow() {
  return (
    <svg
      viewBox="0 0 960 300"
      className="h-auto w-full text-foreground"
      role="img"
      aria-label="A PostgreSQL database streaming rows live into MongoDB, MySQL and Redis"
    >
      <defs>
        {/* a falloff across the barrel gives it a curved face without colour */}
        <linearGradient id="dfBarrel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.02" />
          <stop offset="38%" stopColor="currentColor" stopOpacity="0.1" />
          <stop offset="72%" stopColor="currentColor" stopOpacity="0.04" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
        </linearGradient>
        <linearGradient id="dfLid" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.05" />
        </linearGradient>
        <radialGradient id="dfGlow">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.14" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <filter id="dfBlur" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* light pooled around the source */}
      <ellipse cx={130} cy={150} rx={190} ry={130} fill="url(#dfGlow)" />

      {/* ── lanes ────────────────────────────────────────────────────── */}
      {LANES.map((lane, i) => (
        <g key={i}>
          <path
            d={lane.d}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.13}
            strokeWidth={1.25}
          />
          {/* a marching dash on the same rail, so the lane reads as carrying
              data even in the gaps between discrete rows */}
          <path
            d={lane.d}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.38}
            strokeWidth={1.25}
            strokeDasharray="2 16"
            strokeLinecap="round"
          >
            <animate
              attributeName="stroke-dashoffset"
              values="36;0"
              dur={`${(lane.dur / 3.4).toFixed(2)}s`}
              repeatCount="indefinite"
            />
          </path>
        </g>
      ))}

      {/* ── rows in flight ───────────────────────────────────────────── */}
      {LANES.map((lane, laneIndex) =>
        [0, 0.34, 0.68].map((phase, j) => {
          // negative begin starts each row mid-flight, so the lanes are already
          // populated on the first frame instead of filling up from empty
          const begin = (-(phase * lane.dur) + laneIndex * 0.3).toFixed(2);
          const big = j === 1;
          return (
            <g key={`${laneIndex}-${j}`} opacity={0}>
              <animate
                attributeName="opacity"
                values="0;1;1;1;0"
                keyTimes="0;0.05;0.5;0.9;1"
                dur={`${lane.dur}s`}
                begin={`${begin}s`}
                repeatCount="indefinite"
              />
              <animateMotion
                dur={`${lane.dur}s`}
                begin={`${begin}s`}
                repeatCount="indefinite"
                path={lane.d}
              />
              {/* halo, so the row reads as lit rather than pasted on */}
              <rect
                x={big ? -11 : -8}
                y={big ? -6 : -5}
                width={big ? 22 : 16}
                height={big ? 12 : 10}
                rx={3}
                fill="currentColor"
                fillOpacity={0.22}
                filter="url(#dfBlur)"
              />
              <rect
                x={big ? -9 : -6.5}
                y={big ? -4.5 : -3.5}
                width={big ? 18 : 13}
                height={big ? 9 : 7}
                rx={2}
                fill="currentColor"
                fillOpacity={0.95}
              />
            </g>
          );
        }),
      )}

      {/* ── what each lane carries ───────────────────────────────────── */}
      {LANES.map((lane) => (
        <text
          key={lane.op}
          x={478}
          y={lane.labelY}
          textAnchor="middle"
          fill="currentColor"
          fillOpacity={0.34}
          fontSize={11}
          fontFamily={MONO}
          letterSpacing="0.06em"
        >
          {lane.op}
        </text>
      ))}

      {/* ── source ───────────────────────────────────────────────────── */}
      <Drum cx={130} top={92} rx={60} ry={19} height={100} bands={2} />
      <text
        x={130}
        y={246}
        textAnchor="middle"
        fill="currentColor"
        fillOpacity={0.55}
        fontSize={13}
        fontFamily={MONO}
      >
        postgres
      </text>
      <text
        x={130}
        y={265}
        textAnchor="middle"
        fill="currentColor"
        fillOpacity={0.3}
        fontSize={11}
        fontFamily={MONO}
      >
        source
      </text>

      {/* ── destinations ─────────────────────────────────────────────── */}
      {DESTINATIONS.map((dest) => {
        const lane = LANES[dest.lane]!;
        const cy = dest.top + 26;
        return (
          <g key={dest.label}>
            {/* lights as each row lands — same period as its lane */}
            <ellipse cx={790} cy={cy} rx={58} ry={44} fill="url(#dfGlow)" opacity={0}>
              <animate
                attributeName="opacity"
                values="0;1;0"
                keyTimes="0;0.1;1"
                dur={`${lane.dur}s`}
                begin={`${(dest.lane * 0.3).toFixed(2)}s`}
                repeatCount="indefinite"
              />
            </ellipse>
            <Drum cx={790} top={dest.top} rx={38} ry={12} height={52} bands={1} emphasis={0.9} />
            <text
              x={848}
              y={cy + 5}
              fill="currentColor"
              fillOpacity={0.5}
              fontSize={12.5}
              fontFamily={MONO}
            >
              {dest.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
