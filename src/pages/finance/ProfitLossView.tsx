import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { TrendView } from "./aggregate";
import type { PlAnalytics } from "./profit-loss/types";
import { findSalesItem, indirectExpenseBreakdown } from "./profit-loss/plMath";
import PeriodPicker from "./shared/PeriodPicker";
import PlHeroKpiRow from "./profit-loss/PlHeroKpiRow";
import RevenueProfitTrendChart from "./profit-loss/RevenueProfitTrendChart";
import MarginTrendChart from "./profit-loss/MarginTrendChart";
import ProfitBridgePanel from "./profit-loss/ProfitBridgePanel";
import IndirectExpenseBreakdown from "./profit-loss/IndirectExpenseBreakdown";
import PlTopMovers from "./profit-loss/PlTopMovers";
import PlPeriodComparisonPanel from "./profit-loss/PlPeriodComparisonPanel";
import PlLineItemTable from "./profit-loss/PlLineItemTable";
import FyFiguresPanel from "./profit-loss/FyFiguresPanel";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function subtractOneYear(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y - 1, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

export default function ProfitLossView({ sheetSourceId }: { sheetSourceId: string }) {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const [data, setData] = useState<PlAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [trendView, setTrendView] = useState<TrendView>("monthly");
  const [snapshotPeriod, setSnapshotPeriod] = useState<string>("");
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");

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

  // Every monthly period any row reports — drives the snapshot and comparison pickers.
  const periods = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    const collect = (series: { period_end_date: string }[]) => series.forEach((p) => set.add(p.period_end_date));
    for (const section of [data.sections.trading_account, data.sections.income_statement]) {
      section.line_items.forEach((i) => collect(i.series));
      section.subtotals.forEach((i) => collect(i.series));
    }
    collect(data.headline.gross_profit.series);
    collect(data.headline.nett_profit.series);
    return Array.from(set).sort();
  }, [data]);

  useEffect(() => {
    if (periods.length === 0) return;
    const latest = periods[periods.length - 1];
    setSnapshotPeriod((cur) => (cur && periods.includes(cur) ? cur : latest));
    setCompareB((cur) => (cur && periods.includes(cur) ? cur : latest));
    setCompareA((cur) => {
      if (cur && periods.includes(cur)) return cur;
      const target = subtractOneYear(latest);
      const candidate = [...periods].reverse().find((p) => p <= target);
      return candidate ?? periods[0];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods]);

  if (!sheetSourceId) return null;
  if (loading) return <div className="flex items-center justify-center py-10 text-sm text-gray-400"><div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin mr-2" /> Loading…</div>;
  if (!data) return <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">No P&L data yet. Sync this company's sheet.</div>;

  const { sections, headline } = data;
  const salesSeries = findSalesItem(sections.trading_account)?.series ?? [];
  // Mirrors IndirectExpenseBreakdown's own render gate so the bridge can take
  // the full row when the breakdown hides itself.
  const breakdownVisible = snapshotPeriod
    ? (() => {
        const b = indirectExpenseBreakdown(data, snapshotPeriod);
        return !!b && b.reconciles && b.slices.some((s) => s.amount > 0);
      })()
    : false;

  return (
    <div className="flex flex-col gap-8">
      {/* One control bar drives every time-dependent card: the trend buckets
          for the charts/tables and the snapshot month for the bridge. */}
      <div className="sticky top-3 z-20">
        <div className="bg-white/95 backdrop-blur border border-gray-100 rounded-2xl shadow-sm px-4 py-2.5 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Trend</span>
            <div className="flex items-center bg-gray-100 rounded-xl p-1">
              {(["monthly", "quarterly", "yearly"] as TrendView[]).map((v) => (
                <button key={v} onClick={() => setTrendView(v)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-lg capitalize transition-all ${trendView === v ? "bg-white text-orange-500 shadow-sm" : "text-gray-500"}`}>
                  {v}
                </button>
              ))}
            </div>
          </div>
          {snapshotPeriod && periods.length > 0 && (
            <PeriodPicker periods={periods} value={snapshotPeriod} onChange={setSnapshotPeriod} label="Month" />
          )}
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Overview</h2>
        <PlHeroKpiRow kpis={data.kpis} />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <RevenueProfitTrendChart
            salesSeries={salesSeries}
            grossSeries={headline.gross_profit.series}
            nettSeries={headline.nett_profit.series}
            trendView={trendView}
          />
          <MarginTrendChart
            salesSeries={salesSeries}
            grossSeries={headline.gross_profit.series}
            nettSeries={headline.nett_profit.series}
            trendView={trendView}
          />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Profit Bridge</h2>
        {snapshotPeriod && (
          <div className={`grid grid-cols-1 gap-4 ${breakdownVisible ? "xl:grid-cols-2" : ""}`}>
            <ProfitBridgePanel data={data} pickedPeriod={snapshotPeriod} />
            <IndirectExpenseBreakdown data={data} pickedPeriod={snapshotPeriod} />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Movers &amp; Comparison</h2>
        <PlTopMovers tradingItems={sections.trading_account.line_items} incomeItems={sections.income_statement.line_items} />
        {compareA && compareB && (
          <PlPeriodComparisonPanel
            tradingItems={sections.trading_account.line_items}
            incomeItems={sections.income_statement.line_items}
            grossProfit={headline.gross_profit}
            nettProfit={headline.nett_profit}
            periods={periods}
            compareA={compareA}
            compareB={compareB}
            setCompareA={setCompareA}
            setCompareB={setCompareB}
          />
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Detail</h2>
        <PlLineItemTable title="Trading Account" section={sections.trading_account} headline={headline.gross_profit} trendView={trendView} />
        <PlLineItemTable title="Income Statement" section={sections.income_statement} headline={headline.nett_profit} trendView={trendView} />
        <FyFiguresPanel rows={data.fy_to_date} />
      </section>
    </div>
  );
}
