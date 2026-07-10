import { useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { bucketStockSeries, TrendView } from "../aggregate";
import { formatINR, formatCr, SOURCES_COLOR, APPLICATION_COLOR, GRID_LINE_COLOR, AXIS_TEXT_COLOR } from "../format";
import type { SeriesPoint } from "./types";
import ChartLegend from "../shared/ChartLegend";

interface BalanceTrendChartProps {
  sourcesSeries: SeriesPoint[];
  applicationSeries: SeriesPoint[];
  trendView: TrendView; // controlled by the page-level control bar
}

export default function BalanceTrendChart({ sourcesSeries, applicationSeries, trendView }: BalanceTrendChartProps) {
  const trendData = useMemo(() => {
    const sources = bucketStockSeries(sourcesSeries, trendView);
    const application = bucketStockSeries(applicationSeries, trendView);
    const appByPeriod = new Map(application.map((b) => [b.period, b.amount]));
    return sources.map((b) => ({ period: b.period, "Sources of Funds": b.amount, "Application of Funds": appByPeriod.get(b.period) ?? b.amount }));
  }, [sourcesSeries, applicationSeries, trendView]);

  return (
    <div className="card-premium p-6">
      <div className="mb-5">
        <h3 className="text-sm font-bold text-gray-800">Balance Sheet Trend</h3>
        <p className="text-[11px] text-gray-400">Point-in-time value at the end of each period — never summed</p>
      </div>
      {trendData.length < 2 ? (
        <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">Not enough history yet — sync more periods to see a trend.</div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
            <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: `1px solid ${GRID_LINE_COLOR}`, borderRadius: 12, fontSize: 12 }} />
            {/* Flat, low-opacity fills rather than a fading gradient — reads as a printed report, not a SaaS chart */}
            <Area type="monotone" dataKey="Sources of Funds" stroke={SOURCES_COLOR} strokeWidth={2} fill={SOURCES_COLOR} fillOpacity={0.12} dot={{ fill: SOURCES_COLOR, r: 3 }} />
            <Area type="monotone" dataKey="Application of Funds" stroke={APPLICATION_COLOR} strokeWidth={2} fill={APPLICATION_COLOR} fillOpacity={0.12} dot={{ fill: APPLICATION_COLOR, r: 3 }} />
          </AreaChart>
        </ResponsiveContainer>
      )}
      <ChartLegend items={[
        { key: "sources", label: "Sources of Funds", color: SOURCES_COLOR },
        { key: "application", label: "Application of Funds", color: APPLICATION_COLOR },
      ]} />
    </div>
  );
}
