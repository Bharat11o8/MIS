import { useMemo } from "react";
import { buildColorMap } from "../aggregate";
import { formatINR, formatCompact, NEUTRAL_COLOR } from "../format";
import { indirectExpenseBreakdown } from "./plMath";
import type { PlAnalytics } from "./types";
import { formatPeriodLabel } from "../shared/PeriodPicker";

const FALLBACK_COLOR = NEUTRAL_COLOR;

interface IndirectExpenseBreakdownProps {
  data: PlAnalytics;
  pickedPeriod: string;
}

// Sorted horizontal bars rather than a donut — ranked lengths are far easier
// to compare by eye than pie slices, and every item fits without a top-N cap.
export default function IndirectExpenseBreakdown({ data, pickedPeriod }: IndirectExpenseBreakdownProps) {
  const breakdown = useMemo(() => indirectExpenseBreakdown(data, pickedPeriod), [data, pickedPeriod]);

  // Rendered only when the items reconcile with the sheet's own anchors
  // (sum ≈ subtotal − Nett Profit) — never show a composition the sheet's
  // numbers can't back.
  if (!breakdown || !breakdown.reconciles) return null;

  const positive = breakdown.slices.filter((s) => s.amount > 0);
  const negatives = breakdown.slices.filter((s) => s.amount < 0);
  if (positive.length === 0) return null;

  // Slices arrive in the sheet's own item_no order — color by that canonical
  // position so an item keeps its color as the picked month changes.
  const colorMap = buildColorMap(breakdown.slices.map((s) => s.line_key));
  const sorted = [...positive].sort((a, b) => b.amount - a.amount);
  const total = sorted.reduce((s, i) => s + i.amount, 0) || 1;
  const max = sorted[0].amount || 1;

  return (
    <div className="card-premium p-6">
      <div className="mb-4">
        <h4 className="text-sm font-bold text-gray-800">Indirect Expense Breakdown — {formatPeriodLabel(pickedPeriod)}</h4>
        <p className="text-[11px] text-gray-400">The costs between Gross and Nett Profit, verified against the sheet's own subtotal</p>
      </div>
      <div className="flex flex-col">
        {sorted.map((s) => (
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
      {negatives.length > 0 && (
        <p className="text-[10px] text-gray-400 mt-2">
          {negatives.length} item{negatives.length > 1 ? "s" : ""} with a negative amount not shown here — see the table for exact figures.
        </p>
      )}
    </div>
  );
}
