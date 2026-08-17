// Dependency-free inline SVG sparkline — deliberately not a Recharts chart.
// The line-item table can render one per row (15+ items x 2 sections); a
// Recharts <LineChart> per row would spin up dozens of ResponsiveContainer
// resize observers on a single page.

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}

export default function Sparkline({ values, width = 72, height = 24, color = "#4E6575" }: SparklineProps) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    return <span className="text-[10px] text-gray-400">—</span>;
  }
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const stepX = width / (clean.length - 1);
  const points = clean
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = clean[clean.length - 1];
  const lastX = (clean.length - 1) * stepX;
  const lastY = height - ((last - min) / range) * height;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  );
}
