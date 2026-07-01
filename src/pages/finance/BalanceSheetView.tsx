import { useEffect, useMemo, useState } from "react";
import { Landmark, Building2, TrendingUp, TrendingDown } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import { bucketStockSeries, TrendView } from "./aggregate";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function formatINR(n: number) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
function formatCr(n: number) {
  return `₹${(n / 1e7).toFixed(1)}Cr`;
}
function deltaColor(v: number | null) {
  if (v === null) return "#94a3b8";
  return v >= 0 ? "#22c55e" : "#ef4444";
}

interface SeriesPoint { period_end_date: string; amount: number; percent: number | null; }
interface LineItem { line_key: string; line_label: string; item_no: number | null; entity_type: string; series: SeriesPoint[]; }
interface Section { line_items: LineItem[]; total: { line_key: string | null; series: SeriesPoint[] }; }
interface BsAnalytics {
  kpis: {
    sources_total_latest: number | null; application_total_latest: number | null;
    mom_delta_pct: number | null; mom_period: string | null;
    qoq_delta_pct: number | null; qoq_period: string | null;
    yoy_delta_pct: number | null; yoy_period: string | null;
  };
  sections: { sources_of_funds: Section; application_of_funds: Section };
}

export default function BalanceSheetView({ sheetSourceId }: { sheetSourceId: string }) {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const [data, setData] = useState<BsAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [trendView, setTrendView] = useState<TrendView>("monthly");

  useEffect(() => {
    if (!sheetSourceId) { setData(null); return; }
    setLoading(true);
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=balance_sheet`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetSourceId, token]);

  const trendData = useMemo(() => {
    if (!data) return [];
    const sources = bucketStockSeries(data.sections.sources_of_funds.total.series, trendView);
    const application = bucketStockSeries(data.sections.application_of_funds.total.series, trendView);
    const appByPeriod = new Map(application.map((b) => [b.period, b.amount]));
    return sources.map((b) => ({ period: b.period, "Sources of Funds": b.amount, "Application of Funds": appByPeriod.get(b.period) ?? b.amount }));
  }, [data, trendView]);

  if (!sheetSourceId) return null;
  if (loading) return <div className="flex items-center justify-center py-10 text-sm text-gray-400"><div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin mr-2" /> Loading…</div>;
  if (!data) return <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">No Balance Sheet data yet. Sync this company's sheet.</div>;

  const { kpis } = data;
  const kpiCards = [
    { id: "bs-sources", label: "Total Sources of Funds", value: kpis.sources_total_latest !== null ? formatINR(kpis.sources_total_latest) : "—", icon: <Landmark size={18} />, color: "#3b82f6", bg: "#eff6ff" },
    { id: "bs-application", label: "Total Application of Funds", value: kpis.application_total_latest !== null ? formatINR(kpis.application_total_latest) : "—", icon: <Building2 size={18} />, color: "#a855f7", bg: "#faf5ff" },
    { id: "bs-mom", label: "MoM Change", value: kpis.mom_delta_pct !== null ? `${kpis.mom_delta_pct > 0 ? "+" : ""}${kpis.mom_delta_pct}%` : "—", icon: kpis.mom_delta_pct !== null && kpis.mom_delta_pct < 0 ? <TrendingDown size={18} /> : <TrendingUp size={18} />, color: deltaColor(kpis.mom_delta_pct), bg: "#f0fdf4", sub: kpis.mom_period },
    { id: "bs-yoy", label: "YoY Change", value: kpis.yoy_delta_pct !== null ? `${kpis.yoy_delta_pct > 0 ? "+" : ""}${kpis.yoy_delta_pct}%` : "—", icon: kpis.yoy_delta_pct !== null && kpis.yoy_delta_pct < 0 ? <TrendingDown size={18} /> : <TrendingUp size={18} />, color: deltaColor(kpis.yoy_delta_pct), bg: "#fff7ed", sub: kpis.yoy_period },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {kpiCards.map((kpi) => (
          <div key={kpi.id} className="kpi-card">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: kpi.bg, color: kpi.color }}>{kpi.icon}</div>
            <div className="mt-3">
              <p className="text-2xl font-black text-gray-900">{kpi.value}</p>
              <p className="text-xs font-bold text-gray-500 mt-0.5">{kpi.label}</p>
              {kpi.sub && <p className="text-[10px] text-gray-400 mt-0.5">{kpi.sub}</p>}
            </div>
          </div>
        ))}
      </div>

      <div className="card-premium p-6">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div>
            <h3 className="text-sm font-bold text-gray-800">Balance Sheet Trend</h3>
            <p className="text-[11px] text-gray-400">Point-in-time value at the end of each period — never summed</p>
          </div>
          <div className="flex items-center bg-gray-100 rounded-xl p-1">
            {(["monthly", "quarterly", "yearly"] as TrendView[]).map((v) => (
              <button key={v} onClick={() => setTrendView(v)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg capitalize transition-all ${trendView === v ? "bg-white text-orange-500 shadow-sm" : "text-gray-500"}`}>
                {v}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
            <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
            <Line type="monotone" dataKey="Sources of Funds" stroke="#3b82f6" strokeWidth={2.5} dot={{ fill: "#3b82f6", r: 4 }} />
            <Line type="monotone" dataKey="Application of Funds" stroke="#a855f7" strokeWidth={2.5} dot={{ fill: "#a855f7", r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <SectionTable title="Sources of Funds" section={data.sections.sources_of_funds} trendView={trendView} />
      <SectionTable title="Application of Funds" section={data.sections.application_of_funds} trendView={trendView} />
    </div>
  );
}

function SectionTable({ title, section, trendView }: { title: string; section: Section; trendView: TrendView }) {
  const totalBuckets = bucketStockSeries(section.total.series, trendView);
  const periods = totalBuckets.map((b) => b.period);
  const rows = section.line_items.map((item) => {
    const buckets = bucketStockSeries(item.series, trendView);
    const byPeriod = new Map(buckets.map((b) => [b.period, b.amount]));
    return { ...item, values: periods.map((p) => byPeriod.get(p) ?? null) };
  });
  const totalByPeriod = new Map(totalBuckets.map((b) => [b.period, b.amount]));

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
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row) => (
              <tr key={row.line_key} className={row.entity_type === "detail" ? "text-gray-400" : ""}>
                <td className={`px-6 py-2.5 text-xs ${row.entity_type === "detail" ? "pl-10 text-gray-400" : "font-medium text-gray-700"}`}>{row.line_label}</td>
                {row.values.map((v, i) => (
                  <td key={i} className="px-3 py-2.5 text-xs text-gray-600 text-right whitespace-nowrap">{v !== null ? formatINR(v) : "—"}</td>
                ))}
              </tr>
            ))}
            <tr className="bg-orange-50/40 font-bold">
              <td className="px-6 py-2.5 text-xs text-gray-800">Total</td>
              {periods.map((p) => (
                <td key={p} className="px-3 py-2.5 text-xs text-gray-900 text-right whitespace-nowrap">{formatINR(totalByPeriod.get(p) ?? 0)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
