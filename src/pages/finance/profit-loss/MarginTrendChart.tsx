import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from "recharts";
import { TrendView } from "../aggregate";
import { GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR, GRID_LINE_COLOR, AXIS_TEXT_COLOR } from "../format";
import { marginSeries } from "./plMath";
import type { SeriesPoint } from "./types";
import ChartLegend from "../shared/ChartLegend";

interface MarginTrendChartProps {
  salesSeries: SeriesPoint[];
  grossSeries: SeriesPoint[];
  nettSeries: SeriesPoint[];
  trendView: TrendView; // follows the Revenue & Profit chart's toggle
}

export default function MarginTrendChart({ salesSeries, grossSeries, nettSeries, trendView }: MarginTrendChartProps) {
  const trendData = useMemo(() => {
    const gp = marginSeries(grossSeries, salesSeries, trendView);
    const np = marginSeries(nettSeries, salesSeries, trendView);
    const npByPeriod = new Map(np.map((b) => [b.period, b.pct]));
    return gp.map((b) => ({
      period: b.period,
      "GP margin": b.pct,
      "NP margin": npByPeriod.get(b.period) ?? null,
    }));
  }, [salesSeries, grossSeries, nettSeries, trendView]);

  if (salesSeries.length === 0) return null;

  return (
    <div className="card-premium p-6">
      <div className="mb-5">
        <h3 className="text-sm font-bold text-gray-800">Margin Trend</h3>
        <p className="text-[11px] text-gray-400">Gross &amp; Nett Profit as a share of Sales — each period's profit ÷ that period's sales, never an average of monthly margins</p>
      </div>
      {trendData.length < 2 ? (
        <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">Not enough history yet — sync more periods to see a trend.</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v.toFixed(0)}%`} />
            <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} contentStyle={{ background: "#fff", border: `1px solid ${GRID_LINE_COLOR}`, borderRadius: 12, fontSize: 12 }} />
            <ReferenceLine y={0} stroke={AXIS_TEXT_COLOR} strokeDasharray="4 4" />
            <Line type="monotone" dataKey="GP margin" stroke={GROSS_PROFIT_COLOR} strokeWidth={2} dot={{ fill: GROSS_PROFIT_COLOR, r: 3 }} />
            <Line type="monotone" dataKey="NP margin" stroke={NETT_PROFIT_COLOR} strokeWidth={2} dot={{ fill: NETT_PROFIT_COLOR, r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      )}
      <ChartLegend items={[
        { key: "gp", label: "Gross Profit margin", color: GROSS_PROFIT_COLOR },
        { key: "np", label: "Nett Profit margin", color: NETT_PROFIT_COLOR },
      ]} />
    </div>
  );
}
