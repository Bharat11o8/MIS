import { useMemo } from "react";
import { bucketFlowSeries, computeDelta, TrendView, DeltaCalc } from "../aggregate";
import { formatINR, formatSignedINR } from "../format";
import { buildSheetOrderedRows, OrderedRow } from "./plMath";
import type { Section, HeadlineItem, SeriesPoint } from "./types";
import Sparkline from "../shared/Sparkline";

// Same deliberate exception as the Balance Sheet table: sparklines this small
// need the original vivid colors to stay readable.
const MAIN_ROW_COLOR = "#3b82f6";
const DETAIL_ROW_COLOR = "#cbd5e1";
const TOTAL_ROW_COLOR = "#f97316";
const SUCCESS_RGB = "78, 125, 87"; // #4E7D57
const DANGER_RGB = "181, 72, 58"; // #B5483A

// Tints by the raw delta's sign, never the percentage's — a suppressed % (base
// was zero/negative) still gets a fixed medium tint.
function heatmapBg(d: DeltaCalc): string {
  if (d.delta === null) return "transparent";
  const alpha = d.pct !== null ? (Math.min(Math.abs(d.pct), 20) / 20) * 0.28 : 0.16;
  return d.delta >= 0 ? `rgba(${SUCCESS_RGB}, ${alpha})` : `rgba(${DANGER_RGB}, ${alpha})`;
}

function heatmapTitle(d: DeltaCalc): string | undefined {
  if (d.reason === "non_positive_base") {
    return `Previous period was zero or negative — % not shown. Changed by ${formatSignedINR(d.delta)}`;
  }
  return undefined;
}

function rowClasses(row: OrderedRow): { td: string; tr: string } {
  switch (row.kind) {
    case "headline": return { td: "font-bold text-gray-800", tr: "bg-orange-50/40" };
    case "subtotal": return { td: "italic text-gray-500", tr: "" };
    case "detail": return { td: "pl-10 text-gray-500", tr: "text-gray-500" };
    default: return { td: "font-medium text-gray-700", tr: "" };
  }
}

function sparkColor(row: OrderedRow): string {
  if (row.kind === "headline") return TOTAL_ROW_COLOR;
  if (row.kind === "detail" || row.kind === "subtotal") return DETAIL_ROW_COLOR;
  return MAIN_ROW_COLOR;
}

interface PlLineItemTableProps {
  title: string;
  section: Section;
  headline: HeadlineItem | null;
  trendView: TrendView;
}

export default function PlLineItemTable({ title, section, headline, trendView }: PlLineItemTableProps) {
  const { periods, rows } = useMemo(() => {
    const ordered = buildSheetOrderedRows(section, headline);

    // Period columns = every bucket any row has data in, in chronological
    // order (bucketFlowSeries already sorts by the bucket's latest date).
    const allPoints: SeriesPoint[] = ordered.flatMap((r) => r.item.series);
    const periods = bucketFlowSeries(allPoints, trendView).map((b) => b.period);

    const rows = ordered.map((row) => {
      const buckets = bucketFlowSeries(row.item.series, trendView);
      const byPeriod = new Map(buckets.map((b) => [b.period, b.amount]));
      return { row, values: periods.map((p) => byPeriod.get(p) ?? null) };
    });
    return { periods, rows };
  }, [section, headline, trendView]);

  return (
    <div className="card-premium overflow-hidden">
      <div className="p-6 pb-4">
        <h3 className="text-sm font-bold text-gray-800">{title}</h3>
        <p className="text-[11px] text-gray-500">Rows in the sheet's own order — subtotals and totals are the sheet's verbatim figures, never recomputed</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50">
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-6 py-2">Item</th>
              {periods.map((p) => (
                <th key={p} className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2 whitespace-nowrap">{p}</th>
              ))}
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map(({ row, values }) => {
              const cls = rowClasses(row);
              return (
                <tr key={row.item.line_key ?? "headline"} className={cls.tr}>
                  <td className={`px-6 py-2.5 text-xs whitespace-nowrap ${cls.td}`}>{row.item.line_label}</td>
                  {values.map((v, i) => {
                    const prev = i > 0 ? values[i - 1] : null;
                    const d = computeDelta(v, prev);
                    return (
                      <td key={i} className={`px-3 py-2.5 text-xs text-right whitespace-nowrap ${row.kind === "headline" ? "font-bold text-gray-900" : "text-gray-600"}`} style={{ background: heatmapBg(d) }} title={heatmapTitle(d)}>
                        {v !== null ? formatINR(v) : "—"}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5">
                    <Sparkline values={row.item.series.map((p) => p.amount)} color={sparkColor(row)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
