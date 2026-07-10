import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { TrendView, buildColorMap } from "./aggregate";
import type { BsAnalytics, LineItem } from "./balance-sheet/types";
import HeroKpiRow from "./balance-sheet/HeroKpiRow";
import BalanceTrendChart from "./balance-sheet/BalanceTrendChart";
import PeriodPicker from "./shared/PeriodPicker";
import MirroredCompositionBars from "./balance-sheet/MirroredCompositionBars";
import SectionBreakdownBars from "./balance-sheet/SectionBreakdownBars";
import TopMovers from "./balance-sheet/TopMovers";
import PeriodComparisonPanel from "./balance-sheet/PeriodComparisonPanel";
import LineItemTable from "./balance-sheet/LineItemTable";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function subtractOneYear(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y - 1, m - 1, d));
  return dt.toISOString().slice(0, 10);
}

// Canonical, chart-independent ordering (the sheet's own item_no) used to
// assign colors — so a color depends on where an item sits in the sheet, not
// on which chart's own top-N/sort-by-amount logic happens to render it.
function canonicalOrder(lineItems: LineItem[]): string[] {
  return lineItems
    .filter((i) => i.entity_type === "line_item")
    .sort((a, b) => (a.item_no ?? 0) - (b.item_no ?? 0))
    .map((i) => i.line_key);
}

export default function BalanceSheetView({ sheetSourceId }: { sheetSourceId: string }) {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const [data, setData] = useState<BsAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [trendView, setTrendView] = useState<TrendView>("monthly");
  const [snapshotPeriod, setSnapshotPeriod] = useState<string>("");
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");

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

  const periods = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    data.sections.sources_of_funds.total.series.forEach((p) => set.add(p.period_end_date));
    data.sections.application_of_funds.total.series.forEach((p) => set.add(p.period_end_date));
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

  const sourcesColorMap = useMemo(
    () => buildColorMap(canonicalOrder(data?.sections.sources_of_funds.line_items ?? [])),
    [data],
  );
  const applicationColorMap = useMemo(
    () => buildColorMap(canonicalOrder(data?.sections.application_of_funds.line_items ?? [])),
    [data],
  );

  if (!sheetSourceId) return null;
  if (loading) return <div className="flex items-center justify-center py-10 text-sm text-gray-400"><div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin mr-2" /> Loading…</div>;
  if (!data) return <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">No Balance Sheet data yet. Sync this company's sheet.</div>;

  const { kpis, sections } = data;
  const sourcesItems = sections.sources_of_funds.line_items;
  const applicationItems = sections.application_of_funds.line_items;

  return (
    <div className="flex flex-col gap-8">
      {/* One control bar drives every time-dependent card: the trend buckets
          for the charts/tables and the snapshot month for the composition. */}
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
            <PeriodPicker periods={periods} value={snapshotPeriod} onChange={setSnapshotPeriod} label="Snapshot" />
          )}
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Overview</h2>
        <HeroKpiRow kpis={kpis} sourcesSeries={sections.sources_of_funds.total.series} applicationSeries={sections.application_of_funds.total.series} />
        <BalanceTrendChart
          sourcesSeries={sections.sources_of_funds.total.series}
          applicationSeries={sections.application_of_funds.total.series}
          trendView={trendView}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Composition</h2>
        {snapshotPeriod && (
          <>
            <MirroredCompositionBars
              sourcesItems={sourcesItems}
              applicationItems={applicationItems}
              pickedPeriod={snapshotPeriod}
              sourcesTotal={kpis.sources_total_latest}
              applicationTotal={kpis.application_total_latest}
              sourcesColorMap={sourcesColorMap}
              applicationColorMap={applicationColorMap}
            />
            <SectionBreakdownBars sourcesItems={sourcesItems} applicationItems={applicationItems} pickedPeriod={snapshotPeriod} sourcesColorMap={sourcesColorMap} applicationColorMap={applicationColorMap} />
          </>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Movers &amp; Comparison</h2>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <TopMovers sourcesItems={sourcesItems} applicationItems={applicationItems} />
          {compareA && compareB && (
            <PeriodComparisonPanel
              sourcesItems={sourcesItems}
              applicationItems={applicationItems}
              periods={periods}
              compareA={compareA}
              compareB={compareB}
              setCompareA={setCompareA}
              setCompareB={setCompareB}
            />
          )}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Detail</h2>
        <LineItemTable title="Sources of Funds" section={sections.sources_of_funds} trendView={trendView} />
        <LineItemTable title="Application of Funds" section={sections.application_of_funds} trendView={trendView} />
      </section>
    </div>
  );
}
