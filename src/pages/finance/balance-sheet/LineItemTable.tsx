import { useMemo } from "react";
import { bucketStockSeries, computeDelta, TrendView, DeltaCalc } from "../aggregate";
import { formatINR, formatSignedINR } from "../format";
import type { Section, LineItem } from "./types";
import Sparkline from "../shared/Sparkline";

// Trend sparklines deliberately kept brighter than the rest of the muted
// palette — at this size a muted line reads as flat/dull and the direction
// becomes hard to see, so this one spot stays on the original vivid colors.
const MAIN_ROW_COLOR = "#3b82f6";
const DETAIL_ROW_COLOR = "#cbd5e1";
const TOTAL_ROW_COLOR = "#f97316";
const SUCCESS_RGB = "78, 125, 87"; // #4E7D57
const DANGER_RGB = "181, 72, 58"; // #B5483A

// Tints by the raw delta's sign, never the percentage's — a suppressed % (base
// was zero/negative) still gets a fixed medium tint so it's visibly colored
// without implying a false magnitude scale.
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

interface RowEntry {
  item: LineItem;
  depth: number;
  values: (number | null)[];
}

interface LineItemTableProps {
  title: string;
  section: Section;
  trendView: TrendView;
}

export default function LineItemTable({ title, section, trendView }: LineItemTableProps) {
  const { periods, totalByPeriod, rows } = useMemo(() => {
    const totalBuckets = bucketStockSeries(section.total.series, trendView);
    const periods = totalBuckets.map((b) => b.period);
    const totalByPeriod = new Map(totalBuckets.map((b) => [b.period, b.amount]));

    const topLevel = section.line_items
      .filter((i) => i.entity_type === "line_item")
      .sort((a, b) => (a.item_no ?? 0) - (b.item_no ?? 0));

    const detailsByParent = new Map<string, LineItem[]>();
    for (const item of section.line_items) {
      if (item.entity_type !== "detail") continue;
      const key = item.parent_key ?? "__orphan__";
      if (!detailsByParent.has(key)) detailsByParent.set(key, []);
      detailsByParent.get(key)!.push(item);
    }

    const ordered: { item: LineItem; depth: number }[] = [];
    const consumed = new Set<string>();
    for (const item of topLevel) {
      ordered.push({ item, depth: 0 });
      const children = detailsByParent.get(item.line_key);
      if (children) {
        consumed.add(item.line_key);
        children.forEach((c) => ordered.push({ item: c, depth: 1 }));
      }
    }
    for (const [key, children] of detailsByParent.entries()) {
      if (!consumed.has(key)) children.forEach((c) => ordered.push({ item: c, depth: 1 }));
    }

    const rows: RowEntry[] = ordered.map(({ item, depth }) => {
      const buckets = bucketStockSeries(item.series, trendView);
      const byPeriod = new Map(buckets.map((b) => [b.period, b.amount]));
      return { item, depth, values: periods.map((p) => byPeriod.get(p) ?? null) };
    });

    return { periods, totalByPeriod, rows };
  }, [section, trendView]);

  return (
    <div className="card-premium overflow-hidden">
      <div className="p-6 pb-4">
        <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50">
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-6 py-2">Item</th>
              {periods.map((p) => (
                <th key={p} className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2 whitespace-nowrap">{p}</th>
              ))}
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row) => (
              <tr key={row.item.line_key} className={row.depth > 0 ? "text-gray-400" : ""}>
                <td className={`px-6 py-2.5 text-xs whitespace-nowrap ${row.depth > 0 ? "pl-10 text-gray-400" : "font-medium text-gray-700"}`}>{row.item.line_label}</td>
                {row.values.map((v, i) => {
                  const prev = i > 0 ? row.values[i - 1] : null;
                  const d = computeDelta(v, prev);
                  return (
                    <td key={i} className="px-3 py-2.5 text-xs text-gray-600 text-right whitespace-nowrap" style={{ background: heatmapBg(d) }} title={heatmapTitle(d)}>
                      {v !== null ? formatINR(v) : "—"}
                    </td>
                  );
                })}
                <td className="px-3 py-2.5">
                  <Sparkline values={row.item.series.map((p) => p.amount)} color={row.depth > 0 ? DETAIL_ROW_COLOR : MAIN_ROW_COLOR} />
                </td>
              </tr>
            ))}
            <tr className="bg-orange-50/40 font-bold">
              <td className="px-6 py-2.5 text-xs text-gray-800">Total</td>
              {periods.map((p) => (
                <td key={p} className="px-3 py-2.5 text-xs text-gray-900 text-right whitespace-nowrap">{formatINR(totalByPeriod.get(p) ?? 0)}</td>
              ))}
              <td className="px-3 py-2.5">
                <Sparkline values={section.total.series.map((p) => p.amount)} color={TOTAL_ROW_COLOR} />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
