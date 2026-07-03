import { useMemo } from "react";
import { GitCompareArrows } from "lucide-react";
import { latestOnOrBefore, computeDelta } from "../aggregate";
import { formatINR, formatPct, formatSignedINR, deltaColor } from "../format";
import PeriodPicker from "../shared/PeriodPicker";
import type { LineItem } from "./types";

interface Row {
  line_key: string;
  line_label: string;
  section: "Sources of Funds" | "Application of Funds";
  amountA: number | null;
  amountB: number | null;
  deltaPct: number | null;
  delta: number | null;
}

function buildRows(items: LineItem[], section: Row["section"], a: string, b: string): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.entity_type !== "line_item") continue;
    const pointA = latestOnOrBefore(item.series, a);
    const pointB = latestOnOrBefore(item.series, b);
    if (!pointA && !pointB) continue;
    const amountA = pointA?.amount ?? null;
    const amountB = pointB?.amount ?? null;
    const { pct, delta } = computeDelta(amountB, amountA);
    rows.push({ line_key: item.line_key, line_label: item.line_label, section, amountA, amountB, deltaPct: pct, delta });
  }
  return rows;
}

interface PeriodComparisonPanelProps {
  sourcesItems: LineItem[];
  applicationItems: LineItem[];
  periods: string[]; // ascending ISO dates
  compareA: string;
  compareB: string;
  setCompareA: (v: string) => void;
  setCompareB: (v: string) => void;
}

export default function PeriodComparisonPanel({ sourcesItems, applicationItems, periods, compareA, compareB, setCompareA, setCompareB }: PeriodComparisonPanelProps) {
  const rows = useMemo(() => [
    ...buildRows(sourcesItems, "Sources of Funds", compareA, compareB),
    ...buildRows(applicationItems, "Application of Funds", compareA, compareB),
  ], [sourcesItems, applicationItems, compareA, compareB]);

  if (periods.length < 2) return null;

  const maxAbsPct = Math.max(1, ...rows.filter((r) => r.deltaPct !== null).map((r) => Math.abs(r.deltaPct as number)));

  return (
    <div className="card-premium overflow-hidden">
      <div className="p-6 pb-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><GitCompareArrows size={15} className="text-orange-500" /> Period Comparison</h3>
          <p className="text-[11px] text-gray-400">Pick any two periods to compare line-by-line</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <PeriodPicker periods={periods} value={compareA} onChange={setCompareA} label="From" />
          <PeriodPicker periods={periods} value={compareB} onChange={setCompareB} label="To" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50">
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-6 py-2">Item</th>
              <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">From</th>
              <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">To</th>
              <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">Δ</th>
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2 w-32">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((r) => (
              <tr key={`${r.section}-${r.line_key}`}>
                <td className="px-6 py-2.5 text-xs font-medium text-gray-700">
                  {r.line_label}
                  <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-gray-300">{r.section === "Sources of Funds" ? "SoF" : "AoF"}</span>
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-600 text-right whitespace-nowrap">{r.amountA !== null ? formatINR(r.amountA) : "—"}</td>
                <td className="px-3 py-2.5 text-xs text-gray-600 text-right whitespace-nowrap">{r.amountB !== null ? formatINR(r.amountB) : "—"}</td>
                <td
                  className="px-3 py-2.5 text-xs font-bold text-right whitespace-nowrap"
                  style={{ color: deltaColor(r.delta) }}
                  title={r.deltaPct === null && r.delta !== null ? "Prior value was zero or negative — % not shown, rupee change shown instead" : undefined}
                >
                  {r.deltaPct !== null ? formatPct(r.deltaPct) : formatSignedINR(r.delta)}
                </td>
                <td className="px-3 py-2.5">
                  {r.deltaPct !== null ? (
                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden flex items-center" style={{ direction: r.deltaPct < 0 ? "rtl" : "ltr" }}>
                      <div className="h-full rounded-full" style={{ width: `${(Math.abs(r.deltaPct) / maxAbsPct) * 100}%`, background: deltaColor(r.delta) }} />
                    </div>
                  ) : r.delta !== null ? (
                    <span className="text-[10px] text-gray-300">n/a</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
