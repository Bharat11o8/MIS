import { useMemo } from "react";
import { GitCompareArrows } from "lucide-react";
import { computeDelta } from "../aggregate";
import { formatINR, formatPct, formatSignedINR, deltaColor } from "../format";
import PeriodPicker from "../shared/PeriodPicker";
import { amountAt } from "./plMath";
import type { LineItem, HeadlineItem } from "./types";

interface Row {
  line_key: string;
  line_label: string;
  section: "Trading" | "Income Stmt";
  headline: boolean;
  amountA: number | null;
  amountB: number | null;
  deltaPct: number | null;
  delta: number | null;
}

// Exact-month lookup on both sides: a P&L amount is a flow for one specific
// month, so a missing month must show "—", never a neighboring month's value.
function buildRow(item: LineItem | HeadlineItem, section: Row["section"], headline: boolean, a: string, b: string): Row | null {
  const amountA = amountAt(item.series, a);
  const amountB = amountAt(item.series, b);
  if (amountA === null && amountB === null) return null;
  const { pct, delta } = computeDelta(amountB, amountA);
  return {
    line_key: item.line_key ?? "headline", line_label: item.line_label ?? "",
    section, headline, amountA, amountB, deltaPct: pct, delta,
  };
}

function buildRows(items: LineItem[], headline: HeadlineItem | null, headlineLabel: string, section: Row["section"], a: string, b: string): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.entity_type !== "line_item") continue;
    const row = buildRow(item, section, false, a, b);
    if (row) rows.push(row);
  }
  if (headline && headline.series.length > 0) {
    const row = buildRow(headline, section, true, a, b);
    if (row) rows.push({ ...row, line_label: headlineLabel });
  }
  return rows;
}

interface PlPeriodComparisonPanelProps {
  tradingItems: LineItem[];
  incomeItems: LineItem[];
  grossProfit: HeadlineItem;
  nettProfit: HeadlineItem;
  periods: string[]; // ascending ISO month-end dates
  compareA: string;
  compareB: string;
  setCompareA: (v: string) => void;
  setCompareB: (v: string) => void;
}

export default function PlPeriodComparisonPanel({
  tradingItems, incomeItems, grossProfit, nettProfit, periods, compareA, compareB, setCompareA, setCompareB,
}: PlPeriodComparisonPanelProps) {
  const rows = useMemo(() => [
    ...buildRows(tradingItems, grossProfit, "Gross Profit", "Trading", compareA, compareB),
    ...buildRows(incomeItems, nettProfit, "Nett Profit", "Income Stmt", compareA, compareB),
  ], [tradingItems, incomeItems, grossProfit, nettProfit, compareA, compareB]);

  if (periods.length < 2) return null;

  const maxAbsPct = Math.max(1, ...rows.filter((r) => r.deltaPct !== null).map((r) => Math.abs(r.deltaPct as number)));

  return (
    <div className="card-premium overflow-hidden">
      <div className="p-6 pb-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><GitCompareArrows size={15} className="text-orange-500" /> Month Comparison</h3>
          <p className="text-[11px] text-gray-500">Pick any two months to compare line-by-line</p>
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
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-6 py-2">Item</th>
              <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">From</th>
              <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">To</th>
              <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">Δ</th>
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2 w-32">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((r) => (
              <tr key={`${r.section}-${r.line_key}`} className={r.headline ? "bg-orange-50/40" : ""}>
                <td className={`px-6 py-2.5 text-xs ${r.headline ? "font-bold text-gray-800" : "font-medium text-gray-700"}`}>
                  {r.line_label}
                  <span className="ml-2 text-[9px] font-bold uppercase tracking-wider text-gray-500">{r.section}</span>
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
                    <span className="text-[10px] text-gray-500">n/a</span>
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
