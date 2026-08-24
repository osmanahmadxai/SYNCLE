'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

/**
 * The hero: real 3D database drums (rendered in Blender, ~15KB each as WebP)
 * with the live sync animation drawn over them as SVG.
 *
 * The composite gets the best of both: dimensional objects with physical
 * lighting, while the data flow stays vector — crisp at any size and animated
 * without JavaScript. Each drum ships a dark render (obsidian, rim-lit) and a
 * light render (porcelain), swapped with the same CSS pattern as the logo.
 *
 * Motion design: each lane runs one comet streak plus discrete rows that ease
 * INTO their destination (spline-timed), and every arrival fires a pulse ring
 * whose clock is copied from the row that caused it — the ring expands at the
 * exact frame the row lands, by construction.
 *
 * Reduced motion: SMIL ignores the CSS animation kill-switch, so this is a
 * client component that checks matchMedia and renders the same scene with no
 * <animate> elements at all — lanes at rest, one static row per lane.
 *
 * Phones get their own vertical geometry rather than a shrunken copy of the
 * desktop scene, because 11px labels scaled to 40% are not a mobile layout.
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const EASE = '0.42 0 0.2 1'; // ease-out into the destination: arrivals feel like arrivals

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function Drum({
  tiers,
  className,
  style,
  sizes,
  priority = false,
}: {
  tiers: 2 | 3;
  className?: string;
  style?: React.CSSProperties;
  sizes: string;
  priority?: boolean;
}) {
  const dims = tiers === 3 ? { w: 640, h: 703 } : { w: 460, h: 389 };
  return (
    <span className={className} style={style}>
      <Image
        src={`/drum${tiers}-dark.webp`}
        alt=""
        width={dims.w}
        height={dims.h}
        priority={priority}
        sizes={sizes}
        className="hidden h-auto w-full dark:block"
      />
      <Image
        src={`/drum${tiers}-light.webp`}
        alt=""
        width={dims.w}
        height={dims.h}
        priority={priority}
        sizes={sizes}
        className="h-auto w-full dark:hidden"
      />
    </span>
  );
}

/* ── desktop geometry (viewBox 960×420) ──────────────────────────────
   source drum centre ≈ (150, 210); destinations land at x≈800,
   y ≈ 90 / 210 / 330. */
const LANES = [
  { d: 'M 236 196 C 400 170, 560 96, 726 88', op: 'insert', mid: [480, 132] as const, end: [726, 88] as const, dur: 4.6 },
  { d: 'M 236 210 C 400 210, 560 212, 726 210', op: 'update', mid: [480, 211] as const, end: [726, 210] as const, dur: 5.4 },
  { d: 'M 236 224 C 400 250, 560 326, 726 332', op: 'delete', mid: [480, 288] as const, end: [726, 332] as const, dur: 6.2 },
];

const DESTS = [
  { label: 'mongodb', cy: 90 },
  { label: 'mysql', cy: 210 },
  { label: 'redis', cy: 330 },
];

/* phone geometry (viewBox 360×430): source above, lanes fan down */
const M_LANES = [
  { d: 'M 166 128 C 130 200, 74 240, 64 292', end: [64, 292] as const, dur: 4.6 },
  { d: 'M 180 132 C 180 200, 180 240, 180 292', end: [180, 292] as const, dur: 5.4 },
  { d: 'M 194 128 C 230 200, 286 240, 296 292', end: [296, 292] as const, dur: 6.2 },
];

const M_DESTS = [
  { label: 'mongodb', cx: 64 },
  { label: 'mysql', cx: 180 },
  { label: 'redis', cx: 296 },
];

function FlowDefs({ id }: { id: string }) {
  return (
    <defs>
      <radialGradient id={`${id}Glow`}>
        <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
        <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
      </radialGradient>
      <filter id={`${id}Blur`} x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="5" />
      </filter>
    </defs>
  );
}

/** faint foreshortened floor, so the 3D drums stand somewhere */
function Floor() {
  const verticals = [-200, -60, 60, 180, 300, 420, 540, 660, 780, 900, 1020, 1160];
  return (
    <g mask="url(#hdFloorMask)">
      {verticals.map((x) => (
        <line
          key={x}
          x1={480 + (x - 480) * 0.24}
          y1={252}
          x2={x}
          y2={430}
          stroke="currentColor"
          strokeOpacity={0.055}
        />
      ))}
      {[266, 290, 322, 364, 414].map((y) => (
        <line key={y} x1={0} y1={y} x2={960} y2={y} stroke="currentColor" strokeOpacity={0.05} />
      ))}
    </g>
  );
}

function Lane({
  d,
  dur,
  end,
  id,
  animate,
}: {
  d: string;
  dur: number;
  end: readonly [number, number];
  id: string;
  animate: boolean;
}) {
  if (!animate) {
    return (
      <g>
        <path d={d} fill="none" stroke="currentColor" strokeOpacity={0.16} strokeWidth={1.25} />
        {/* one row at rest mid-lane — the scene still explains itself */}
        <g transform={`translate(${end[0] * 0.5 + 118}, ${end[1] * 0.5 + 105})`}>
          <rect x={-9} y={-4.5} width={18} height={9} rx={2} fill="currentColor" fillOpacity={0.9} />
        </g>
      </g>
    );
  }
  return (
    <g>
      {/* base rail */}
      <path d={d} fill="none" stroke="currentColor" strokeOpacity={0.09} strokeWidth={1} />
      {/* a single comet streak whipping along the lane */}
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.4}
        strokeWidth={1.75}
        strokeDasharray="34 560"
        strokeLinecap="round"
      >
        <animate
          attributeName="stroke-dashoffset"
          values="594;0"
          dur={`${dur}s`}
          calcMode="spline"
          keyTimes="0;1"
          keySplines="0.3 0 0.2 1"
          repeatCount="indefinite"
        />
      </path>
      {/* rows in flight — negative begins mean the lanes are already busy on
          the first frame; splines ease them into the destination */}
      {[0, 0.5].map((phase, j) => {
        const begin = (-(phase * dur)).toFixed(2);
        const big = j === 0;
        return (
          <g key={j} opacity={0}>
            <animate
              attributeName="opacity"
              values="0;1;1;1;0"
              keyTimes="0;0.05;0.5;0.92;1"
              dur={`${dur}s`}
              begin={`${begin}s`}
              repeatCount="indefinite"
            />
            <animateMotion
              dur={`${dur}s`}
              begin={`${begin}s`}
              repeatCount="indefinite"
              path={d}
              rotate="auto"
              calcMode="spline"
              keyPoints="0;1"
              keyTimes="0;1"
              keySplines={EASE}
            />
            <rect
              x={big ? -11 : -8}
              y={big ? -6 : -5}
              width={big ? 22 : 16}
              height={big ? 12 : 10}
              rx={3}
              fill="currentColor"
              fillOpacity={0.22}
              filter={`url(#${id}Blur)`}
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
      })}
      {/* pulse ring at the landing point, clocked by the lead row: it expands
          at the exact frame that row arrives, every cycle, by construction */}
      <circle cx={end[0]} cy={end[1]} r={4} fill="none" stroke="currentColor" strokeOpacity={0}>
        <animate attributeName="r" values="4;4;26" keyTimes="0;0.9;1" dur={`${dur}s`} begin="0s" repeatCount="indefinite" />
        <animate
          attributeName="stroke-opacity"
          values="0;0;0.5;0"
          keyTimes="0;0.9;0.93;1"
          dur={`${dur}s`}
          begin="0s"
          repeatCount="indefinite"
        />
      </circle>
    </g>
  );
}

export function HeroScene() {
  const reduced = usePrefersReducedMotion();
  const animate = !reduced;

  return (
    <div
      role="img"
      aria-label="A PostgreSQL database streaming inserts, updates and deletes live into MongoDB, MySQL and Redis"
    >
      {/* ── desktop / tablet ─────────────────────────────────────────── */}
      <div className="relative mx-auto hidden aspect-[960/420] max-w-5xl sm:block">
        <svg viewBox="0 0 960 420" className="absolute inset-0 h-full w-full text-foreground" aria-hidden>
          <FlowDefs id="hd" />
          <mask id="hdFloorMask">
            <radialGradient id="hdFloorFade">
              <stop offset="0%" stopColor="#fff" />
              <stop offset="100%" stopColor="#000" />
            </radialGradient>
            <ellipse cx={480} cy={330} rx={430} ry={150} fill="url(#hdFloorFade)" />
          </mask>
          <Floor />
          <ellipse cx={168} cy={215} rx={162} ry={140} fill="url(#hdGlow)" />
          {LANES.map((lane) => (
            <Lane key={lane.op} d={lane.d} dur={lane.dur} end={lane.end} id="hd" animate={animate} />
          ))}
          {/* op labels as chips pinned to each lane's midpoint — the chip masks
              the rail so the lane passes visibly "through" the label */}
          {LANES.map((lane) => (
            <g key={lane.op}>
              <rect
                x={lane.mid[0] - 27}
                y={lane.mid[1] - 9}
                width={54}
                height={18}
                rx={9}
                fill="var(--background)"
                stroke="currentColor"
                strokeOpacity={0.15}
              />
              <text
                x={lane.mid[0]}
                y={lane.mid[1] + 3.5}
                textAnchor="middle"
                fill="currentColor"
                fillOpacity={0.55}
                fontSize={10}
                fontFamily={MONO}
                letterSpacing="0.08em"
              >
                {lane.op}
              </text>
            </g>
          ))}
          <text x={150} y={330} textAnchor="middle" fill="currentColor" fillOpacity={0.6} fontSize={13.5} fontFamily={MONO}>
            postgres
          </text>
          <text x={150} y={350} textAnchor="middle" fill="currentColor" fillOpacity={0.32} fontSize={11} fontFamily={MONO}>
            source
          </text>
          {DESTS.map((dest) => (
            <text
              key={dest.label}
              x={862}
              y={dest.cy + 4}
              fill="currentColor"
              fillOpacity={0.55}
              fontSize={12.5}
              fontFamily={MONO}
            >
              {dest.label}
            </text>
          ))}
        </svg>

        <Drum
          tiers={3}
          priority
          sizes="(min-width: 1024px) 190px, 18vw"
          className="absolute left-[6.5%] top-1/2 w-[19%] -translate-y-[62%]"
        />
        {DESTS.map((dest) => (
          <Drum
            key={dest.label}
            tiers={2}
            sizes="(min-width: 1024px) 120px, 11vw"
            className="absolute left-[77%] w-[12%] -translate-x-1/2 -translate-y-1/2"
            style={{ top: `${(dest.cy / 420) * 100}%` }}
          />
        ))}
      </div>

      {/* ── phones: vertical flow, its own geometry ──────────────────── */}
      <div className="relative mx-auto aspect-[360/430] max-w-[360px] sm:hidden">
        <svg viewBox="0 0 360 430" className="absolute inset-0 h-full w-full text-foreground" aria-hidden>
          <FlowDefs id="hm" />
          <ellipse cx={180} cy={82} rx={128} ry={80} fill="url(#hmGlow)" />
          {M_LANES.map((lane, i) => (
            <Lane key={i} d={lane.d} dur={lane.dur} end={lane.end} id="hm" animate={animate} />
          ))}
          <text x={180} y={196} textAnchor="middle" fill="currentColor" fillOpacity={0.6} fontSize={13} fontFamily={MONO}>
            postgres
          </text>
          {M_DESTS.map((dest) => (
            <text
              key={dest.label}
              x={dest.cx}
              y={382}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity={0.55}
              fontSize={12}
              fontFamily={MONO}
            >
              {dest.label}
            </text>
          ))}
        </svg>

        <Drum
          tiers={3}
          priority
          sizes="30vw"
          className="absolute left-1/2 top-[3%] w-[31%] -translate-x-1/2"
        />
        {M_DESTS.map((dest) => (
          <Drum
            key={dest.label}
            tiers={2}
            sizes="22vw"
            className="absolute top-[63.5%] w-[23%] -translate-x-1/2"
            style={{ left: `${(dest.cx / 360) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
