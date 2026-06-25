import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IndianRupee, Target, TrendingUp, Users, RefreshCw, Plus, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Clock, History, SlidersHorizontal, X,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatINR(n: number) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
function formatCr(n: number) {
  return `₹${(n / 1e7).toFixed(1)}Cr`;
}
function pctColor(pct: number | null) {
  if (pct === null) return "#94a3b8";
  if (pct >= 100) return "#22c55e";
  if (pct >= 70) return "#f59e0b";
  return "#ef4444";
}
// The target is quarterly, not monthly — comparing one month's achieved against
// the full quarterly target always reads low, so red/orange/green thresholds
// are meaningless (and misleading) once a single month is selected. Use the
// brand accent instead of grey so it still reads as "a real number" rather
// than a disabled/empty state.
function pctColorScoped(pct: number | null, monthFilter: MonthFilter) {
  return monthFilter !== "ALL" ? "#f46617" : pctColor(pct);
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface SheetSourceItem {
  id: string; sheet_id: string; label: string; calendar_year: number;
  created_at: string; last_synced_at: string | null; last_sync_status: string | null;
}
interface MonthlyAmount { month: number; sam: number; ev: number; }
interface DistributorRow {
  distributor: string; area_head: string | null; target: number | null;
  monthly: MonthlyAmount[]; achieved: number; attainment_pct: number | null;
}
interface AreaHeadGroup {
  area_head: string; target: number; achieved: number; attainment_pct: number | null;
  monthly: MonthlyAmount[];
  distributors: DistributorRow[];
}
interface Analytics {
  kpis: { total_target: number; total_achieved: number; attainment_pct: number | null; top_area_head: string | null };
  area_heads: AreaHeadGroup[];
  depot_direct: DistributorRow[];
  company_total: {
    target: number; achieved_distributors: number; achieved_depot_direct: number;
    achieved_total: number; attainment_pct: number | null; monthly: MonthlyAmount[];
  };
}
type CategoryFilter = "ALL" | "SAM" | "EV";
type MonthFilter = number | "ALL";
interface SyncResult {
  sync_id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; errors: string[]; status: string;
}
interface SyncHistoryItem {
  id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; status: string; synced_at: string;
}

function allMonths(analytics: Analytics): number[] {
  const months = new Set<number>();
  for (const g of analytics.area_heads) for (const d of g.distributors) for (const m of d.monthly) months.add(m.month);
  for (const d of analytics.depot_direct) for (const m of d.monthly) months.add(m.month);
  return Array.from(months).sort((a, b) => a - b);
}
function monthValue(d: DistributorRow, month: number, category: "sam" | "ev"): number {
  return d.monthly.find((m) => m.month === month)?.[category] ?? 0;
}
function sumMonthly(monthly: MonthlyAmount[], monthFilter: MonthFilter, categoryFilter: CategoryFilter): number {
  let total = 0;
  for (const m of monthly) {
    if (monthFilter !== "ALL" && m.month !== monthFilter) continue;
    if (categoryFilter === "ALL") total += m.sam + m.ev;
    else if (categoryFilter === "SAM") total += m.sam;
    else total += m.ev;
  }
  return Math.round(total * 100) / 100;
}
function pctOf(achieved: number, target: number | null): number | null {
  return target ? Math.round((achieved / target) * 100 * 100) / 100 : null;
}

export default function DepotToDistributorTab() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [sheetSources, setSheetSources] = useState<SheetSourceItem[]>([]);
  const [selectedSheetId, setSelectedSheetId] = useState<string>("");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("ALL");
  const [monthFilter, setMonthFilter] = useState<MonthFilter>("ALL");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = (categoryFilter !== "ALL" ? 1 : 0) + (monthFilter !== "ALL" ? 1 : 0);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newLink, setNewLink] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newYear, setNewYear] = useState(String(new Date().getFullYear()));
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [showSyncErrors, setShowSyncErrors] = useState(false);
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const loadSheetSources = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/distributor-sales/sheet-sources`, { headers });
      if (!res.ok) return;
      const data: SheetSourceItem[] = await res.json();
      setSheetSources(data);
      if (data.length && !selectedSheetId) setSelectedSheetId(data[0].id);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { loadSheetSources(); }, [loadSheetSources]);

  const loadHistory = useCallback(async (sheetId: string) => {
    try {
      const res = await fetch(`${API_URL}/distributor-sales/sync-history?sheet_source_id=${sheetId}`, { headers });
      if (res.ok) { setHistory(await res.json()); setHistoryLoaded(true); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadAnalytics = useCallback(async (sheetId: string) => {
    if (!sheetId) { setAnalytics(null); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/distributor-sales/analytics?sheet_source_id=${sheetId}`, { headers });
      if (res.ok) setAnalytics(await res.json());
      else setAnalytics(null);
    } catch { setAnalytics(null); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (selectedSheetId) { loadAnalytics(selectedSheetId); loadHistory(selectedSheetId); setSyncResult(null); }
  }, [selectedSheetId, loadAnalytics, loadHistory]);

  // ── Add sheet ────────────────────────────────────────────────────────────────
  const handleAddSheet = async () => {
    if (!newLink.trim() || !newLabel.trim() || !newYear.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`${API_URL}/distributor-sales/sheet-sources`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: newLink.trim(), label: newLabel.trim(), calendar_year: Number(newYear) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not add sheet");
      setNewLink(""); setNewLabel(""); setShowAddForm(false);
      await loadSheetSources();
      setSelectedSheetId(data.id);
    } catch (e: any) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  };

  // ── Sync ─────────────────────────────────────────────────────────────────────
  const handleSync = async () => {
    if (!selectedSheetId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${API_URL}/distributor-sales/sheet-sources/${selectedSheetId}/sync`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      loadHistory(selectedSheetId);
      loadAnalytics(selectedSheetId);
      loadSheetSources();
    } catch (err: any) {
      setSyncResult({
        sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0,
        errors: [err.message], status: "Error",
      });
    } finally {
      setSyncing(false);
    }
  };

  const toggleHead = (areaHead: string) => {
    setExpandedHeads((prev) => {
      const next = new Set(prev);
      next.has(areaHead) ? next.delete(areaHead) : next.add(areaHead);
      return next;
    });
  };

  const months = useMemo(() => (analytics ? allMonths(analytics) : []), [analytics]);
  const visibleMonths = monthFilter === "ALL" ? months : [monthFilter];
  const visibleCategories: ("sam" | "ev")[] = categoryFilter === "ALL" ? ["sam", "ev"] : [categoryFilter === "SAM" ? "sam" : "ev"];

  // Filters apply only to "achieved" figures, re-derived from the same monthly
  // breakdown the backend already sends — target stays the full-quarter value
  // from the sheet (comparing partial achieved to the full target is a normal
  // "progress toward target" reading, not a fabricated number).
  const filteredAreaHeads = useMemo(() => {
    if (!analytics) return [];
    return analytics.area_heads.map((g) => {
      const achieved = sumMonthly(g.monthly, monthFilter, categoryFilter);
      const distributors = g.distributors.map((d) => {
        const dAchieved = sumMonthly(d.monthly, monthFilter, categoryFilter);
        return { ...d, achieved: dAchieved, attainment_pct: pctOf(dAchieved, d.target) };
      });
      return { ...g, achieved, attainment_pct: pctOf(achieved, g.target), distributors };
    });
  }, [analytics, monthFilter, categoryFilter]);

  const filteredCompanyTotal = useMemo(() => {
    if (!analytics) return null;
    const achieved = sumMonthly(analytics.company_total.monthly, monthFilter, categoryFilter);
    return { target: analytics.company_total.target, achieved, attainment_pct: pctOf(achieved, analytics.company_total.target) };
  }, [analytics, monthFilter, categoryFilter]);

  const topAreaHead = useMemo(() => {
    return filteredAreaHeads.reduce<AreaHeadGroup | null>((best, g) => {
      if (g.attainment_pct === null) return best;
      if (!best || best.attainment_pct === null || g.attainment_pct > best.attainment_pct) return g;
      return best;
    }, null);
  }, [filteredAreaHeads]);

  // Always reflects both categories regardless of the category filter — this is
  // the "how is SAM vs EV doing" at-a-glance split the filter itself can't show.
  const samEvSplit = useMemo(() => {
    if (!analytics) return { sam: 0, ev: 0 };
    return {
      sam: sumMonthly(analytics.company_total.monthly, monthFilter, "SAM"),
      ev: sumMonthly(analytics.company_total.monthly, monthFilter, "EV"),
    };
  }, [analytics, monthFilter]);

  const chartData = useMemo(
    () => filteredAreaHeads.map((g) => ({ area_head: g.area_head, attainment_pct: g.attainment_pct ?? 0 })),
    [filteredAreaHeads]
  );

  const distributorChartData = useMemo(() => {
    return filteredAreaHeads
      .flatMap((g) => g.distributors)
      .sort((a, b) => (b.attainment_pct ?? -1) - (a.attainment_pct ?? -1));
  }, [filteredAreaHeads]);

  const kpiCards = analytics && filteredCompanyTotal ? [
    { id: "dd-target", label: "Total Target", value: formatINR(filteredCompanyTotal.target), icon: <Target size={18} />, color: "#3b82f6", bg: "#eff6ff" },
    { id: "dd-achieved", label: "Total Achieved", value: formatINR(filteredCompanyTotal.achieved), icon: <IndianRupee size={18} />, color: "#f46617", bg: "#fff7ed" },
    {
      id: "dd-attainment", label: "Attainment %",
      value: filteredCompanyTotal.attainment_pct !== null ? `${filteredCompanyTotal.attainment_pct}%` : "—",
      icon: <TrendingUp size={18} />, color: pctColorScoped(filteredCompanyTotal.attainment_pct, monthFilter), bg: "#f0fdf4",
    },
    { id: "dd-top", label: "Top Area Head", value: topAreaHead?.area_head ?? "—", icon: <Users size={18} />, color: "#a855f7", bg: "#faf5ff" },
  ] : [];

  return (
    <div className="flex flex-col gap-5">
      {/* Sheet picker + actions */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Select
            value={selectedSheetId}
            onChange={setSelectedSheetId}
            placeholder="Select a quarter…"
            options={sheetSources.map((s) => ({ value: s.id, label: s.label }))}
            className="min-w-[160px]"
          />
          <button onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
            <Plus size={13} /> Add Sheet
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl border transition-all ${
              activeFilterCount > 0 ? "bg-orange-500 text-white border-orange-500" : "text-gray-600 border-gray-200 hover:border-orange-200"
            }`}>
            <SlidersHorizontal size={13} /> Filters
            {activeFilterCount > 0 && (
              <span className="bg-white text-orange-500 text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center">{activeFilterCount}</span>
            )}
          </button>
          <button
            onClick={handleSync}
            disabled={syncing || !selectedSheetId}
            className="flex items-center gap-2 text-xs font-semibold text-white px-4 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 disabled:cursor-not-allowed shadow-lg shadow-orange-200 transition-all">
            {syncing ? (
              <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
            ) : (
              <><RefreshCw size={13} /> Sync Now</>
            )}
          </button>
        </div>
      </div>

      {/* Add sheet form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm flex flex-col gap-3">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Sheet link or ID</label>
                  <input value={newLink} onChange={(e) => setNewLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…"
                    className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                </div>
                <div className="flex flex-col gap-1 min-w-[140px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Label</label>
                  <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Q1 FY26"
                    className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                </div>
                <div className="flex flex-col gap-1 min-w-[100px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Calendar Year</label>
                  <input type="number" value={newYear} onChange={(e) => setNewYear(e.target.value)}
                    className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                </div>
                <button onClick={handleAddSheet} disabled={adding}
                  className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
                  {adding ? "Adding…" : "Add"}
                </button>
                <button onClick={() => setShowAddForm(false)} className="h-10 px-3 text-xs font-medium text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              {addError && <p className="text-xs text-red-600">{addError}</p>}
              <p className="text-[11px] text-gray-400">
                Make sure this sheet is shared (Viewer is enough) with the service account's email before syncing — Google Sheets access is per-document and isn't granted automatically.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sync result */}
      <AnimatePresence>
        {syncResult && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className={`rounded-2xl border p-5 ${syncResult.rows_failed === 0 ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
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
                  {syncResult.rows_deleted > 0 && <span className="text-gray-500 font-medium">🗑 {syncResult.rows_deleted} removed</span>}
                  {syncResult.rows_failed > 0 && <span className="text-red-600 font-medium">❌ {syncResult.rows_failed} failed</span>}
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

      {/* Filter panel — same visual pattern as Plant to Depot's */}
      <AnimatePresence>
        {filtersOpen && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <div className="flex flex-wrap gap-4 items-end">
                <div className="flex flex-col gap-1 min-w-[140px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Category</label>
                  <Select
                    value={categoryFilter === "ALL" ? "" : categoryFilter}
                    onChange={(v) => setCategoryFilter((v || "ALL") as CategoryFilter)}
                    options={[{ value: "", label: "All Categories" }, { value: "SAM", label: "SAM" }, { value: "EV", label: "EV" }]}
                  />
                </div>
                <div className="flex flex-col gap-1 min-w-[140px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Month</label>
                  <Select
                    value={monthFilter === "ALL" ? "" : String(monthFilter)}
                    onChange={(v) => setMonthFilter(v ? Number(v) : "ALL")}
                    options={[{ value: "", label: "All Months" }, ...months.map((m) => ({ value: String(m), label: MONTH_NAMES[m] }))]}
                  />
                </div>
                {activeFilterCount > 0 && (
                  <button onClick={() => { setCategoryFilter("ALL"); setMonthFilter("ALL"); }}
                    className="flex items-center gap-1 text-xs font-semibold text-red-500 hover:text-red-600 px-3 py-2 rounded-xl border border-red-200 hover:bg-red-50 transition-all self-end">
                    <X size={12} /> Clear all
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!selectedSheetId && (
        <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">
          No quarter registered yet. Click "Add Sheet" above to register the team's quarterly Depot-to-Distributor sheet.
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-400">
          <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          Loading…
        </div>
      )}

      {analytics && !loading && (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {kpiCards.map((kpi) => (
              <div key={kpi.id} className="kpi-card">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: kpi.bg, color: kpi.color }}>
                  {kpi.icon}
                </div>
                <div className="mt-3">
                  <p className="text-2xl font-black text-gray-900">{kpi.value}</p>
                  <p className="text-xs font-bold text-gray-500 mt-0.5">{kpi.label}</p>
                </div>
              </div>
            ))}
          </div>

          {/* SAM vs EV split — always shows both, independent of the category filter below */}
          <div className="card-premium p-5">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">SAM vs EV Split{monthFilter !== "ALL" ? ` — ${MONTH_NAMES[monthFilter]}` : ""}</h3>
            <div className="flex flex-col gap-3">
              {[
                { label: "SAM", value: samEvSplit.sam, color: "#3b82f6" },
                { label: "EV", value: samEvSplit.ev, color: "#a855f7" },
              ].map((row) => {
                const maxVal = Math.max(samEvSplit.sam, samEvSplit.ev, 1);
                const widthPct = Math.max(2, (Math.abs(row.value) / maxVal) * 100);
                return (
                  <div key={row.label} className="flex items-center gap-3">
                    <span className="text-xs font-bold text-gray-600 w-8">{row.label}</span>
                    <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${widthPct}%`, background: row.color }} />
                    </div>
                    <span className="text-xs font-semibold text-gray-800 w-24 text-right">{formatINR(row.value)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Area Head attainment chart */}
          {chartData.length > 0 && (
            <div className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><Users size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Area Head Attainment</h3>
                  <p className="text-[11px] text-gray-400">% of quarterly target achieved per ASM</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 32)}>
                <BarChart data={chartData} layout="vertical" barSize={18}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                  <YAxis dataKey="area_head" type="category" tick={{ fontSize: 11, fill: "#64748b" }} width={120} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => `${v}%`} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="attainment_pct" radius={[0, 6, 6, 0]} name="Attainment">
                    {chartData.map((d) => <Cell key={d.area_head} fill={pctColorScoped(d.attainment_pct, monthFilter)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Top Distributors — flat, ungrouped view so distributor performance isn't buried under ASM rows */}
          {distributorChartData.length > 0 && (
            <div className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500"><TrendingUp size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Distributors by Attainment</h3>
                  <p className="text-[11px] text-gray-400">Every distributor, ranked — best to worst</p>
                </div>
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: 480 }}>
                <ResponsiveContainer width="100%" height={Math.max(200, distributorChartData.length * 28)}>
                  <BarChart data={distributorChartData} layout="vertical" barSize={14}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                    <YAxis dataKey="distributor" type="category" tick={{ fontSize: 10, fill: "#64748b" }} width={150} axisLine={false} tickLine={false} />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as DistributorRow;
                        return (
                          <div className="bg-white border border-gray-100 rounded-xl p-3 text-xs shadow-lg">
                            <p className="font-bold text-gray-800">{d.distributor}</p>
                            <p className="text-gray-400 mb-1">{d.area_head}</p>
                            <p className="text-gray-600">Target: {formatINR(d.target ?? 0)}</p>
                            <p className="text-gray-600">Achieved: {formatINR(d.achieved)}</p>
                            <p className="font-bold mt-1" style={{ color: pctColorScoped(d.attainment_pct, monthFilter) }}>
                              {d.attainment_pct !== null ? `${d.attainment_pct}%` : "—"}
                            </p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="attainment_pct" radius={[0, 6, 6, 0]} name="Attainment">
                      {distributorChartData.map((d) => <Cell key={d.distributor} fill={pctColorScoped(d.attainment_pct, monthFilter)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Area-Head grouped table */}
          <div className="card-premium overflow-hidden">
            <div className="p-6 pb-4">
              <h3 className="text-sm font-bold text-gray-800">Distributors by Area Head</h3>
              <p className="text-[11px] text-gray-400">Click a row to expand its distributors</p>
            </div>
            <div className="divide-y divide-gray-50">
              {filteredAreaHeads.map((g) => (
                <div key={g.area_head}>
                  <button onClick={() => toggleHead(g.area_head)}
                    className="w-full flex items-center justify-between px-6 py-3 hover:bg-gray-50/50 transition-colors text-left">
                    <div className="flex items-center gap-2">
                      {expandedHeads.has(g.area_head) ? <ChevronUp size={14} className="text-gray-400" /> : <ChevronDown size={14} className="text-gray-400" />}
                      <span className="text-sm font-semibold text-gray-800">{g.area_head}</span>
                      <span className="text-[11px] text-gray-400">({g.distributors.length} distributor{g.distributors.length > 1 ? "s" : ""})</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <span className="text-gray-500">Target {formatCr(g.target)}</span>
                      <span className="text-gray-700 font-semibold">Achieved {formatCr(g.achieved)}</span>
                      <span className="font-bold px-2 py-0.5 rounded-full" style={{ color: pctColorScoped(g.attainment_pct, monthFilter), background: pctColorScoped(g.attainment_pct, monthFilter) + "20" }}>
                        {g.attainment_pct !== null ? `${g.attainment_pct}%` : "—"}
                      </span>
                    </div>
                  </button>
                  <AnimatePresence>
                    {expandedHeads.has(g.area_head) && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }} className="overflow-hidden">
                        <div className="overflow-x-auto pb-2">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-gray-50/50">
                                <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-6 py-2">Distributor</th>
                                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">Target</th>
                                {visibleMonths.map((m) => visibleCategories.map((cat) => (
                                  <th key={`${m}-${cat}`} className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">{MONTH_NAMES[m]} {cat.toUpperCase()}</th>
                                )))}
                                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">Achieved</th>
                                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-2">%</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {g.distributors.map((d) => (
                                <tr key={d.distributor} className="hover:bg-gray-50/30">
                                  <td className="px-6 py-2.5 text-xs font-medium text-gray-700">{d.distributor}</td>
                                  <td className="px-3 py-2.5 text-xs text-gray-500 text-right">{d.target !== null ? formatINR(d.target) : "—"}</td>
                                  {visibleMonths.map((m) => visibleCategories.map((cat) => (
                                    <td key={`${m}-${cat}`} className="px-3 py-2.5 text-xs text-gray-500 text-right whitespace-nowrap">
                                      {formatINR(monthValue(d, m, cat))}
                                    </td>
                                  )))}
                                  <td className="px-3 py-2.5 text-xs font-semibold text-gray-800 text-right">{formatINR(d.achieved)}</td>
                                  <td className="px-4 py-2.5 text-xs font-bold text-right" style={{ color: pctColorScoped(d.attainment_pct, monthFilter) }}>
                                    {d.attainment_pct !== null ? `${d.attainment_pct}%` : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
          </div>

          {/* Company Total */}
          {filteredCompanyTotal && (
            <div className="card-premium p-6 max-w-md">
              <h3 className="text-sm font-bold text-gray-800 mb-3">Company Total</h3>
              <div className="space-y-2 text-xs">
                <div className="flex justify-between"><span className="text-gray-500">Target</span><span className="font-semibold text-gray-800">{formatINR(filteredCompanyTotal.target)}</span></div>
                <div className="flex justify-between border-t border-gray-100 pt-2"><span className="text-gray-700 font-semibold">Achieved</span><span className="font-bold text-gray-900">{formatINR(filteredCompanyTotal.achieved)}</span></div>
                <div className="flex justify-between"><span className="text-gray-700 font-semibold">Attainment</span>
                  <span className="font-bold" style={{ color: pctColorScoped(filteredCompanyTotal.attainment_pct, monthFilter) }}>
                    {filteredCompanyTotal.attainment_pct !== null ? `${filteredCompanyTotal.attainment_pct}%` : "—"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Sync history */}
          <div>
            <h2 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2"><History size={16} className="text-gray-400" /> Sync History</h2>
            {!historyLoaded ? (
              <div className="text-sm text-gray-400">Loading…</div>
            ) : history.length === 0 ? (
              <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-6 text-center">No syncs yet for this sheet. Click "Sync Now" above.</div>
            ) : (
              <div className="bg-white border border-orange-100 rounded-2xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-orange-50 bg-orange-50/40">
                      <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Inserted</th>
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
