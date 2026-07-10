import { formatINR, formatCompact, NEUTRAL_COLOR } from "../format";
import { sectionSnapshot } from "./snapshot";
import type { LineItem } from "./types";

const FALLBACK_COLOR = NEUTRAL_COLOR;

// Sorted horizontal bars per section — replaces the earlier treemaps, which
// fell apart on real data: one dominant item swallowed the panel and the small
// items became unlabeled slivers. Here the number is the primary display and
// the bar is secondary, so any scale disparity stays readable.
function BreakdownCard({ title, lineItems, pickedPeriod, colorMap }: {
  title: string;
  lineItems: LineItem[];
  pickedPeriod: string;
  colorMap: Map<string, string>;
}) {
  const all = sectionSnapshot(lineItems, pickedPeriod);
  const positive = all.filter((i) => i.amount >= 0).sort((a, b) => b.amount - a.amount);
  const negatives = all.filter((i) => i.amount < 0);
  const total = positive.reduce((s, i) => s + i.amount, 0) || 1;
  const max = positive.length ? positive[0].amount || 1 : 1;

  return (
    <div className="card-premium p-6">
      <h4 className="text-sm font-bold text-gray-800 mb-4">{title}</h4>
      {positive.length === 0 ? (
        <div className="h-[160px] flex items-center justify-center text-sm text-gray-400">No data at this period.</div>
      ) : (
        <div className="flex flex-col">
          {positive.map((s) => (
            <div key={s.line_key} className="flex items-center gap-3 py-2">
              <span className="w-40 shrink-0 text-xs font-medium text-gray-700 truncate" title={s.line_label}>{s.line_label}</span>
              <div className="flex-1 h-2.5 bg-gray-50 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(s.amount / max) * 100}%`, minWidth: 3, background: colorMap.get(s.line_key) ?? FALLBACK_COLOR }}
                />
              </div>
              <span className="w-32 shrink-0 text-right text-xs tabular-nums font-semibold text-gray-700" title={formatINR(s.amount)}>
                {formatCompact(s.amount)} <span className="text-gray-300 font-normal">· {((s.amount / total) * 100).toFixed(1)}%</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {negatives.length > 0 && (
        <p className="text-[10px] text-gray-400 mt-2">
          {negatives.length} item{negatives.length > 1 ? "s" : ""} with a negative balance ({formatCompact(negatives.reduce((s, i) => s + i.amount, 0))} total) not shown here — see the table for exact figures.
        </p>
      )}
    </div>
  );
}

interface SectionBreakdownBarsProps {
  sourcesItems: LineItem[];
  applicationItems: LineItem[];
  pickedPeriod: string;
  sourcesColorMap: Map<string, string>;
  applicationColorMap: Map<string, string>;
}

export default function SectionBreakdownBars({ sourcesItems, applicationItems, pickedPeriod, sourcesColorMap, applicationColorMap }: SectionBreakdownBarsProps) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <BreakdownCard title="Sources of Funds — Size Breakdown" lineItems={sourcesItems} pickedPeriod={pickedPeriod} colorMap={sourcesColorMap} />
      <BreakdownCard title="Application of Funds — Size Breakdown" lineItems={applicationItems} pickedPeriod={pickedPeriod} colorMap={applicationColorMap} />
    </div>
  );
}
