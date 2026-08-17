import { useMemo } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { bucketFlowSeries, TrendView } from "../aggregate";
import { formatINR, formatCr, REVENUE_COLOR, GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR, GRID_LINE_COLOR, AXIS_TEXT_COLOR } from "../format";
import type { SeriesPoint } from "./types";
import ChartLegend from "../shared/ChartLegend";

interface RevenueProfitTrendChartProps {
  salesSeries: SeriesPoint[];
  grossSeries: SeriesPoint[];
  nettSeries: SeriesPoint[];
  trendView: TrendView; // controlled by the page-level control bar
}

export default function RevenueProfitTrendChart({ salesSeries, grossSeries, nettSeries, trendView }: RevenueProfitTrendChartProps) {
  const trendData = useMemo(() => {
    const sales = bucketFlowSeries(salesSeries, trendView);
    const gross = bucketFlowSeries(grossSeries, trendView);
    const nett = bucketFlowSeries(nettSeries, trendView);
    const base = sales.length ? sales : gross.length ? gross : nett;
    const grossByPeriod = new Map(gross.map((b) => [b.period, b.amount]));
    const nettByPeriod = new Map(nett.map((b) => [b.period, b.amount]));
    const salesByPeriod = new Map(sales.map((b) => [b.period, b.amount]));
    return base.map((b) => ({
      period: b.period,
      Sales: salesByPeriod.get(b.period) ?? null,
      "Gross Profit": grossByPeriod.get(b.period) ?? null,
      "Nett Profit": nettByPeriod.get(b.period) ?? null,
    }));
  }, [salesSeries, grossSeries, nettSeries, trendView]);

  return (
    <div className="card-premium p-6">
      <div className="mb-5">
        <h3 className="text-sm font-bold text-gray-800">Revenue &amp; Profit Trend</h3>
        <p className="text-[11px] text-gray-500">Summed within each period — a flow figure, unlike the Balance Sheet</p>
      </div>
      {trendData.length < 2 ? (
        <div className="h-[220px] flex items-center justify-center text-sm text-gray-500">Not enough history yet — sync more periods to see a trend.</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
            <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: `1px solid ${GRID_LINE_COLOR}`, borderRadius: 12, fontSize: 12 }} />
            {/* Flat, low-opacity bars + solid lines — printed report, not a SaaS chart */}
            <Bar dataKey="Sales" fill={REVENUE_COLOR} fillOpacity={0.35} radius={[3, 3, 0, 0]} maxBarSize={36} />
            <Line type="monotone" dataKey="Gross Profit" stroke={GROSS_PROFIT_COLOR} strokeWidth={2} dot={{ fill: GROSS_PROFIT_COLOR, r: 3 }} />
            <Line type="monotone" dataKey="Nett Profit" stroke={NETT_PROFIT_COLOR} strokeWidth={2} dot={{ fill: NETT_PROFIT_COLOR, r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <ChartLegend items={[
        { key: "sales", label: "Sales", color: REVENUE_COLOR },
        { key: "gross", label: "Gross Profit", color: GROSS_PROFIT_COLOR },
        { key: "nett", label: "Nett Profit", color: NETT_PROFIT_COLOR },
      ]} />
    </div>
  );
}
