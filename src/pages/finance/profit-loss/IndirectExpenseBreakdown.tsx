import { useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { buildColorMap, topNWithOthers } from "../aggregate";
import { formatINR, NEUTRAL_COLOR, GRID_LINE_COLOR } from "../format";
import { indirectExpenseBreakdown } from "./plMath";
import type { PlAnalytics } from "./types";
import { formatPeriodLabel } from "../shared/PeriodPicker";

const OTHER_COLOR = "#D8C7B1"; // sand
const FALLBACK_COLOR = NEUTRAL_COLOR;

interface IndirectExpenseBreakdownProps {
  data: PlAnalytics;
  pickedPeriod: string;
}

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
  const shown = topNWithOthers(positive, 7);

  return (
    <div className="card-premium p-6">
      <div className="mb-3">
        <h4 className="text-sm font-bold text-gray-800">Indirect Expense Breakdown — {formatPeriodLabel(pickedPeriod)}</h4>
        <p className="text-[11px] text-gray-400">The costs between Gross and Nett Profit, verified against the sheet's own subtotal</p>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={shown} dataKey="amount" nameKey="line_label" innerRadius={60} outerRadius={95} paddingAngle={1.5}>
            {shown.map((d) => (
              <Cell key={d.line_key} fill={d.line_key === "__other__" ? OTHER_COLOR : colorMap.get(d.line_key) ?? FALLBACK_COLOR} />
            ))}
          </Pie>
          <Tooltip
            formatter={(v: number, name: string) => [formatINR(v), name]}
            contentStyle={{ background: "#fff", border: `1px solid ${GRID_LINE_COLOR}`, borderRadius: 12, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
      {negatives.length > 0 && (
        <p className="text-[10px] text-gray-400 mt-1">
          {negatives.length} item{negatives.length > 1 ? "s" : ""} with a negative amount not shown here — see the table for exact figures.
        </p>
      )}
    </div>
  );
}
