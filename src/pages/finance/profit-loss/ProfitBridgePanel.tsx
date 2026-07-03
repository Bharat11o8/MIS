import { useMemo } from "react";
import {
  formatINR, formatSignedINR, formatCompact,
  REVENUE_COLOR, GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR, SUCCESS_COLOR, DANGER_COLOR, NEUTRAL_COLOR,
} from "../format";
import { buildProfitBridge, BridgeStep } from "./plMath";
import type { PlAnalytics } from "./types";
import ChartLegend from "../shared/ChartLegend";
import { formatPeriodLabel } from "../shared/PeriodPicker";

const ANCHOR_COLORS: Record<string, string> = {
  sales: REVENUE_COLOR,
  gross_profit: GROSS_PROFIT_COLOR,
  nett_profit: NETT_PROFIT_COLOR,
};

function stepColor(s: BridgeStep): string {
  if (s.kind === "anchor") return ANCHOR_COLORS[s.anchorId ?? ""] ?? NEUTRAL_COLOR;
  return s.kind === "up" ? SUCCESS_COLOR : DANGER_COLOR;
}

interface ProfitBridgePanelProps {
  data: PlAnalytics;
  pickedPeriod: string;
}

// Horizontal "bridge list" rather than a bar chart: with a few lakh sitting
// next to crores, any vertical chart renders the small steps as invisible
// slivers — here the number is the primary display and the bar is secondary.
export default function ProfitBridgePanel({ data, pickedPeriod }: ProfitBridgePanelProps) {
  const bridge = useMemo(() => buildProfitBridge(data, pickedPeriod), [data, pickedPeriod]);
  const maxAbs = bridge ? Math.max(...bridge.steps.map((s) => Math.abs(s.signed)), 1) : 1;

  return (
    <div className="card-premium p-6">
      <div className="mb-4">
        <h3 className="text-sm font-bold text-gray-800">Profit Bridge — {formatPeriodLabel(pickedPeriod)}</h3>
        <p className="text-[11px] text-gray-400">How Sales became Nett Profit this month. Every step is derived from the sheet's own subtotal and total rows — line items are never re-added.</p>
      </div>
      {!bridge ? (
        <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">
          Sales, Gross Profit and Nett Profit are not all available for this month.
        </div>
      ) : (
        <>
          <div className="flex flex-col">
            {bridge.steps.map((s, i) => {
              const isAnchor = s.kind === "anchor";
              return (
                <div
                  key={s.key}
                  className={`flex items-center gap-3 ${isAnchor ? "py-2.5" : "py-1.5"} ${isAnchor && i > 0 ? "border-t border-gray-100" : ""}`}
                >
                  <span
                    className={`w-40 shrink-0 text-xs truncate ${isAnchor ? "font-bold text-gray-800" : "text-gray-500"}`}
                    title={s.label}
                  >
                    {s.label}
                  </span>
                  <div className={`flex-1 ${isAnchor ? "h-3.5" : "h-2.5"} bg-gray-50 rounded-full overflow-hidden`}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(Math.abs(s.signed) / maxAbs) * 100}%`,
                        minWidth: 3,
                        background: stepColor(s),
                        opacity: isAnchor ? 0.9 : 0.75,
                      }}
                    />
                  </div>
                  <span
                    className={`w-24 shrink-0 text-right text-xs tabular-nums ${isAnchor ? "font-bold text-gray-900" : "font-semibold"}`}
                    style={isAnchor ? undefined : { color: stepColor(s) }}
                    title={isAnchor ? formatINR(s.signed) : formatSignedINR(s.signed)}
                  >
                    {isAnchor ? formatCompact(s.signed) : `${s.signed >= 0 ? "+" : "−"}${formatCompact(s.signed)}`}
                  </span>
                </div>
              );
            })}
          </div>
          <ChartLegend items={[
            { key: "sales", label: "Sales", color: REVENUE_COLOR },
            { key: "gross", label: "Gross Profit", color: GROSS_PROFIT_COLOR },
            { key: "nett", label: "Nett Profit", color: NETT_PROFIT_COLOR },
            { key: "up", label: "Adds to profit", color: SUCCESS_COLOR },
            { key: "down", label: "Reduces profit", color: DANGER_COLOR },
          ]} />
          {(bridge.degradedTrading || bridge.degradedIncome) && (
            <p className="text-[10px] text-gray-400 mt-2">
              {bridge.degradedTrading && "Trading-side income and costs are shown as one net step — the sheet's subtotal for this month doesn't reconcile into separate figures. "}
              {bridge.degradedIncome && "Indirect income and costs are shown as one net step — the sheet's subtotal for this month doesn't reconcile into separate figures."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
