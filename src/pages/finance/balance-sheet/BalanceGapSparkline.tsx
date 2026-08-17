// Dependency-free sparkline specifically for a signed "gap" series (e.g. Sources
// minus Application). Unlike the generic Sparkline (single color for the whole
// line), this colors each segment by its own sign against a zero baseline —
// a large negative dip must render red even if the series ends near zero.

import { SUCCESS_COLOR, DANGER_COLOR, GRID_LINE_COLOR } from "../format";

interface BalanceGapSparklineProps {
  values: number[]; // chronological, signed
  width?: number;
  height?: number;
}

export default function BalanceGapSparkline({ values, width = 64, height = 28 }: BalanceGapSparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return <span className="text-[10px] text-gray-400">—</span>;
  }
  const maxAbs = Math.max(...clean.map((v) => Math.abs(v))) || 1;
  const zeroY = height / 2;
  const usableHalf = zeroY - 2;
  const stepX = width / (clean.length - 1);
  const scaleY = (v: number) => zeroY - (v / maxAbs) * usableHalf;

  const segments = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const avg = (clean[i] + clean[i + 1]) / 2;
    segments.push({
      x1: i * stepX, y1: scaleY(clean[i]),
      x2: (i + 1) * stepX, y2: scaleY(clean[i + 1]),
      color: avg >= 0 ? SUCCESS_COLOR : DANGER_COLOR,
    });
  }
  const lastX = (clean.length - 1) * stepX;
  const lastY = scaleY(clean[clean.length - 1]);
  const lastColor = clean[clean.length - 1] >= 0 ? SUCCESS_COLOR : DANGER_COLOR;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke={GRID_LINE_COLOR} strokeWidth={1} strokeDasharray="2 2" />
      {segments.map((s, i) => (
        <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={1.5} strokeLinecap="round" />
      ))}
      <circle cx={lastX} cy={lastY} r={2} fill={lastColor} />
    </svg>
  );
}
