import { ArrowLeftRight } from "lucide-react";
import { formatINR, NEUTRAL_COLOR, SUCCESS_COLOR, DANGER_COLOR } from "../format";
import type { LineItem } from "./types";
import { sectionSnapshotTopN, SnapshotItem, NegativeSummary } from "./snapshot";
import ChartLegend from "../shared/ChartLegend";

const OTHER_COLOR = "#D8C7B1"; // sand
const FALLBACK_COLOR = NEUTRAL_COLOR;

function CompositionBar({ label, items, negative, colorMap }: { label: string; items: SnapshotItem[]; negative: NegativeSummary; colorMap: Map<string, string> }) {
  // total is the sum of exactly what's rendered below — this is the fix for a
  // real bug where the denominator used to include negative items that were
  // then dropped from rendering, so visible widths summed past 100% and got
  // silently compressed by flexbox.
  const total = items.reduce((s, i) => s + i.amount, 0) || 1;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-gray-600">{label}</span>
        <span className="text-xs font-semibold text-gray-400">{formatINR(total)}</span>
      </div>
      <div className="flex h-8 w-full rounded-lg overflow-hidden bg-gray-100">
        {items.map((item) => {
          const widthPct = (item.amount / total) * 100;
          if (widthPct <= 0) return null;
          return (
            <div
              key={item.line_key}
              title={`${item.line_label}: ${formatINR(item.amount)} (${widthPct.toFixed(1)}%)`}
              style={{ width: `${widthPct}%`, background: item.line_key === "__other__" ? OTHER_COLOR : colorMap.get(item.line_key) ?? FALLBACK_COLOR }}
              className="h-full transition-all hover:opacity-80"
            />
          );
        })}
      </div>
      <ChartLegend items={items.map((item) => ({
        key: item.line_key, label: item.line_label,
        color: item.line_key === "__other__" ? OTHER_COLOR : colorMap.get(item.line_key) ?? FALLBACK_COLOR,
      }))} />
      {negative.count > 0 && (
        <p className="text-[10px] text-gray-400">
          {negative.count} item{negative.count > 1 ? "s" : ""} with a negative balance ({formatINR(negative.total)} total) not shown here — see the table for exact figures.
        </p>
      )}
    </div>
  );
}

interface MirroredCompositionBarsProps {
  sourcesItems: LineItem[];
  applicationItems: LineItem[];
  pickedPeriod: string;
  sourcesTotal: number | null;
  applicationTotal: number | null;
  sourcesColorMap: Map<string, string>;
  applicationColorMap: Map<string, string>;
}

export default function MirroredCompositionBars({ sourcesItems, applicationItems, pickedPeriod, sourcesTotal, applicationTotal, sourcesColorMap, applicationColorMap }: MirroredCompositionBarsProps) {
  const sources = sectionSnapshotTopN(sourcesItems, pickedPeriod, 7);
  const application = sectionSnapshotTopN(applicationItems, pickedPeriod, 7);

  let chip = "—";
  let chipColor = NEUTRAL_COLOR;
  if (sourcesTotal !== null && applicationTotal !== null && sourcesTotal !== 0) {
    const diffPct = Math.abs(((sourcesTotal - applicationTotal) / sourcesTotal) * 100);
    chip = diffPct < 0.5 ? "Balanced" : `Δ ${diffPct.toFixed(1)}%`;
    chipColor = diffPct < 0.5 ? SUCCESS_COLOR : DANGER_COLOR;
  }

  return (
    <div className="card-premium p-6">
      <h3 className="text-sm font-bold text-gray-800 mb-1">Sources vs Application — Same Ledger, Two Sides</h3>
      <p className="text-[11px] text-gray-400 mb-5">Every rupee sourced is applied somewhere — the two bars represent the same total, broken down differently</p>
      <div className="flex flex-col gap-5">
        {sources.items.length === 0 && application.items.length === 0 ? (
          <div className="h-[120px] flex items-center justify-center text-sm text-gray-400">No data at this period.</div>
        ) : (
          <>
            <CompositionBar label="Sources of Funds" items={sources.items} negative={sources.negative} colorMap={sourcesColorMap} />
            <div className="flex items-center justify-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full" style={{ color: chipColor, background: `${chipColor}1a` }}>
                <ArrowLeftRight size={10} className="inline mr-1" /> {chip}
              </span>
            </div>
            <CompositionBar label="Application of Funds" items={application.items} negative={application.negative} colorMap={applicationColorMap} />
          </>
        )}
      </div>
    </div>
  );
}
