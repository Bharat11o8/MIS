import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IndianRupee, TrendingUp, MapPin, Boxes, RefreshCw, SlidersHorizontal, X,
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, History, Plus, Trash2,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend, LabelList,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import MultiSelect from "@/components/ui/MultiSelect";
import DepotToDistributorTab from "@/pages/DepotToDistributorTab";

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
type TrendView = "monthly" | "quarterly" | "yearly";
interface ActiveFilters {
  // monthly view
  selectedMonths: string[];   // "YYYY-M" keys matching filterOptions.months
  // quarterly view
  fyStart: number | null;
  quarter: number | null;
  // yearly view
  selectedFYs: number[];      // FY start years
  // always-on
  depot: string; brand: string; category: string;
}
const EMPTY_FILTERS: ActiveFilters = {
  selectedMonths: [], fyStart: null, quarter: null, selectedFYs: [],
  depot: "", brand: "", category: "",
};

interface PtdSheetSource {
  id: string; sheet_id: string; label: string;
  created_at: string | null; last_synced_at: string | null; last_sync_status: string | null;
}
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

  const [activeTab, setActiveTab] = useState<"plant_to_depot" | "depot_to_distributor">("plant_to_depot");

  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [filters, setFilters] = useState<ActiveFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [trendView, setTrendView] = useState<TrendView>("quarterly");
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [loading, setLoading] = useState(true);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [showSyncErrors, setShowSyncErrors] = useState(false);
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  // Sheet registry for Plant-to-Depot (multi-sheet, one per FY)
  const [ptdSources, setPtdSources] = useState<PtdSheetSource[]>([]);
  const [ptdSelectedId, setPtdSelectedId] = useState<string>("");
  const [ptdShowAdd, setPtdShowAdd] = useState(false);
  const [ptdNewLink, setPtdNewLink] = useState("");
  const [ptdNewLabel, setPtdNewLabel] = useState("");
  const [ptdAdding, setPtdAdding] = useState(false);
  const [ptdAddError, setPtdAddError] = useState<string | null>(null);
  const [ptdDeleting, setPtdDeleting] = useState(false);

  const loadPtdSources = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/sales/sheet-sources`, { headers });
      if (!res.ok) return;
      const data: PtdSheetSource[] = await res.json();
      setPtdSources(data);
      if (data.length && !ptdSelectedId) setPtdSelectedId(data[0].id);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handlePtdAddSheet = async () => {
    if (!ptdNewLink.trim() || !ptdNewLabel.trim()) return;
    setPtdAdding(true);
    setPtdAddError(null);
    try {
      const res = await fetch(`${API_URL}/sales/sheet-sources`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: ptdNewLink.trim(), label: ptdNewLabel.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not add sheet");
      setPtdNewLink(""); setPtdNewLabel(""); setPtdShowAdd(false);
      await loadPtdSources();
      setPtdSelectedId(data.id);
      // Auto-sync on first add — use data.id directly since state hasn't flushed yet
      setSyncing(true);
      setSyncResult(null);
      try {
        const syncRes = await fetch(`${API_URL}/sales/sheet-sources/${data.id}/sync`, { method: "POST", headers });
        const syncData = await syncRes.json();
        if (!syncRes.ok) throw new Error(syncData.detail || "Sync failed");
        setSyncResult(syncData);
        loadHistory(data.id);
        loadPtdSources();
        fetchData(filters);
      } catch (syncErr: any) {
        setSyncResult({
          sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0,
          skipped_tabs: [], errors: [syncErr.message], status: "Error",
        });
      } finally {
        setSyncing(false);
      }
    } catch (e: any) {
      setPtdAddError(e.message);
    } finally {
      setPtdAdding(false);
    }
  };

  const handlePtdDelete = async () => {
    if (!ptdSelectedId) return;
    const source = ptdSources.find((s) => s.id === ptdSelectedId);
    if (!source) return;
    const ok = window.confirm(
      `Delete "${source.label}"?\n\nThis will permanently remove all Plant-to-Depot sales data synced from this sheet. This cannot be undone.`
    );
    if (!ok) return;
    setPtdDeleting(true);
    try {
      await fetch(`${API_URL}/sales/sheet-sources/${ptdSelectedId}`, { method: "DELETE", headers });
      setPtdSelectedId("");
      await loadPtdSources();
      fetchData(filters);
    } catch { /* ignore */ } finally {
      setPtdDeleting(false);
    }
  };

  // ── Load filter options + sync history once ────────────────────────────────
  useEffect(() => {
    fetch(`${API_URL}/sales/filter-options`, { headers })
      .then((r) => r.json()).then(setFilterOptions).catch(console.error);
    loadHistory();
    loadPtdSources();
  }, [token]);

  const loadHistory = useCallback(async (sheetSourceId?: string) => {
    try {
      const qs = sheetSourceId ? `?sheet_source_id=${sheetSourceId}` : "";
      const res = await fetch(`${API_URL}/sales/sync-history${qs}`, { headers });
      if (res.ok) { setHistory(await res.json()); setHistoryLoaded(true); }
    } catch { /* ignore */ }
  }, [token]);

  // ── Build query params ──────────────────────────────────────────────────────
  const buildParams = useCallback((f: ActiveFilters) => {
    const p = new URLSearchParams();
    const avail = new Set((filterOptions?.months ?? []).map(m => `${m.year}-${m.month}`));
    const pad = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

    if (trendView === "monthly" && f.selectedMonths.length > 0) {
      p.set("months", f.selectedMonths.map(s => { const [y, m] = s.split("-"); return pad(Number(y), Number(m)); }).join(","));
    } else if (trendView === "quarterly" && f.fyStart !== null) {
      const qMap: Record<number, [number, number][]> = {
        1: [[f.fyStart, 4], [f.fyStart, 5], [f.fyStart, 6]],
        2: [[f.fyStart, 7], [f.fyStart, 8], [f.fyStart, 9]],
        3: [[f.fyStart, 10], [f.fyStart, 11], [f.fyStart, 12]],
        4: [[f.fyStart + 1, 1], [f.fyStart + 1, 2], [f.fyStart + 1, 3]],
      };
      const fyAll: [number, number][] = [];
      for (let m = 4; m <= 12; m++) fyAll.push([f.fyStart, m]);
      for (let m = 1; m <= 3; m++) fyAll.push([f.fyStart + 1, m]);
      const target = f.quarter !== null ? qMap[f.quarter] : fyAll;
      const relevant = target.filter(([y, m]) => avail.has(`${y}-${m}`));
      if (relevant.length) p.set("months", relevant.map(([y, m]) => pad(y, m)).join(","));
    } else if (trendView === "yearly" && f.selectedFYs.length > 0) {
      const strs: string[] = [];
      for (const fy of f.selectedFYs) {
        for (let m = 4; m <= 12; m++) if (avail.has(`${fy}-${m}`)) strs.push(pad(fy, m));
        for (let m = 1; m <= 3; m++) if (avail.has(`${fy + 1}-${m}`)) strs.push(pad(fy + 1, m));
      }
      if (strs.length) p.set("months", strs.join(","));
    }

    if (f.depot) p.set("depot", f.depot);
    if (f.brand) p.set("brand", f.brand);
    if (f.category) p.set("category", f.category);
    return p.toString();
  }, [filterOptions, trendView]);

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

  const timeActive = trendView === "monthly" ? filters.selectedMonths.length > 0
    : trendView === "quarterly" ? (filters.fyStart !== null)
    : filters.selectedFYs.length > 0;
  const activeCount = [timeActive, filters.depot, filters.brand, filters.category].filter(Boolean).length;

  const availableFYs = useMemo(() => {
    const fyStarts = new Set((filterOptions?.months ?? []).map(m => m.month >= 4 ? m.year : m.year - 1));
    return Array.from(fyStarts).sort((a, b) => b - a);
  }, [filterOptions]);

  const trendData = useMemo(() => {
    if (!analytics?.trends) return [];
    if (trendView === "monthly") return analytics.trends;
    if (trendView === "quarterly") {
      const quarters: Record<string, { amount: number; fyStart: number; q: number }> = {};
      for (const t of analytics.trends) {
        const fyStart = t.month >= 4 ? t.year : t.year - 1;
        const q = t.month >= 4 ? Math.floor((t.month - 4) / 3) + 1 : 4;
        const key = `${fyStart}-${q}`;
        if (!quarters[key]) quarters[key] = { amount: 0, fyStart, q };
        quarters[key].amount += t.amount;
      }
      return Object.entries(quarters)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => ({ period: `Q${v.q} FY${String(v.fyStart + 1).slice(2)}`, amount: v.amount, year: v.fyStart, month: 0 }));
    }
    // yearly
    const fys: Record<string, { amount: number; fyStart: number }> = {};
    for (const t of analytics.trends) {
      const fyStart = t.month >= 4 ? t.year : t.year - 1;
      const key = `${fyStart}`;
      if (!fys[key]) fys[key] = { amount: 0, fyStart };
      fys[key].amount += t.amount;
    }
    return Object.entries(fys)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => ({ period: `FY ${v.fyStart}-${String(v.fyStart + 1).slice(2)}`, amount: v.amount, year: v.fyStart, month: 0 }));
  }, [analytics?.trends, trendView]);

  const handleTrendViewChange = (view: TrendView) => {
    setTrendView(view);
    setFilters(prev => ({ ...prev, selectedMonths: [], fyStart: null, quarter: null, selectedFYs: [] }));
  };
  const handleFYChange = (fyStr: string) => setFilters(prev => ({ ...prev, fyStart: fyStr === "" ? null : Number(fyStr), quarter: null }));
  const handleQuarterChange = (qStr: string) => setFilters(prev => ({ ...prev, quarter: qStr === "" ? null : Number(qStr) }));

  // ── Sync Now ─────────────────────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const url = ptdSelectedId
        ? `${API_URL}/sales/sheet-sources/${ptdSelectedId}/sync`
        : `${API_URL}/sales/sync`;
      const res = await fetch(url, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      loadHistory(ptdSelectedId || undefined);
      loadPtdSources();
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
  const timeLabelSub = (() => {
    if (trendView === "monthly" && filters.selectedMonths.length > 0) {
      if (filters.selectedMonths.length === 1) {
        const [y, m] = filters.selectedMonths[0].split("-");
        return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
      }
      return `${filters.selectedMonths.length} months`;
    }
    if (trendView === "quarterly" && filters.fyStart !== null) {
      return filters.quarter !== null
        ? `Q${filters.quarter} FY${filters.fyStart}-${String(filters.fyStart + 1).slice(2)}`
        : `FY ${filters.fyStart}-${String(filters.fyStart + 1).slice(2)}`;
    }
    if (trendView === "yearly" && filters.selectedFYs.length > 0) {
      if (filters.selectedFYs.length === 1)
        return `FY ${filters.selectedFYs[0]}-${String(filters.selectedFYs[0] + 1).slice(2)}`;
      return `${filters.selectedFYs.length} FYs`;
    }
    return "All time";
  })();

  const fmtGrowth = (g: number | null) => g !== null ? `${g > 0 ? "+" : ""}${g}%` : "—";
  const depotMap = Object.fromEntries((analytics?.depots ?? []).map((d: any) => [d.depot as string, d.amount as number]));

  const growthG = analytics ? (
    trendView === "monthly" ? analytics.kpis.mom_growth
    : trendView === "quarterly" ? analytics.kpis.qoq_growth
    : analytics.kpis.yoy_fy_growth
  ) : null;
  const growthPeriod = analytics ? (
    trendView === "monthly" ? analytics.kpis.mom_period
    : trendView === "quarterly" ? analytics.kpis.qoq_period
    : analytics.kpis.yoy_fy_period
  ) : null;
  const growthLabel = trendView === "monthly" ? "MoM Growth" : trendView === "quarterly" ? "QoQ Growth" : "YoY Growth";

  const kpiCards = analytics ? (() => {
    const total = analytics.kpis.total_amount;
    const janak = depotMap["Janak Motors"] ?? 0;
    const united = depotMap["United Auto"] ?? 0;
    const pct = (v: number) => total > 0 ? `${((v / total) * 100).toFixed(1)}% of total` : "—";
    return [
      {
        id: "sales-total", label: "Total Sales", value: formatINR(total),
        icon: <IndianRupee size={18} />, color: "#3b82f6", bg: "#eff6ff",
        sub: timeLabelSub, valueColor: "#111827",
      },
      {
        id: "sales-growth", label: growthLabel, value: fmtGrowth(growthG),
        icon: <TrendingUp size={18} />,
        color: growthG == null ? "#94a3b8" : growthG >= 0 ? "#22c55e" : "#ef4444",
        bg: growthG == null ? "#f8fafc" : growthG >= 0 ? "#f0fdf4" : "#fef2f2",
        sub: growthPeriod ?? "—",
        valueColor: growthG == null ? "#94a3b8" : growthG >= 0 ? "#22c55e" : "#ef4444",
      },
      {
        id: "depot-janak", label: "Janak Motors", value: formatINR(janak),
        icon: <MapPin size={18} />, color: DEPOT_COLORS["Janak Motors"], bg: "#eff6ff",
        sub: pct(janak), valueColor: "#111827",
      },
      {
        id: "depot-united", label: "United Auto", value: formatINR(united),
        icon: <MapPin size={18} />, color: DEPOT_COLORS["United Auto"], bg: "#fff7ed",
        sub: pct(united), valueColor: "#111827",
      },
    ];
  })() : [];

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-3">
            <span className="page-title-dark">SALES</span>
            <span className="page-title-orange">{activeTab === "plant_to_depot" ? "PLANT TO DEPOT" : "DEPOT TO DISTRIBUTOR"}</span>
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-8 h-0.5 bg-gray-800 rounded" />
            <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
              {activeTab === "plant_to_depot" ? (
                <>
                  {analytics ? `${formatINR(analytics.kpis.total_amount)} total` : "Loading…"}
                  {activeCount > 0 && <span className="text-orange-500"> · {activeCount} filter{activeCount > 1 ? "s" : ""} active</span>}
                </>
              ) : "ASM / Distributor targets and attainment"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
          <button onClick={() => setActiveTab("plant_to_depot")}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
              activeTab === "plant_to_depot" ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}>
            Plant to Depot
          </button>
          <button onClick={() => setActiveTab("depot_to_distributor")}
            className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
              activeTab === "depot_to_distributor" ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}>
            Depot to Distributor
          </button>
        </div>
      </motion.div>

      {/* Action row — same slot for both tabs, contents differ */}
      {activeTab === "plant_to_depot" && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Select
                value={ptdSelectedId}
                onChange={setPtdSelectedId}
                placeholder="Select a sheet…"
                options={ptdSources.map((s) => ({ value: s.id, label: s.label }))}
                className="min-w-[160px]"
              />
              <button onClick={() => setPtdShowAdd(!ptdShowAdd)}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
                <Plus size={13} /> Add Sheet
              </button>
              {ptdSelectedId && (
                <button onClick={handlePtdDelete} disabled={ptdDeleting}
                  className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-500 px-2 py-2 rounded-xl border border-gray-200 hover:border-red-200 transition-all disabled:opacity-50">
                  <Trash2 size={13} />
                </button>
              )}
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
          </div>

          {/* Add sheet form */}
          <AnimatePresence>
            {ptdShowAdd && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm flex flex-col gap-3">
                  <div className="flex flex-wrap gap-3 items-end">
                    <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Sheet link or ID</label>
                      <input value={ptdNewLink} onChange={(e) => setPtdNewLink(e.target.value)}
                        placeholder="https://docs.google.com/spreadsheets/d/…"
                        className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                    </div>
                    <div className="flex flex-col gap-1 min-w-[140px]">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Label</label>
                      <input value={ptdNewLabel} onChange={(e) => setPtdNewLabel(e.target.value)}
                        placeholder="e.g. FY26 Plant to Depot"
                        className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                    </div>
                    <button onClick={handlePtdAddSheet} disabled={ptdAdding}
                      className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
                      {ptdAdding ? "Adding…" : syncing ? "Syncing…" : "Add & Sync"}
                    </button>
                    <button onClick={() => setPtdShowAdd(false)} className="h-10 px-3 text-xs font-medium text-gray-400 hover:text-gray-600">Cancel</button>
                  </div>
                  {ptdAddError && <p className="text-xs text-red-600">{ptdAddError}</p>}
                  <p className="text-[11px] text-gray-400">
                    Share the sheet (Viewer) with the service account's email before syncing — Google Sheets access is per-document. Year is auto-detected from each month tab's title.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {activeTab === "depot_to_distributor" && <DepotToDistributorTab />}

      {activeTab === "plant_to_depot" && (
      <>
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
                {/* View toggle — always first */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">View</label>
                  <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5">
                    {(["monthly", "quarterly", "yearly"] as TrendView[]).map(v => (
                      <button key={v} onClick={() => handleTrendViewChange(v)}
                        className={`text-xs font-semibold px-2.5 py-1.5 rounded-md transition-all capitalize ${
                          trendView === v ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
                        }`}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Time filter — changes with view */}
                {trendView === "monthly" && (
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Month</label>
                    <MultiSelect
                      values={filters.selectedMonths}
                      onChange={(vals) => setFilter("selectedMonths", vals)}
                      options={(filterOptions?.months ?? []).map(m => ({ value: `${m.year}-${m.month}`, label: `${MONTH_NAMES[m.month - 1]} ${m.year}` }))}
                      placeholder="All months"
                      className="min-w-[160px]"
                    />
                  </div>
                )}
                {trendView === "quarterly" && (
                  <>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Financial Year</label>
                      <Select
                        value={filters.fyStart !== null ? String(filters.fyStart) : ""}
                        onChange={handleFYChange}
                        options={[{ value: "", label: "All FYs" }, ...availableFYs.map(fy => ({ value: String(fy), label: `FY ${fy}-${String(fy + 1).slice(2)}` }))]}
                        className="min-w-[130px]"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Quarter</label>
                      <Select
                        value={filters.quarter !== null ? String(filters.quarter) : ""}
                        onChange={handleQuarterChange}
                        disabled={filters.fyStart === null}
                        options={[
                          { value: "", label: "All Quarters" },
                          { value: "1", label: "Q1 · Apr–Jun" },
                          { value: "2", label: "Q2 · Jul–Sep" },
                          { value: "3", label: "Q3 · Oct–Dec" },
                          { value: "4", label: "Q4 · Jan–Mar" },
                        ]}
                        className="min-w-[130px]"
                      />
                    </div>
                  </>
                )}
                {trendView === "yearly" && (
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Financial Year</label>
                    <MultiSelect
                      values={filters.selectedFYs.map(String)}
                      onChange={(vals) => setFilter("selectedFYs", vals.map(Number))}
                      options={availableFYs.map(fy => ({ value: String(fy), label: `FY ${fy}-${String(fy + 1).slice(2)}` }))}
                      placeholder="All years"
                      className="min-w-[160px]"
                    />
                  </div>
                )}

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
            {kpiCards.map((kpi: any) => (
              <motion.div key={kpi.id} variants={item} id={kpi.id} className="kpi-card">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: kpi.bg, color: kpi.color }}>
                    {kpi.icon}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-600">{kpi.label}</p>
                    <p className="text-[11px] text-gray-400">{kpi.sub}</p>
                  </div>
                </div>
                <p className="text-2xl font-black mt-3" style={{ color: kpi.valueColor ?? "#111827" }}>{kpi.value}</p>
              </motion.div>
            ))}
          </motion.div>

          {/* Trend + Category split */}
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <motion.div variants={item} className="card-premium p-6 xl:col-span-2">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><TrendingUp size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">
                    {trendView === "monthly" ? "Monthly" : trendView === "quarterly" ? "Quarterly" : "Yearly"} Sales Trend
                  </h3>
                  <p className="text-[11px] text-gray-400">
                    {trendView === "monthly" ? "By month" : trendView === "quarterly" ? "By quarter (Indian FY)" : "By financial year"} — filtered result
                  </p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={trendData} margin={{ top: 36, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <Tooltip formatter={(v: number) => [formatINR(v), "Sales"]} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Line type="monotone" dataKey="amount" stroke="#f46617" strokeWidth={2.5} dot={{ fill: "#f46617", r: 4 }} activeDot={{ r: 6 }} name="Sales">
                    <LabelList dataKey="amount" position="top" offset={12} formatter={(v: number) => formatCr(v)} style={{ fontSize: 11, fill: "#64748b", fontWeight: 700 }} />
                  </Line>
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
                  <Legend iconType="circle" iconSize={8} formatter={(v, entry: any) => (
                    <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>
                      {v} · {formatCr(entry.payload?.amount ?? 0)}
                    </span>
                  )} />
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
                <BarChart data={analytics.depots} layout="vertical" barSize={28} margin={{ right: 64 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <YAxis dataKey="depot" type="category" tick={{ fontSize: 11, fill: "#64748b" }} width={100} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => [formatINR(v), "Sales"]} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="amount" radius={[0, 6, 6, 0]} name="Sales">
                    {analytics.depots.map((d: any) => <Cell key={d.depot} fill={DEPOT_COLORS[d.depot] ?? "#94a3b8"} />)}
                    <LabelList dataKey="amount" position="right" formatter={(v: number) => formatCr(v)} style={{ fontSize: 11, fill: "#64748b", fontWeight: 600 }} />
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
      </>
      )}
    </div>
  );
}
