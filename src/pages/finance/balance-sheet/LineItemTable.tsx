import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
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

// Opaque backgrounds for the frozen first column — sticky cells scroll over
// the heatmap-tinted value cells, so they can't be transparent/translucent.
const STICKY_BG = "#ffffff";
const STICKY_HEADER_BG = "#fafafa";
const STICKY_TOTAL_BG = "#fffcf8"; // orange-50/40 flattened onto white
const STICKY_EDGE_SHADOW = "1px 0 0 #f1f5f9";

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
  childCount: number; // > 0 only on parents whose details can be toggled
  values: (number | null)[];
}

interface LineItemTableProps {
  title: string;
  section: Section;
  trendView: TrendView;
}

export default function LineItemTable({ title, section, trendView }: LineItemTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

    const ordered: { item: LineItem; depth: number; childCount: number }[] = [];
    const consumed = new Set<string>();
    for (const item of topLevel) {
      const children = detailsByParent.get(item.line_key);
      ordered.push({ item, depth: 0, childCount: children?.length ?? 0 });
      if (children) {
        consumed.add(item.line_key);
        children.forEach((c) => ordered.push({ item: c, depth: 1, childCount: 0 }));
      }
    }
    // Orphaned details (no parent row in this table) can't be toggled from
    // anywhere, so they stay permanently visible.
    for (const [key, children] of detailsByParent.entries()) {
      if (!consumed.has(key)) children.forEach((c) => ordered.push({ item: c, depth: 1, childCount: 0 }));
    }

    const rows: RowEntry[] = ordered.map(({ item, depth, childCount }) => {
      const buckets = bucketStockSeries(item.series, trendView);
      const byPeriod = new Map(buckets.map((b) => [b.period, b.amount]));
      return { item, depth, childCount, values: periods.map((p) => byPeriod.get(p) ?? null) };
    });

    return { periods, totalByPeriod, rows };
  }, [section, trendView]);

  // Details are collapsed by default — a toggleable child row only renders
  // once its parent has been expanded.
  const parentKeys = useMemo(() => new Set(rows.filter((r) => r.childCount > 0).map((r) => r.item.line_key)), [rows]);
  const visibleRows = rows.filter((r) => {
    if (r.depth === 0) return true;
    const parent = r.item.parent_key;
    if (!parent || !parentKeys.has(parent)) return true; // orphan detail
    return expanded.has(parent);
  });

  const toggle = (key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="card-premium overflow-hidden">
      <div className="p-6 pb-4">
        <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50">
              <th className="sticky left-0 z-10 text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-6 py-2" style={{ background: STICKY_HEADER_BG, boxShadow: STICKY_EDGE_SHADOW }}>Item</th>
              {periods.map((p) => (
                <th key={p} className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2 whitespace-nowrap">{p}</th>
              ))}
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">Trend</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {visibleRows.map((row) => (
              <tr key={row.item.line_key} className={row.depth > 0 ? "text-gray-400" : ""}>
                <td
                  className={`sticky left-0 z-[1] px-6 py-2.5 text-xs whitespace-nowrap ${row.depth > 0 ? "pl-10 text-gray-400" : "font-medium text-gray-700"}`}
                  style={{ background: STICKY_BG, boxShadow: STICKY_EDGE_SHADOW }}
                >
                  {row.childCount > 0 ? (
                    <button onClick={() => toggle(row.item.line_key)} className="flex items-center gap-1 hover:text-orange-500 transition-colors">
                      {expanded.has(row.item.line_key) ? <ChevronDown size={12} className="shrink-0 text-gray-300" /> : <ChevronRight size={12} className="shrink-0 text-gray-300" />}
                      {row.item.line_label}
                      <span className="text-[9px] font-bold text-gray-300">({row.childCount})</span>
                    </button>
                  ) : (
                    row.item.line_label
                  )}
                </td>
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
              <td className="sticky left-0 z-[1] px-6 py-2.5 text-xs text-gray-800" style={{ background: STICKY_TOTAL_BG, boxShadow: STICKY_EDGE_SHADOW }}>Total</td>
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
