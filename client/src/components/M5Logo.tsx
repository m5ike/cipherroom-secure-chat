// Original inline SVG logo for M5cet. Inspired by motorsport stripes and an
// abstract "M" silhouette. Deliberately not the BMW M3 trademark: stripes are
// blue/purple/red (not blue/violet/red of BMW M, and at a different ratio),
// the "M" is rendered as two diverging speed slashes forming a chevron, the
// container is a hexagonal shield, and there is a numeric "5" stamped in.

type Props = {
  size?: number;
  className?: string;
};

export function M5Logo({ size = 36, className }: Props) {
  return (
    <svg
      role="img"
      aria-label="M5cet logo"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="m5-stripe" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#1c5fd6" />
          <stop offset="33%" stopColor="#1c5fd6" />
          <stop offset="33%" stopColor="#4b2bcd" />
          <stop offset="66%" stopColor="#4b2bcd" />
          <stop offset="66%" stopColor="#d61c2f" />
          <stop offset="100%" stopColor="#d61c2f" />
        </linearGradient>
        <linearGradient id="m5-shell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.04" />
        </linearGradient>
      </defs>

      {/* Hex shield */}
      <path
        d="M32 3 L57 17 L57 47 L32 61 L7 47 L7 17 Z"
        fill="url(#m5-shell)"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />

      {/* Motorsport stripe band across the lower third */}
      <path
        d="M9 41 H55 L52 49 H12 Z"
        fill="url(#m5-stripe)"
      />

      {/* Diverging speed slashes — abstract "M" / chevron */}
      <path
        d="M14 38 L23 16 L32 38 L41 16 L50 38"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Numeric "5" stamped in the lower band */}
      <text
        x="32"
        y="48"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fontWeight="800"
        fontSize="8"
        fill="#ffffff"
        letterSpacing="0.5"
      >
        5
      </text>
    </svg>
  );
}
