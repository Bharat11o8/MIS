import { CalendarRange } from "lucide-react";
import { formatINR } from "../format";
import { formatPeriodLabel } from "../shared/PeriodPicker";
import type { FyRow } from "./types";

export default function FyFiguresPanel({ rows }: { rows: FyRow[] }) {
  if (rows.length === 0) return null;

  return (
    <div className="card-premium overflow-hidden">
      <div className="p-6 pb-4">
        <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><CalendarRange size={15} className="text-orange-500" /> Full-Year Figures</h3>
        <p className="text-[11px] text-gray-500">Annual-span columns from the sheet itself — kept apart from the monthly trends above</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50">
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-6 py-2">Item</th>
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">Section</th>
              <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">Period</th>
              <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-500 px-3 py-2">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((r, i) => (
              <tr key={`${r.line_key}-${r.period_start_date}-${i}`}>
                <td className="px-6 py-2.5 text-xs font-medium text-gray-700">{r.line_label}</td>
                <td className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap">
                  {r.section === "trading_account" ? "Trading" : "Income Stmt"}
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                  {formatPeriodLabel(r.period_start_date)} → {formatPeriodLabel(r.period_end_date)}
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-600 text-right whitespace-nowrap">{formatINR(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
