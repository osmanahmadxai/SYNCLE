/**
 * What Syncle does, as a line drawing: one source, one bridge, several
 * destinations. Hairlines and labels only — the same ink, rules and type the
 * rest of the page is made of, drawn rather than written.
 *
 * The viewBox is kept tight and the cap narrow (28rem) so the one drawing
 * reads at both ends: the labels land near 15px on a desktop column and stay
 * above 11px on a phone, rather than shrinking into the hairlines.
 */
const DESTINATIONS = ['MySQL', 'MongoDB', 'Redis'];

export function SyncDiagram() {
  return (
    <svg
      viewBox="0 0 430 170"
      role="img"
      aria-label="A PostgreSQL source on the left, a Syncle bridge in the middle, and MySQL, MongoDB and Redis destinations on the right."
      className="mt-8 w-full max-w-[28rem]"
      fill="none"
    >
      <defs>
        <marker
          id="arrowhead"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="var(--muted-foreground)" />
        </marker>
      </defs>

      <g
        stroke="var(--muted-foreground)"
        strokeWidth="1"
        markerEnd="url(#arrowhead)"
      >
        {/* source into the bridge */}
        <path d="M100 85 H143" />
        {/* the bridge fans out: one trunk, three elbows */}
        <path d="M223 85 H260 V24 H305" />
        <path d="M223 85 H305" />
        <path d="M223 85 H260 V146 H305" />
      </g>

      <g stroke="var(--foreground)" strokeWidth="1" fill="var(--background)">
        <rect x="0.5" y="66.5" width="99" height="37" rx="3" />
        <rect x="148.5" y="66.5" width="74" height="37" rx="3" />
        {DESTINATIONS.map((name, i) => (
          <rect
            key={name}
            x="309.5"
            y={5.5 + i * 61}
            width="119"
            height="37"
            rx="3"
          />
        ))}
      </g>

      <g
        fill="var(--foreground)"
        fontSize="15"
        textAnchor="middle"
        dominantBaseline="middle"
      >
        <text x="50" y="86">
          PostgreSQL
        </text>
        <text x="185.5" y="86">
          Syncle
        </text>
        {DESTINATIONS.map((name, i) => (
          <text key={name} x="369" y={25 + i * 61}>
            {name}
          </text>
        ))}
      </g>
    </svg>
  );
}
