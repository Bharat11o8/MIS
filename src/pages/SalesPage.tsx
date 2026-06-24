import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IndianRupee, TrendingUp, MapPin, Boxes, RefreshCw, SlidersHorizontal, X,
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, History,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import MultiSelect from "@/components/ui/MultiSelect";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const CATEGORY_COLORS: Record<string, string> = {
  "Seat Cover": "#f46617", "Accessories": "#3b82f6", "Mats": "#22c55e",
  "Boot & Cabin Mat": "#a855f7", "Electronics": "#f59e0b",
};
const DEPOT_COLORS: Record<string, string> = {
  "Janak Motors": "#3b82f6", "United Auto": "#f46617",
};
const BRAND_FILTER_LABELS: Record<string, string> = { "Combined": "AFAC" };
const BRAND_SPLIT_LABELS: Record<string, string> = {
  "Autoform": "Autoform (Seat Cover, Mats, Electronics)",
  "Autocruze": "Autocruze (Seat Cover, Mats, Electronics)",
  "Combined": "Autoform + Autocruze (Accessories)",
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Types ─────────────────────────────────────────────────────────────────────
interface MonthOption { year: number; month: number; label: string; }
interface FilterOptions { months: MonthOption[]; depots: string[]; brands: string[]; categories: string[]; }
interface ActiveFilters {
  year: number | null; months: number[]; depot: string; brand: string; category: string;
}
const EMPTY_FILTERS: ActiveFilters = { year: null, months: [], depot: "", brand: "", category: "" };

interface SyncResult {
  sync_id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; skipped_tabs: string[]; errors: string[]; status: string;
}
interface SyncHistoryItem {
  id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; status: string; synced_at: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
function formatINR(n: number) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
function formatCr(n: number) {
  return `₹${(n / 1e7).toFixed(1)}Cr`;
}

const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } };

function FilterSelect({
  label, value, onChange, options, allLabel = "All", labels,
}: { label: string; value: string; onChange: (v: string) => void; options: string[]; allLabel?: string; labels?: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-1 min-w-[140px]">
      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</label>
      <Select
        value={value}
        onChange={onChange}
        options={[{ value: "", label: allLabel }, ...options.map((o) => ({ value: o, label: labels?.[o] ?? o }))]}
      />
    </div>
  );
}

export default function SalesPage() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [filters, setFilters] = useState<ActiveFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(true);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [showSyncErrors, setShowSyncErrors] = useState(false);
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // ── Load filter options + sync history once ────────────────────────────────
  useEffect(() => {
    fetch(`${API_URL}/sales/filter-options`, { headers })
      .then((r) => r.json()).then(setFilterOptions).catch(console.error);
    loadHistory();
  }, [token]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/sales/sync-history`, { headers });
      if (res.ok) { setHistory(await res.json()); setHistoryLoaded(true); }
    } catch { /* ignore */ }
  }, [token]);

  // ── Build query params ──────────────────────────────────────────────────────
  const buildParams = useCallback((f: ActiveFilters) => {
    const p = new URLSearchParams();
    if (f.year !== null) {
      const monthsInYear = (filterOptions?.months ?? []).filter((m) => m.year === f.year);
      const selected = f.months.length === 0 ? monthsInYear : monthsInYear.filter((m) => f.months.includes(m.month));
      if (selected.length) {
        p.set("months", selected.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`).join(","));
      }
    }
    if (f.depot) p.set("depot", f.depot);
    if (f.brand) p.set("brand", f.brand);
    if (f.category) p.set("category", f.category);
    return p.toString();
  }, [filterOptions]);

  const fetchData = useCallback(async (f: ActiveFilters) => {
    setLoading(true);
    const qs = buildParams(f);
    try {
      const [aRes, lRes] = await Promise.all([
        fetch(`${API_URL}/sales/analytics${qs ? "?" + qs : ""}`, { headers }),
        fetch(`${API_URL}/sales/list?per_page=20${qs ? "&" + qs : ""}`, { headers }),
      ]);
      const [aData, lData] = await Promise.all([aRes.json(), lRes.json()]);
      aData.trends = (aData.trends ?? []).map((t: any) => ({ ...t, period: `${MONTH_NAMES[t.month - 1]} ${String(t.year).slice(2)}` }));
      setAnalytics(aData);
      setRows(lData.data || []);
      setTotalRows(lData.total || 0);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [token, buildParams]);

  useEffect(() => { fetchData(filters); }, [filters, fetchData]);

  const setFilter = (key: keyof ActiveFilters, value: any) => setFilters((prev) => ({ ...prev, [key]: value }));
  const clearAll = () => setFilters(EMPTY_FILTERS);
  const activeCount = [filters.year !== null, filters.depot, filters.brand, filters.category].filter(Boolean).length;

  const availableYears = useMemo(() => {
    const years = Array.from(new Set((filterOptions?.months ?? []).map((m) => m.year)));
    return years.sort((a, b) => b - a);
  }, [filterOptions]);
  const monthsInSelectedYear = useMemo(() => {
    if (filters.year === null) return [];
    return (filterOptions?.months ?? []).filter((m) => m.year === filters.year).sort((a, b) => a.month - b.month);
  }, [filterOptions, filters.year]);
  const handleYearChange = (yearStr: string) => setFilters((prev) => ({ ...prev, year: yearStr === "" ? null : Number(yearStr), months: [] }));
  const handleMonthsChange = (monthStrs: string[]) => setFilter("months", monthStrs.map(Number));

  // ── Sync Now ─────────────────────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${API_URL}/sales/sync`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      loadHistory();
      fetchData(filters);
    } catch (err: any) {
      setSyncResult({
        sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0,
        skipped_tabs: [], errors: [err.message], status: "Error",
      });
    } finally {
      setSyncing(false);
    }
  };

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const kpiCards = analytics ? [
    {
      id: "sales-total", label: "Total Sales", value: formatINR(analytics.kpis.total_amount),
      icon: <IndianRupee size={18} />, color: "#3b82f6", bg: "#eff6ff",
      sub: activeCount > 0 ? "Filtered result" : "All time",
    },
    {
      id: "sales-mom", label: "MoM Growth",
      value: analytics.kpis.mom_growth !== null ? `${analytics.kpis.mom_growth > 0 ? "+" : ""}${analytics.kpis.mom_growth}%` : "—",
      icon: <TrendingUp size={18} />, color: analytics.kpis.mom_growth >= 0 ? "#22c55e" : "#ef4444",
      bg: analytics.kpis.mom_growth >= 0 ? "#f0fdf4" : "#fef2f2", sub: "Last two months in range",
    },
    {
      id: "sales-depot", label: "Top Depot", value: analytics.kpis.top_depot ?? "—",
      icon: <MapPin size={18} />, color: "#f46617", bg: "#fff7ed", sub: "By total sales value",
    },
    {
      id: "sales-category", label: "Top Category", value: analytics.kpis.top_category ?? "—",
      icon: <Boxes size={18} />, color: "#a855f7", bg: "#faf5ff", sub: "By total sales value",
    },
  ] : [];

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-3">
            <span className="page-title-dark">SALES</span>
            <span className="page-title-orange">PLANT TO DEPOT</span>
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-8 h-0.5 bg-gray-800 rounded" />
            <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
              {analytics ? `${formatINR(analytics.kpis.total_amount)} total` : "Loading…"}
              {activeCount > 0 && <span className="text-orange-500"> · {activeCount} filter{activeCount > 1 ? "s" : ""} active</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => fetchData(filters)}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-orange-500 transition-colors px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200">
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl border transition-all ${
              activeCount > 0 ? "bg-orange-500 text-white border-orange-500" : "text-gray-600 border-gray-200 hover:border-orange-200"
            }`}>
            <SlidersHorizontal size={13} /> Filters
            {activeCount > 0 && (
              <span className="bg-white text-orange-500 text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center">{activeCount}</span>
            )}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 text-xs font-semibold text-white px-4 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 disabled:cursor-not-allowed shadow-lg shadow-orange-200 transition-all">
            {syncing ? (
              <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
            ) : (
              <><RefreshCw size={13} /> Sync Now</>
            )}
          </button>
        </div>
      </motion.div>

      {/* Sync result card */}
      <AnimatePresence>
        {syncResult && (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className={`rounded-2xl border p-5 ${syncResult.rows_failed === 0 ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}
          >
            <div className="flex items-start gap-4">
              {syncResult.rows_failed === 0 ? (
                <CheckCircle2 className="w-6 h-6 text-green-500 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />
              )}
              <div className="flex-1">
                <p className="font-semibold text-gray-800">Sync {syncResult.status === "Error" ? "failed" : "complete"}</p>
                <div className="flex flex-wrap gap-4 mt-2 text-sm">
                  <span className="text-green-700 font-medium">✅ {syncResult.rows_inserted} inserted</span>
                  <span className="text-blue-600 font-medium">↻ {syncResult.rows_updated} updated</span>
                  {syncResult.rows_deleted > 0 && <span className="text-gray-500 font-medium">🗑 {syncResult.rows_deleted} removed</span>}
                  {syncResult.rows_failed > 0 && <span className="text-red-600 font-medium">❌ {syncResult.rows_failed} failed</span>}
                  {syncResult.skipped_tabs.length > 0 && (
                    <span className="text-gray-500 font-medium">⏭ {syncResult.skipped_tabs.length} tab(s) not recognized as a month</span>
                  )}
                </div>
                {syncResult.errors.length > 0 && (
                  <div className="mt-3">
                    <button onClick={() => setShowSyncErrors(!showSyncErrors)}
                      className="text-xs text-amber-700 font-medium flex items-center gap-1 hover:underline">
                      {showSyncErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {showSyncErrors ? "Hide" : "Show"} details ({syncResult.errors.length})
                    </button>
                    {showSyncErrors && (
                      <ul className="mt-2 space-y-0.5 text-xs text-amber-800 bg-white/60 rounded-xl p-3">
                        {syncResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Filter panel */}
      <AnimatePresence>
        {filtersOpen && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <div className="flex flex-wrap gap-4 items-end">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Year</label>
                  <Select
                    value={filters.year !== null ? String(filters.year) : ""}
                    onChange={handleYearChange}
                    options={[{ value: "", label: "All Years" }, ...availableYears.map((y) => ({ value: String(y), label: String(y) }))]}
                    className="min-w-[110px]"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Month</label>
                  <MultiSelect
                    values={filters.months.map(String)}
                    onChange={handleMonthsChange}
                    options={monthsInSelectedYear.map((m) => ({ value: String(m.month), label: MONTH_NAMES[m.month - 1] }))}
                    placeholder="All Months"
                    disabled={filters.year === null}
                    className="min-w-[130px]"
                  />
                </div>
                <div className="w-px h-10 bg-gray-100 hidden xl:block" />
                <FilterSelect label="Depot" value={filters.depot} onChange={(v) => setFilter("depot", v)} options={filterOptions?.depots ?? []} />
                <FilterSelect label="Brand" value={filters.brand} onChange={(v) => setFilter("brand", v)} options={filterOptions?.brands ?? []} labels={BRAND_FILTER_LABELS} />
                <FilterSelect label="Category" value={filters.category} onChange={(v) => setFilter("category", v)} options={filterOptions?.categories ?? []} />
                {activeCount > 0 && (
                  <button onClick={clearAll}
                    className="flex items-center gap-1 text-xs font-semibold text-red-500 hover:text-red-600 px-3 py-2 rounded-xl border border-red-200 hover:bg-red-50 transition-all self-end">
                    <X size={12} /> Clear all
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-400">
          <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          Updating charts…
        </div>
      )}

      {analytics && !loading && (
        <>
          {/* KPI Cards */}
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {kpiCards.map((kpi) => (
              <motion.div key={kpi.id} variants={item} id={kpi.id} className="kpi-card">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: kpi.bg, color: kpi.color }}>
                  {kpi.icon}
                </div>
                <div className="mt-3">
                  <p className="text-2xl font-black text-gray-900">{kpi.value}</p>
                  <p className="text-xs font-bold text-gray-500 mt-0.5">{kpi.label}</p>
                  <p className="text-[11px] text-gray-400">{kpi.sub}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>

          {/* Trend + Category split */}
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <motion.div variants={item} className="card-premium p-6 xl:col-span-2">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><TrendingUp size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Monthly Sales Trend</h3>
                  <p className="text-[11px] text-gray-400">Total sales value per month — filtered result</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={analytics.trends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Line type="monotone" dataKey="amount" stroke="#f46617" strokeWidth={2.5} dot={{ fill: "#f46617", r: 4 }} activeDot={{ r: 6 }} name="Sales" />
                </LineChart>
              </ResponsiveContainer>
            </motion.div>

            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500"><Boxes size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Category Split</h3>
                  <p className="text-[11px] text-gray-400">Sales by category</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={analytics.categories} cx="50%" cy="45%" innerRadius={50} outerRadius={75} paddingAngle={4} dataKey="amount" nameKey="category">
                    {analytics.categories.map((c: any) => <Cell key={c.category} fill={CATEGORY_COLORS[c.category] ?? "#94a3b8"} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{v}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </motion.div>
          </motion.div>

          {/* Depot comparison + Brand split */}
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><MapPin size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Depot Comparison</h3>
                  <p className="text-[11px] text-gray-400">Total sales value per depot</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={analytics.depots} layout="vertical" barSize={28}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <YAxis dataKey="depot" type="category" tick={{ fontSize: 11, fill: "#64748b" }} width={100} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="amount" radius={[0, 6, 6, 0]} name="Sales">
                    {analytics.depots.map((d: any) => <Cell key={d.depot} fill={DEPOT_COLORS[d.depot] ?? "#94a3b8"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </motion.div>

            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-xl bg-purple-50 flex items-center justify-center text-purple-500"><Boxes size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Brand Split</h3>
                  <p className="text-[11px] text-gray-400">By category coverage</p>
                </div>
              </div>
              <div className="space-y-3 mt-2">
                {analytics.brands.map((b: any) => {
                  const total = analytics.brands.reduce((a: number, c: any) => a + c.amount, 0);
                  const pct = total > 0 ? ((b.amount / total) * 100).toFixed(1) : "0.0";
                  return (
                    <div key={b.brand}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="font-medium text-gray-700">{BRAND_SPLIT_LABELS[b.brand] ?? b.brand}</span>
                        <span className="text-gray-400">{formatINR(b.amount)} · {pct}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-orange-400 to-orange-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>

          {/* Detail table */}
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="card-premium overflow-hidden">
            <div className="flex items-center justify-between p-6 pb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><Boxes size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Sales Records</h3>
                  <p className="text-[11px] text-gray-400">Showing {rows.length} of {totalRows.toLocaleString()} rows{activeCount > 0 && " (filtered)"}</p>
                </div>
              </div>
              {activeCount > 0 && (
                <button onClick={clearAll} className="text-xs text-orange-500 font-semibold hover:underline flex items-center gap-1">
                  <X size={11} /> Clear filters
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-gray-50 bg-gray-50/50">
                    {["Month", "Depot", "Brand", "Category", "Qty", "Rate", "Amount"].map((h) => (
                      <th key={h} className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-3 first:pl-6 last:pr-6">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-sm text-gray-400">No sales records match the selected filters.</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-6 py-3 text-xs text-gray-500">{MONTH_NAMES[r.sale_month - 1]} {r.sale_year}</td>
                      <td className="px-4 py-3 text-xs font-semibold text-gray-800">{r.depot}</td>
                      <td className="px-4 py-3 text-xs text-gray-600">{r.brand}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{ background: (CATEGORY_COLORS[r.category] ?? "#94a3b8") + "20", color: CATEGORY_COLORS[r.category] ?? "#94a3b8" }}>
                          {r.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-600">{r.qty !== null ? r.qty.toLocaleString("en-IN") : "—"}</td>
                      <td className="px-4 py-3 text-xs text-gray-600">{r.rate !== null ? formatINR(r.rate) : "—"}</td>
                      <td className="px-4 py-3 text-xs font-bold text-gray-800">{formatINR(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>

          {/* Sync history */}
          <div>
            <h2 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2"><History size={16} className="text-gray-400" /> Sync History</h2>
            {!historyLoaded ? (
              <div className="text-sm text-gray-400">Loading…</div>
            ) : history.length === 0 ? (
              <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-6 text-center">No syncs yet. Click "Sync Now" above to pull data from the Google Sheet.</div>
            ) : (
              <div className="bg-white border border-orange-100 rounded-2xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-orange-50 bg-orange-50/40">
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Inserted</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Updated</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Removed</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Failed</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={h.id} className={i % 2 === 0 ? "bg-white" : "bg-orange-50/20"}>
                        <td className="px-4 py-3 text-right text-green-700 font-medium">{h.rows_inserted}</td>
                        <td className="px-4 py-3 text-right text-blue-600 font-medium">{h.rows_updated}</td>
                        <td className="px-4 py-3 text-right text-gray-500 font-medium">{h.rows_deleted}</td>
                        <td className="px-4 py-3 text-right text-red-600 font-medium">{h.rows_failed}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                            h.status === "Done" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                          }`}>
                            {h.status === "Done" ? <CheckCircle2 size={10} /> : <Clock size={10} />}
                            {h.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(h.synced_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
