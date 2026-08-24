import { ENGINE_MARKS, type EngineMark } from '@/lib/engine-marks';

/**
 * The hero drawing: the five engines Syncle speaks, wired to Syncle.
 *
 * Drawn as a schematic rather than a picture — labelled blocks, right angles,
 * rounded corners, a dot where a wire meets a port. Flat 2D vector and nothing
 * else: no gradients, no glows, no shadows, no JavaScript. Every colour is
 * `currentColor` at some opacity, which is what lets one drawing hold up in
 * both themes without a second set of values.
 *
 * Every wire is private — one engine, one route, no shared segments — so the
 * rows riding them can never land on top of each other, and none of the timing
 * has to be kept in step for that to stay true.
 *
 * The travellers are rows: a card carrying the operation that made it. A wire
 * carries one row at a time and turns around between crossings, so every
 * engine is seen both sending and receiving, which is the actual claim — any
 * engine either end.
 *
 * Phones get their own layout, stacked, because five labelled blocks around a
 * hub do not fit in 340px. That version is drawn at rest: the routes there are
 * a fan off one trunk, and rows sharing a trunk is exactly the thing the
 * desktop layout is built to avoid.
 *
 * Reduced motion: SMIL ignores the CSS kill-switch in globals.css, so the
 * scene draws both a moving layer and a still one and swaps them by media
 * query (`.hero-motion` / `.hero-still`). That is what keeps it a server
 * component: no hydration, and never a frame of the wrong version.
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

type Point = { x: number; y: number };

type Geometry = {
  w: number;
  h: number;
  /** engine block */
  boxW: number;
  boxH: number;
  /** Syncle's block */
  coreW: number;
  coreH: number;
  coreText: number;
  radius: number;
  mark: number;
  label: number;
  cardW: number;
  cardH: number;
  cardText: number;
  dot: number;
  /** radius the wires turn their corners on */
  bend: number;
  stroke: number;
  /** how fast a row travels, in viewBox units per second */
  speed: number;
};

const WIDE: Geometry = {
  w: 760,
  h: 620,
  boxW: 180,
  boxH: 54,
  coreW: 280,
  coreH: 82,
  coreText: 17,
  radius: 10,
  mark: 26,
  label: 14,
  cardW: 70,
  cardH: 24,
  cardText: 10.5,
  dot: 3.2,
  bend: 13,
  stroke: 1,
  speed: 68,
};

const STACK: Geometry = {
  w: 340,
  h: 600,
  boxW: 200,
  boxH: 42,
  coreW: 200,
  coreH: 48,
  coreText: 12,
  radius: 8,
  mark: 20,
  label: 11,
  cardW: 58,
  cardH: 20,
  cardText: 8.5,
  dot: 2.5,
  bend: 10,
  stroke: 1,
  speed: 40,
};

/**
 * The operations a row can carry. Two hues each: neither a dark green nor a
 * bright one reads on both backgrounds, so CSS picks the side that does.
 */
const OPS = {
  create: { label: 'create', light: '#1A7F37', dark: '#3FB950' },
  update: { label: 'update', light: '#9A6700', dark: '#D29922' },
  delete: { label: 'delete', light: '#CF222E', dark: '#F85149' },
} as const;

type Op = (typeof OPS)[keyof typeof OPS];

/**
 * One entry per engine, in the order they are wired. `ops` is the rotation
 * that wire cycles through — a different one each time, so no two wires carry
 * the same badge. `offset` is how far into its own cycle the wire already is
 * on the first frame: without it, wires of similar length change their badge
 * on the same frame and the whole drawing reads as one blinking thing.
 */
const WIRES = [
  { ops: [OPS.create, OPS.update, OPS.delete], offset: 0 },
  { ops: [OPS.update, OPS.delete, OPS.create], offset: 5.3 },
  { ops: [OPS.delete, OPS.create, OPS.update], offset: 11.6 },
  { ops: [OPS.create, OPS.delete, OPS.update], offset: 2.9 },
  { ops: [OPS.update, OPS.create, OPS.delete], offset: 15.4 },
];

/**
 * Six crossings per cycle: each of the three operations goes out once and
 * comes back once, which is the shortest run that shows every combination.
 */
const CROSSINGS = 6;

/** how much of a crossing a row spends fading up, and again fading out */
const FADE_IN = 0.16;
const FADE_OUT = 0.2;

const r2 = (n: number) => Math.round(n * 100) / 100;
const t4 = (n: number) => Number(n.toFixed(4));
const xy = (p: Point) => `${r2(p.x)} ${r2(p.y)}`;
const span = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** the point `distance` along the way from `from` towards `to` */
function towards(from: Point, to: Point, distance: number): Point {
  const len = span(from, to) || 1;
  return {
    x: from.x + ((to.x - from.x) / len) * distance,
    y: from.y + ((to.y - from.y) / len) * distance,
  };
}

/**
 * A polyline with its corners rounded off. Right angles are what make the
 * drawing read as drafted rather than grown, but a hard corner is also where
 * a moving card would visibly snap, and the arc absorbs that.
 */
function wirePath(points: readonly Point[], bend: number): string {
  let d = `M ${xy(points[0])}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const corner = points[i];
    const back = Math.min(bend, span(points[i - 1], corner) / 2);
    const on = Math.min(bend, span(corner, points[i + 1]) / 2);
    d += ` L ${xy(towards(corner, points[i - 1], back))}`;
    d += ` Q ${xy(corner)} ${xy(towards(corner, points[i + 1], on))}`;
  }
  return `${d} L ${xy(points[points.length - 1])}`;
}

function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += span(points[i - 1], points[i]);
  return total;
}

/** the middle of the longest straight run — where a resting row looks placed */
function restPoint(points: readonly Point[]): Point {
  let best = 0;
  let at: Point = points[0];
  for (let i = 1; i < points.length; i += 1) {
    const len = span(points[i - 1], points[i]);
    if (len > best) {
      best = len;
      at = towards(points[i - 1], points[i], len / 2);
    }
  }
  return at;
}

/** a hue handed to CSS as a pair, so the theme can pick the one that reads */
function tint(value: { light: string; dark: string }): React.CSSProperties {
  return {
    '--tint-light': value.light,
    '--tint-dark': value.dark,
  } as React.CSSProperties;
}

type Wire = {
  engine: EngineMark;
  /** the engine block's centre */
  at: Point;
  route: readonly Point[];
  dur: number;
  ops: readonly Op[];
  offset: number;
};

type Layout = {
  core: Point;
  wires: Wire[];
  /** the shared run every wire hangs off, where there is one */
  trunk?: readonly Point[];
};

/**
 * Three engines across the top, two along the bottom, Syncle in the middle.
 * Each wire drops out of its block, runs along one of two shared altitudes —
 * without ever touching another wire — and comes down into its own port. It
 * fills the frame edge to edge, which the obvious ring never does.
 */
function wideLayout(g: Geometry): Layout {
  const cx = g.w / 2;
  const coreY = 320;
  const top = coreY - g.coreH / 2;
  const bottom = coreY + g.coreH / 2;
  /* the altitude each wire turns at; the pairs are offset from each other so
     two wires on the same side never read as one line broken in the middle */
  const lanes = { left: 185, right: 215, under: 478, over: 445 };
  const rows = { top: 48, bottom: 572 };
  const half = g.boxH / 2;

  /** out of the block, along the lane, down into the port */
  const elbow = (x: number, y: number, lane: number, port: number, edge: number) =>
    [
      { x, y: y + (y < coreY ? half : -half) },
      { x, y: lane },
      { x: port, y: lane },
      { x: port, y: edge },
    ] as const;

  const places: { at: Point; route: readonly Point[] }[] = [
    {
      at: { x: 115, y: rows.top },
      route: elbow(115, rows.top, lanes.left, 300, top),
    },
    {
      at: { x: cx, y: rows.top },
      /* the middle block is already over its port: straight down, no elbow */
      route: [
        { x: cx, y: rows.top + half },
        { x: cx, y: top },
      ],
    },
    {
      at: { x: 645, y: rows.top },
      route: elbow(645, rows.top, lanes.right, 460, top),
    },
    {
      at: { x: 200, y: rows.bottom },
      route: elbow(200, rows.bottom, lanes.under, 330, bottom),
    },
    {
      at: { x: 560, y: rows.bottom },
      route: elbow(560, rows.bottom, lanes.over, 430, bottom),
    },
  ];

  return {
    core: { x: cx, y: coreY },
    wires: places.map((place, i) => ({
      engine: ENGINE_MARKS[i],
      at: place.at,
      route: place.route,
      /* one speed for every row: the wires differ in length, and matching the
         durations instead would turn the short one into a sprint */
      dur: Math.max(2.6, pathLength(place.route) / g.speed),
      ops: WIRES[i].ops,
      offset: WIRES[i].offset,
    })),
  };
}

/**
 * The phone version: Syncle on top, the engines stacked under it, everything
 * hanging off one trunk down the left. Drawn at rest — see the note above.
 */
function stackLayout(g: Geometry): Layout {
  const core = { x: g.w / 2, y: 8 + g.coreH / 2 };
  const rail = 40;
  const boxLeft = 130;
  const first = 130;
  const step = 106;

  const wires = ENGINE_MARKS.map((engine, i) => {
    const y = first + i * step;
    const route = [
      { x: rail, y },
      { x: boxLeft, y },
    ] as const;
    return {
      engine,
      at: { x: boxLeft + g.boxW / 2, y },
      route,
      dur: 0,
      ops: WIRES[i].ops,
      offset: 0,
    };
  });

  return {
    core,
    wires,
    trunk: [
      { x: core.x, y: core.y + g.coreH / 2 },
      { x: core.x, y: core.y + g.coreH / 2 + 22 },
      { x: rail, y: core.y + g.coreH / 2 + 22 },
      { x: rail, y: first + (ENGINE_MARKS.length - 1) * step },
    ],
  };
}

/** one row in flight: the operation that made it, on a card of its own */
function RowCard({ g, op }: { g: Geometry; op: Op }) {
  const { cardW: w, cardH: h } = g;
  const pad = h * 0.56;
  return (
    <g className="tinted" style={tint(op)}>
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={4}
        fill="var(--background)"
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={g.stroke}
      />
      <circle cx={r2(-w / 2 + pad)} cy={0} r={g.dot} fill="var(--tint)" />
      <text
        x={r2(-w / 2 + pad + g.dot + h * 0.3)}
        y={g.cardText * 0.35}
        fontSize={g.cardText}
        fontFamily={MONO}
        fill="currentColor"
        fillOpacity={0.72}
      >
        {op.label}
      </text>
    </g>
  );
}

/**
 * A wire's traffic.
 *
 * The six crossings share one clock and each moves during its own sixth of it,
 * so the wire always has exactly one row on it and never two. Even crossings
 * run outward, odd ones back — the wire takes turns rather than carrying both
 * directions at once.
 */
function Traffic({ g, wire }: { g: Geometry; wire: Wire }) {
  const cycle = wire.dur * CROSSINGS;
  /* negative, so the wire is already partway through on the first frame */
  const begin = `${r2(-wire.offset)}s`;
  const out = wirePath(wire.route, g.bend);
  const back = wirePath([...wire.route].reverse(), g.bend);

  return (
    <>
      {Array.from({ length: CROSSINGS }, (_, i) => {
        const op = wire.ops[i % wire.ops.length];
        const start = i / CROSSINGS;
        const end = (i + 1) / CROSSINGS;
        const slot = end - start;
        return (
          <g key={i} opacity={0}>
            <animate
              attributeName="opacity"
              values="0;0;1;1;0;0"
              keyTimes={`0;${t4(start)};${t4(start + slot * FADE_IN)};${t4(
                end - slot * FADE_OUT,
              )};${t4(end)};1`}
              dur={`${cycle}s`}
              begin={begin}
              repeatCount="indefinite"
            />
            <animateMotion
              dur={`${cycle}s`}
              begin={begin}
              repeatCount="indefinite"
              path={i % 2 === 0 ? out : back}
              keyPoints="0;0;1;1"
              keyTimes={`0;${t4(start)};${t4(end)};1`}
              calcMode="linear"
            />
            <RowCard g={g} op={op} />
          </g>
        );
      })}
    </>
  );
}

/** an engine, as a labelled block */
function EngineBlock({ g, wire }: { g: Geometry; wire: Wire }) {
  const { engine, at } = wire;
  const [bx, by, bw, bh] = engine.box;
  /* every mark is fitted to the same box: they are drawn on different canvases
     and none of them fills its own */
  const scale = (g.mark * engine.weight) / Math.max(bw, bh);
  const left = at.x - g.boxW / 2;
  return (
    <g className="engine-node tinted" style={tint(engine)}>
      <rect
        className="engine-ring"
        x={r2(left)}
        y={r2(at.y - g.boxH / 2)}
        width={g.boxW}
        height={g.boxH}
        rx={g.radius}
        fill="var(--background)"
        stroke="currentColor"
        strokeOpacity={0.22}
        strokeWidth={g.stroke}
      />
      <path
        className="engine-mark"
        d={engine.d}
        fill="currentColor"
        fillOpacity={engine.ink}
        transform={`translate(${r2(left + g.boxH / 2 - (bx + bw / 2) * scale)} ${r2(
          at.y - (by + bh / 2) * scale,
        )}) scale(${r2(scale)})`}
      />
      <text
        x={r2(left + g.boxH / 2 + g.mark / 2 + 9)}
        y={r2(at.y + g.label * 0.35)}
        fontSize={g.label}
        fontFamily={MONO}
        fill="currentColor"
        fillOpacity={0.62}
      >
        {engine.label}
      </text>
    </g>
  );
}

function Scene({ g, layout, motion }: { g: Geometry; layout: Layout; motion: boolean }) {
  const { core, wires, trunk } = layout;

  return (
    <svg viewBox={`0 0 ${g.w} ${g.h}`} className="h-full w-full text-foreground" aria-hidden>
      {trunk && (
        <path
          d={wirePath(trunk, g.bend)}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={g.stroke}
        />
      )}

      {wires.map((wire) => (
        <path
          key={wire.engine.id}
          d={wirePath(wire.route, g.bend)}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={g.stroke}
        />
      ))}

      {/* a dot where a wire meets a port, the way a schematic marks a join */}
      {wires.map((wire) => (
        <circle
          key={wire.engine.id}
          cx={r2(wire.route[wire.route.length - 1].x)}
          cy={r2(wire.route[wire.route.length - 1].y)}
          r={g.stroke * 2.4}
          fill="currentColor"
          fillOpacity={0.4}
        />
      ))}

      {motion && (
        <g className="hero-motion">
          {wires.map((wire) => (
            <Traffic key={wire.engine.id} g={g} wire={wire} />
          ))}
        </g>
      )}

      <g className={motion ? 'hero-still' : undefined}>
        {wires.map((wire) => (
          <g key={wire.engine.id} transform={`translate(${xy(restPoint(wire.route))})`}>
            <RowCard g={g} op={wire.ops[0]} />
          </g>
        ))}
      </g>

      <rect
        x={r2(core.x - g.coreW / 2)}
        y={r2(core.y - g.coreH / 2)}
        width={g.coreW}
        height={g.coreH}
        rx={g.radius + 2}
        fill="currentColor"
        fillOpacity={0.035}
        stroke="currentColor"
        strokeOpacity={0.3}
        strokeWidth={g.stroke}
      />
      <text
        x={core.x}
        y={r2(core.y + g.coreText * 0.35)}
        textAnchor="middle"
        fontSize={g.coreText}
        fontFamily={MONO}
        fill="currentColor"
        fillOpacity={0.8}
        letterSpacing="0.16em"
        /* the tracking lands to the right of the last glyph too, so the word
           sits off-centre unless it is nudged back by half of one */
        dx={r2(-g.coreText * 0.08)}
      >
        syncle
      </text>

      {wires.map((wire) => (
        <EngineBlock key={wire.engine.id} g={g} wire={wire} />
      ))}
    </svg>
  );
}

export function HeroDiagram() {
  return (
    <div
      role="img"
      aria-label="PostgreSQL, MySQL, MongoDB, SQLite and Redis wired to Syncle, with created, updated and deleted rows crossing between them"
    >
      <div className="mx-auto hidden aspect-[760/620] w-full sm:block">
        <Scene g={WIDE} layout={wideLayout(WIDE)} motion />
      </div>
      <div className="mx-auto aspect-[340/600] max-w-[340px] sm:hidden">
        <Scene g={STACK} layout={stackLayout(STACK)} motion={false} />
      </div>
    </div>
  );
}
