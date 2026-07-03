import { useMemo } from "react";
import {
  BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";
import {
  formatINR, formatCr, formatSignedINR, formatCompact,
  REVENUE_COLOR, GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR, SUCCESS_COLOR, DANGER_COLOR,
  GRID_LINE_COLOR, AXIS_TEXT_COLOR,
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
  if (s.kind === "anchor") return ANCHOR_COLORS[s.anchorId ?? ""] ?? AXIS_TEXT_COLOR;
  return s.kind === "up" ? SUCCESS_COLOR : DANGER_COLOR;
}

function BridgeTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const step = payload[0].payload as BridgeStep;
  return (
    <div className="bg-white rounded-xl px-3 py-2 text-xs" style={{ border: `1px solid ${GRID_LINE_COLOR}` }}>
      <p className="font-bold text-gray-800">{step.label}</p>
      <p className="text-gray-600 mt-0.5">
        {step.kind === "anchor" ? formatINR(step.signed) : formatSignedINR(step.signed)}
      </p>
    </div>
  );
}

interface ProfitBridgeWaterfallProps {
  data: PlAnalytics;
  pickedPeriod: string;
}

export default function ProfitBridgeWaterfall({ data, pickedPeriod }: ProfitBridgeWaterfallProps) {
  const bridge = useMemo(() => buildProfitBridge(data, pickedPeriod), [data, pickedPeriod]);

  // Small steps (a few lakh against a crores-scale axis) render as hairline
  // slivers — the label above each bar is what actually carries their value.
  const chartData = useMemo(() => bridge?.steps.map((s) => ({
    ...s,
    labelText: s.kind === "anchor" ? formatCompact(s.signed) : `${s.signed >= 0 ? "+" : "−"}${formatCompact(s.signed)}`,
  })) ?? [], [bridge]);

  return (
    <div className="card-premium p-6">
      <div className="mb-5">
        <h3 className="text-sm font-bold text-gray-800">Profit Bridge — {formatPeriodLabel(pickedPeriod)}</h3>
        <p className="text-[11px] text-gray-400">How Sales became Nett Profit this month. Every step is derived from the sheet's own subtotal and total rows — line items are never re-added.</p>
      </div>
      {!bridge ? (
        <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">
          Sales, Gross Profit and Nett Profit are not all available for this month.
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} margin={{ top: 22, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
              <XAxis dataKey="label" interval={0} tick={{ fontSize: 10, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
              <Tooltip content={<BridgeTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
              <ReferenceLine y={0} stroke={AXIS_TEXT_COLOR} />
              {/* Plain grounded bars (no waterfall float) — each bar is that component's size */}
              {/* minPointSize keeps lakh-sized components visible on a crores-scale axis */}
              <Bar dataKey="value" maxBarSize={56} minPointSize={3}>
                {chartData.map((s) => (
                  <Cell key={s.key} fill={stepColor(s)} fillOpacity={s.kind === "anchor" ? 0.9 : 0.75} />
                ))}
                <LabelList dataKey="labelText" position="top" style={{ fontSize: 10, fontWeight: 600, fill: AXIS_TEXT_COLOR }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
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
