import { Treemap, ResponsiveContainer, Tooltip } from "recharts";
import { formatINR, formatCr, NEUTRAL_COLOR, GRID_LINE_COLOR } from "../format";
import type { LineItem } from "./types";
import { sectionSnapshotTopN } from "./snapshot";
import ChartLegend from "../shared/ChartLegend";

const OTHER_COLOR = "#D8C7B1"; // sand
const FALLBACK_COLOR = NEUTRAL_COLOR;
// Match the app's own font stack explicitly — inline SVG <text> doesn't
// reliably inherit the page font through Recharts' wrappers, so it can fall
// back to the browser's default SVG font, which renders heavier/chunkier at
// the same declared weight than the rest of the UI.
const FONT_FAMILY = "'Segoe UI', -apple-system, Roboto, Helvetica, Arial, sans-serif";

// Rough average glyph width for this sans-serif, used to fit/wrap text to the
// cell rather than clip it. No clip-based safety net behind this on purpose:
// an earlier version used a per-cell SVG clipPath as a backstop, but its id
// was derived from x/y coordinates, and two side-by-side treemap SVGs in the
// same HTML document can legitimately compute identical coordinates for a
// cell in each chart (same container size) — a real, reproduced bug where one
// chart's clip rect silently clipped the other chart's text to a sliver.
function fitText(text: string, maxWidth: number, fontSize: number): string {
  const avgCharWidth = fontSize * 0.6;
  const maxChars = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

// Wraps a label onto at most 2 lines (word boundaries, not mid-word) instead
// of truncating it — "Non Current Assets" reads as "Non Current" / "Assets"
// rather than "Non Curr…".
function wrapTwoLines(text: string, maxWidth: number, fontSize: number): string[] {
  const avgCharWidth = fontSize * 0.6;
  const maxChars = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  if (text.length <= maxChars) return [text];
  const words = text.split(" ");
  let line1 = "";
  let i = 0;
  for (; i < words.length; i++) {
    const candidate = line1 ? `${line1} ${words[i]}` : words[i];
    if (candidate.length > maxChars) {
      if (!line1) { line1 = fitText(words[i], maxWidth, fontSize); i++; }
      break;
    }
    line1 = candidate;
  }
  const rest = words.slice(i).join(" ");
  if (!rest) return [line1];
  return [line1, fitText(rest, maxWidth, fontSize)];
}

// Three-tier adaptive density: bigger cells get a full label/amount/percent
// stack in a larger, hero-numbered style; small cells fall back to a compact
// single-line label + amount; anything smaller than that is just the color.
function TreemapCell(props: any) {
  const { x, y, width, height, name, fill, amount, percent } = props;
  // Recharts also invokes this for the root wrapper node, which has no
  // name/fill of its own — skip drawing anything for that one.
  if (typeof name !== "string" || !fill) return null;
  const baseRect = <rect x={x} y={y} width={width} height={height} style={{ fill, stroke: "#fff", strokeWidth: 2 }} />;

  const tier = width >= 130 && height >= 90 ? "large" : width >= 78 && height >= 56 ? "medium" : width >= 56 && height >= 32 ? "small" : "none";
  if (tier === "none") return baseRect;

  const pad = tier === "large" ? 16 : tier === "medium" ? 10 : 8;
  const availableWidth = width - pad * 2;
  const cy = y + height / 2;
  const pctText = percent !== null && percent !== undefined ? `${percent.toFixed(1)}%` : null;

  if (tier === "small") {
    const labelSize = 11;
    const amountSize = 13;
    const labelLine = fitText(name, availableWidth, labelSize);
    return (
      <g fontFamily={FONT_FAMILY}>
        {baseRect}
        <text x={x + pad} y={cy - 4} fontSize={labelSize} fontWeight={400} fill="rgba(255,255,255,0.9)">{labelLine}</text>
        <text x={x + pad} y={cy + 12} fontSize={amountSize} fontWeight={500} fill="#fff">{formatCr(amount)}</text>
      </g>
    );
  }

  const labelSize = tier === "large" ? 14 : 12;
  const amountSize = tier === "large" ? 20 : 15;
  const pctSize = tier === "large" ? 12 : 11;
  const labelLines = wrapTwoLines(name, availableWidth, labelSize);
  const labelLineHeight = labelSize * 1.25;

  const lines: { text: string; y: number; size: number; weight: number; opacity: number }[] = [];
  let cursor = 0;
  labelLines.forEach((l) => { lines.push({ text: l, y: cursor, size: labelSize, weight: 400, opacity: 1 }); cursor += labelLineHeight; });
  cursor += amountSize * 0.35;
  lines.push({ text: formatCr(amount), y: cursor, size: amountSize, weight: 500, opacity: 1 });
  cursor += amountSize * 0.9;
  if (pctText) lines.push({ text: pctText, y: cursor, size: pctSize, weight: 400, opacity: 0.8 });

  const totalHeight = cursor;
  const startY = cy - totalHeight / 2 + labelSize * 0.8; // cy is already absolute (y + height/2)

  return (
    <g fontFamily={FONT_FAMILY}>
      {baseRect}
      {lines.map((l, i) => (
        <text key={i} x={x + pad} y={startY + l.y} fontSize={l.size} fontWeight={l.weight} fill={`rgba(255,255,255,${l.opacity})`}>
          {l.text}
        </text>
      ))}
    </g>
  );
}

function SectionTreemap({ title, lineItems, pickedPeriod, colorMap }: { title: string; lineItems: LineItem[]; pickedPeriod: string; colorMap: Map<string, string> }) {
  const { items: snapshot, negative } = sectionSnapshotTopN(lineItems, pickedPeriod, 10);
  const data = snapshot.map((d) => ({
    name: d.line_label,
    size: d.amount, // already positive-only — sectionSnapshotTopN excludes negative items rather than flooring them
    fill: d.line_key === "__other__" ? OTHER_COLOR : colorMap.get(d.line_key) ?? FALLBACK_COLOR,
    amount: d.amount,
    percent: d.percent,
  }));

  return (
    <div className="card-premium p-6">
      <h4 className="text-sm font-bold text-gray-800 mb-3">{title}</h4>
      {data.length === 0 ? (
        <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No data at this period.</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <Treemap data={data} dataKey="size" aspectRatio={4 / 3} stroke="#fff" content={<TreemapCell />}>
            <Tooltip
              formatter={(_v: number, _n: string, entry: any) => [
                `${formatINR(entry?.payload?.amount ?? 0)}${entry?.payload?.percent !== null && entry?.payload?.percent !== undefined ? ` (${entry.payload.percent.toFixed(1)}%)` : ""}`,
                entry?.payload?.name,
              ]}
              contentStyle={{ background: "#fff", border: `1px solid ${GRID_LINE_COLOR}`, borderRadius: 12, fontSize: 12 }}
            />
          </Treemap>
        </ResponsiveContainer>
      )}
      <ChartLegend items={data.map((d) => ({ key: d.name, label: d.name, color: d.fill }))} />
      {negative.count > 0 && (
        <p className="text-[10px] text-gray-400 mt-1">
          {negative.count} item{negative.count > 1 ? "s" : ""} with a negative balance ({formatINR(negative.total)} total) not shown here — see the table for exact figures.
        </p>
      )}
    </div>
  );
}

interface SectionTreemapsProps {
  sourcesItems: LineItem[];
  applicationItems: LineItem[];
  pickedPeriod: string;
  sourcesColorMap: Map<string, string>;
  applicationColorMap: Map<string, string>;
}

export default function SectionTreemaps({ sourcesItems, applicationItems, pickedPeriod, sourcesColorMap, applicationColorMap }: SectionTreemapsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SectionTreemap title="Sources of Funds — Size Breakdown" lineItems={sourcesItems} pickedPeriod={pickedPeriod} colorMap={sourcesColorMap} />
      <SectionTreemap title="Application of Funds — Size Breakdown" lineItems={applicationItems} pickedPeriod={pickedPeriod} colorMap={applicationColorMap} />
    </div>
  );
}
