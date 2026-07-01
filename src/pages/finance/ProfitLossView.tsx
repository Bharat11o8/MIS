import { useEffect, useMemo, useState } from "react";
import { IndianRupee, TrendingUp, TrendingDown, PiggyBank } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import { bucketFlowSeries, TrendView } from "./aggregate";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function formatINR(n: number) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
function formatCr(n: number) {
  return `₹${(n / 1e7).toFixed(1)}Cr`;
}
function growthColor(v: number | null) {
  if (v === null) return "#94a3b8";
  return v >= 0 ? "#22c55e" : "#ef4444";
}

interface SeriesPoint { period_start_date: string; period_end_date: string; amount: number; percent: number | null; }
interface LineItem { line_key: string; line_label: string; item_no: number | null; entity_type: string; series: SeriesPoint[]; }
interface Section { line_items: LineItem[]; subtotals: LineItem[]; }
interface FyRow { line_key: string; line_label: string; section: string; period_start_date: string; period_end_date: string; amount: number; percent: number | null; }
interface PlAnalytics {
  kpis: {
    sales_accounts_total: number; nett_profit_total: number;
    mom_growth: number | null; mom_period: string | null;
    qoq_growth: number | null; qoq_period: string | null;
    yoy_growth: number | null; yoy_period: string | null;
    yoy_fy_growth: number | null; yoy_fy_period: string | null;
  };
  sections: { trading_account: Section; income_statement: Section };
  headline: { gross_profit: LineItem; nett_profit: LineItem };
  fy_to_date: FyRow[];
}

export default function ProfitLossView({ sheetSourceId }: { sheetSourceId: string }) {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const [data, setData] = useState<PlAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [trendView, setTrendView] = useState<TrendView>("monthly");

  useEffect(() => {
    if (!sheetSourceId) { setData(null); return; }
    setLoading(true);
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=profit_loss`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetSourceId, token]);

  const salesItem = data?.sections.trading_account.line_items.find((i) => i.line_label.trim().toUpperCase() === "SALES ACCOUNTS");

  const trendData = useMemo(() => {
    if (!data) return [];
    const sales = salesItem ? bucketFlowSeries(salesItem.series, trendView) : [];
    const gross = bucketFlowSeries(data.headline.gross_profit.series, trendView);
    const nett = bucketFlowSeries(data.headline.nett_profit.series, trendView);
    const periods = sales.length ? sales.map((b) => b.period) : gross.map((b) => b.period);
    const grossByPeriod = new Map(gross.map((b) => [b.period, b.amount]));
    const nettByPeriod = new Map(nett.map((b) => [b.period, b.amount]));
    const salesByPeriod = new Map(sales.map((b) => [b.period, b.amount]));
    return periods.map((p) => ({
      period: p, "Sales": salesByPeriod.get(p) ?? 0, "Gross Profit": grossByPeriod.get(p) ?? 0, "Nett Profit": nettByPeriod.get(p) ?? 0,
    }));
  }, [data, trendView, salesItem]);

  if (!sheetSourceId) return null;
  if (loading) return <div className="flex items-center justify-center py-10 text-sm text-gray-400"><div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin mr-2" /> Loading…</div>;
  if (!data) return <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">No P&L data yet. Sync this company's sheet.</div>;

  const { kpis } = data;
  const kpiCards = [
    { id: "pl-sales", label: "Total Sales Accounts", value: formatINR(kpis.sales_accounts_total), icon: <IndianRupee size={18} />, color: "#3b82f6", bg: "#eff6ff" },
    { id: "pl-nett", label: "Total Nett Profit", value: formatINR(kpis.nett_profit_total), icon: <PiggyBank size={18} />, color: "#f46617", bg: "#fff7ed" },
    { id: "pl-mom", label: "MoM Growth (Sales)", value: kpis.mom_growth !== null ? `${kpis.mom_growth > 0 ? "+" : ""}${kpis.mom_growth}%` : "—", icon: kpis.mom_growth !== null && kpis.mom_growth < 0 ? <TrendingDown size={18} /> : <TrendingUp size={18} />, color: growthColor(kpis.mom_growth), bg: "#f0fdf4", sub: kpis.mom_period },
    { id: "pl-yoy-fy", label: "YoY Growth (FY, Sales)", value: kpis.yoy_fy_growth !== null ? `${kpis.yoy_fy_growth > 0 ? "+" : ""}${kpis.yoy_fy_growth}%` : "—", icon: kpis.yoy_fy_growth !== null && kpis.yoy_fy_growth < 0 ? <TrendingDown size={18} /> : <TrendingUp size={18} />, color: growthColor(kpis.yoy_fy_growth), bg: "#faf5ff", sub: kpis.yoy_fy_period },
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
            <h3 className="text-sm font-bold text-gray-800">P&L Trend</h3>
            <p className="text-[11px] text-gray-400">Summed across each period — a flow figure, unlike the Balance Sheet</p>
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
            <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{v}</span>} />
            <Line type="monotone" dataKey="Sales" stroke="#3b82f6" strokeWidth={2.5} dot={{ fill: "#3b82f6", r: 4 }} />
            <Line type="monotone" dataKey="Gross Profit" stroke="#a855f7" strokeWidth={2.5} dot={{ fill: "#a855f7", r: 4 }} />
            <Line type="monotone" dataKey="Nett Profit" stroke="#f46617" strokeWidth={2.5} dot={{ fill: "#f46617", r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <SectionTable title="Trading Account" section={data.sections.trading_account} headline={data.headline.gross_profit} headlineLabel="Gross Profit" trendView={trendView} />
      <SectionTable title="Income Statement" section={data.sections.income_statement} headline={data.headline.nett_profit} headlineLabel="Nett Profit" trendView={trendView} />

      {data.fy_to_date.length > 0 && (
        <div className="card-premium p-6">
          <h3 className="text-sm font-bold text-gray-800 mb-1">Full-Year Figures</h3>
          <p className="text-[11px] text-gray-400 mb-4">Annual-span columns from the sheet — not part of the monthly trend above</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50/50">
                  <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-2">Item</th>
                  <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-2">Period</th>
                  <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-2">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.fy_to_date.map((r, i) => (
                  <tr key={`${r.line_key}-${i}`}>
                    <td className="px-4 py-2 text-xs font-medium text-gray-700">{r.line_label}</td>
                    <td className="px-4 py-2 text-xs text-gray-400">{r.period_start_date} → {r.period_end_date}</td>
                    <td className="px-4 py-2 text-xs text-gray-600 text-right">{formatINR(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionTable({
  title, section, headline, headlineLabel, trendView,
}: { title: string; section: Section; headline: LineItem; headlineLabel: string; trendView: TrendView }) {
  const headlineBuckets = bucketFlowSeries(headline.series, trendView);
  const periods = headlineBuckets.map((b) => b.period);
  const headlineByPeriod = new Map(headlineBuckets.map((b) => [b.period, b.amount]));

  const allRows = [...section.line_items, ...section.subtotals].map((item) => {
    const buckets = bucketFlowSeries(item.series, trendView);
    const byPeriod = new Map(buckets.map((b) => [b.period, b.amount]));
    return { ...item, values: periods.map((p) => byPeriod.get(p) ?? null) };
  });

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
            {allRows.map((row) => (
              <tr key={row.line_key}>
                <td className={`px-6 py-2.5 text-xs ${row.entity_type === "subtotal" ? "italic text-gray-400" : "font-medium text-gray-700"}`}>{row.line_label}</td>
                {row.values.map((v, i) => (
                  <td key={i} className="px-3 py-2.5 text-xs text-gray-600 text-right whitespace-nowrap">{v !== null ? formatINR(v) : "—"}</td>
                ))}
              </tr>
            ))}
            <tr className="bg-orange-50/40 font-bold">
              <td className="px-6 py-2.5 text-xs text-gray-800">{headlineLabel}</td>
              {periods.map((p) => (
                <td key={p} className="px-3 py-2.5 text-xs text-gray-900 text-right whitespace-nowrap">{formatINR(headlineByPeriod.get(p) ?? 0)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
