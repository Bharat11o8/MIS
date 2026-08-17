import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IndianRupee, TrendingUp, MapPin, Boxes, RefreshCw, SlidersHorizontal, X,
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, History, Plus, Trash2, BarChart3,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend, LabelList,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import DepotToDistributorTab from "@/pages/DepotToDistributorTab";
import { formatINR, formatCr, formatDate } from "@/lib/format";

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
type PeriodMode = "monthly" | "quarterly" | "yearly";
interface PeriodRow { key: string; label: string; amount: number; }

interface PtdSheetSource {
  id: string; sheet_id: string; label: string; calendar_year: number | null;
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

// Indian FY: Apr–Mar. Same fyStart/quarter math used everywhere else on this
// page (trendData grouping, availableFYs, period-token defaults).
function currentFYStart(): number {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  return m >= 4 ? y : y - 1;
}
function currentFYQuarter(): number {
  const m = new Date().getMonth() + 1;
  return m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
}
function monthFyStart(year: number, month: number): number {
  return month >= 4 ? year : year - 1;
}

// The one canonical full-FY-range label — "FY26-27" — used everywhere a whole
// financial year is shown (dropdowns, KPI subtitles, chart axes). Quarter
// labels ("Q1 FY27") stay separate since a single-year suffix reads fine there.
function fyRangeLabel(fyStart: number): string {
  return `FY${String(fyStart).slice(2)}-${String(fyStart + 1).slice(2)}`;
}
// FY start-year options for the Plant-to-Depot sheet registration picker.
const PTD_YEAR_OPTIONS = Array.from({ length: 5 }, (_, i) => currentFYStart() - 2 + i)
  .map((y) => ({ value: String(y), label: fyRangeLabel(y) }));

function chipClass(active: boolean) {
  return `text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
    active ? "bg-orange-500 text-white border-orange-500" : "text-gray-600 border-gray-200 hover:border-orange-200"
  }`;
}

// Switching modes (or first load) should land on "today's" period for that
// mode — not an empty selection the user then has to fill in by hand. Yearly
// always means the current financial year, regardless of what data happens to
// be synced for it.
function defaultTokensFor(view: PeriodMode): { years: Set<number>; months: Set<string>; quarters: Set<string> } {
  const fy = currentFYStart();
  const today = new Date();
  const cy = today.getFullYear(), cm = today.getMonth() + 1;
  if (view === "monthly") {
    return { years: new Set(), months: new Set([`${cy}-${String(cm).padStart(2, "0")}`]), quarters: new Set() };
  }
  if (view === "quarterly") {
    return { years: new Set([fy]), months: new Set(), quarters: new Set([`${fy}-Q${currentFYQuarter()}`]) };
  }
  return { years: new Set([fy]), months: new Set(), quarters: new Set() };
}

// Client-side mirror of the backend's _quarter_months/_fy_months — expands a
// selected period token into raw (year, month) pairs so the detail table
// (/sales/list) can be filtered independently of the analytics endpoint.
function expandToken(mode: PeriodMode, token: string): [number, number][] {
  if (mode === "monthly") {
    const [y, m] = token.split("-");
    return [[Number(y), Number(m)]];
  }
  if (mode === "quarterly") {
    const [fyStr, qStr] = token.split("-Q");
    const fy = Number(fyStr);
    const qMap: Record<string, [number, number][]> = {
      "1": [[fy, 4], [fy, 5], [fy, 6]],
      "2": [[fy, 7], [fy, 8], [fy, 9]],
      "3": [[fy, 10], [fy, 11], [fy, 12]],
      "4": [[fy + 1, 1], [fy + 1, 2], [fy + 1, 3]],
    };
    return qMap[qStr] ?? [];
  }
  const fy = Number(token);
  const out: [number, number][] = [];
  for (let m = 4; m <= 12; m++) out.push([fy, m]);
  for (let m = 1; m <= 3; m++) out.push([fy + 1, m]);
  return out;
}

const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } };

function FilterSelect({
  label, value, onChange, options, allLabel = "All", labels,
}: { label: string; value: string; onChange: (v: string) => void; options: string[]; allLabel?: string; labels?: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-1 min-w-[140px]">
      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</label>
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
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [depotFilter, setDepotFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
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
  const [ptdNewYear, setPtdNewYear] = useState(String(currentFYStart()));
  const [ptdAdding, setPtdAdding] = useState(false);
  const [ptdAddError, setPtdAddError] = useState<string | null>(null);
  const [ptdDeleting, setPtdDeleting] = useState(false);

  // ── Period selector (Monthly / Quarterly / Yearly, multi-select chips) ──────
  const [mode, setMode] = useState<PeriodMode>("quarterly");
  const [selectedYears, setSelectedYears] = useState<Set<number>>(() => defaultTokensFor("quarterly").years);
  const [selectedMonthTokens, setSelectedMonthTokens] = useState<Set<string>>(() => defaultTokensFor("quarterly").months);
  const [selectedQuarterTokens, setSelectedQuarterTokens] = useState<Set<string>>(() => defaultTokensFor("quarterly").quarters);

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

  const switchMode = (m: PeriodMode) => {
    setMode(m);
    const d = defaultTokensFor(m);
    setSelectedYears(d.years);
    setSelectedMonthTokens(d.months);
    setSelectedQuarterTokens(d.quarters);
  };
  const toggleYear = (y: number) => setSelectedYears((prev) => {
    const next = new Set(prev); next.has(y) ? next.delete(y) : next.add(y); return next;
  });
  const toggleMonthToken = (t: string) => setSelectedMonthTokens((prev) => {
    const next = new Set(prev); next.has(t) ? next.delete(t) : next.add(t); return next;
  });
  const toggleQuarterToken = (t: string) => setSelectedQuarterTokens((prev) => {
    const next = new Set(prev); next.has(t) ? next.delete(t) : next.add(t); return next;
  });

  const periodTokens = useMemo(() => {
    if (mode === "monthly") return Array.from(selectedMonthTokens);
    if (mode === "quarterly") return Array.from(selectedQuarterTokens);
    return Array.from(selectedYears).map(String);
  }, [mode, selectedMonthTokens, selectedQuarterTokens, selectedYears]);
  const periodTokensKey = periodTokens.join(",");

  const availableFYs = useMemo(() => {
    const fyStarts = new Set((filterOptions?.months ?? []).map((m) => monthFyStart(m.year, m.month)));
    fyStarts.add(currentFYStart());
    return Array.from(fyStarts).sort((a, b) => b - a);
  }, [filterOptions]);

  const monthChipOptions = useMemo(() => {
    const map = new Map<string, { year: number; month: number }>();
    for (const m of filterOptions?.months ?? []) map.set(`${m.year}-${m.month}`, { year: m.year, month: m.month });
    const today = new Date();
    map.set(`${today.getFullYear()}-${today.getMonth() + 1}`, { year: today.getFullYear(), month: today.getMonth() + 1 });
    const all = Array.from(map.values());
    const filtered = selectedYears.size === 0 ? all : all.filter((m) => selectedYears.has(monthFyStart(m.year, m.month)));
    return filtered.sort((a, b) => a.year - b.year || a.month - b.month);
  }, [filterOptions, selectedYears]);

  // Quarters have no per-quarter sheet identity in Plant-to-Depot (one sheet
  // is a whole FY) — so chips are synthesized (all 4 per selected year), not
  // gated by data availability the way months/years are.
  const quarterChipOptions = useMemo(() => {
    const fys = selectedYears.size > 0 ? Array.from(selectedYears) : availableFYs;
    const out: { token: string; label: string }[] = [];
    for (const fy of [...fys].sort((a, b) => b - a)) {
      for (let q = 1; q <= 4; q++) out.push({ token: `${fy}-Q${q}`, label: `Q${q} FY${String(fy + 1).slice(2)}` });
    }
    return out;
  }, [selectedYears, availableFYs]);

  const handlePtdAddSheet = async () => {
    if (!ptdNewLink.trim() || !ptdNewYear.trim()) return;
    setPtdAdding(true);
    setPtdAddError(null);
    try {
      const res = await fetch(`${API_URL}/sales/sheet-sources`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: ptdNewLink.trim(), fy_start_year: Number(ptdNewYear) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not add sheet");
      setPtdNewLink(""); setPtdShowAdd(false);
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
        // Jump the dashboard to the newly added FY — same "show what you just
        // added" behavior Depot-to-Distributor's period selector uses.
        setMode("yearly");
        setSelectedYears(new Set([Number(ptdNewYear)]));
        setSelectedMonthTokens(new Set());
        setSelectedQuarterTokens(new Set());
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
      refreshDashboard();
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

  // ── Load analytics + detail list ─────────────────────────────────────────────
  const loadPeriodAnalytics = useCallback(async (m: PeriodMode, tokens: string[]) => {
    if (tokens.length === 0) { setAnalytics(null); setLoading(false); return; }
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set("mode", m);
      p.set("periods", tokens.join(","));
      if (depotFilter) p.set("depot", depotFilter);
      if (brandFilter) p.set("brand", brandFilter);
      if (categoryFilter) p.set("category", categoryFilter);
      const res = await fetch(`${API_URL}/sales/period-analytics?${p.toString()}`, { headers });
      if (res.ok) {
        const data = await res.json();
        data.trends = (data.trends ?? []).map((t: any) => ({ ...t, period: `${MONTH_NAMES[t.month - 1]} ${String(t.year).slice(2)}` }));
        setAnalytics(data);
      } else {
        setAnalytics(null);
      }
    } catch (e) { console.error(e); setAnalytics(null); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, depotFilter, brandFilter, categoryFilter]);

  // Flattens the selected period tokens into raw months client-side (mirroring
  // the backend's own token expansion) so the detail table can be filtered
  // independently of the analytics endpoint's own aggregation.
  const loadList = useCallback(async (m: PeriodMode, tokens: string[]) => {
    if (tokens.length === 0) { setRows([]); setTotalRows(0); return; }
    const monthsSet = new Set<string>();
    for (const t of tokens) for (const [y, mo] of expandToken(m, t)) monthsSet.add(`${y}-${String(mo).padStart(2, "0")}`);
    const p = new URLSearchParams();
    p.set("months", Array.from(monthsSet).join(","));
    p.set("per_page", "20");
    if (depotFilter) p.set("depot", depotFilter);
    if (brandFilter) p.set("brand", brandFilter);
    if (categoryFilter) p.set("category", categoryFilter);
    try {
      const res = await fetch(`${API_URL}/sales/list?${p.toString()}`, { headers });
      const data = await res.json();
      setRows(data.data || []);
      setTotalRows(data.total || 0);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, depotFilter, brandFilter, categoryFilter]);

  useEffect(() => {
    loadPeriodAnalytics(mode, periodTokens);
    loadList(mode, periodTokens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, periodTokensKey, loadPeriodAnalytics, loadList]);

  const refreshDashboard = useCallback(() => {
    loadPeriodAnalytics(mode, periodTokens);
    loadList(mode, periodTokens);
  }, [loadPeriodAnalytics, loadList, mode, periodTokens]);

  const clearAll = () => { setDepotFilter(""); setBrandFilter(""); setCategoryFilter(""); };
  const activeCount = [depotFilter, brandFilter, categoryFilter].filter(Boolean).length;

  const trendData = useMemo(() => {
    if (!analytics?.trends) return [];
    if (mode === "monthly") return analytics.trends;
    if (mode === "quarterly") {
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
      .map(([, v]) => ({ period: fyRangeLabel(v.fyStart), amount: v.amount, year: v.fyStart, month: 0 }));
  }, [analytics?.trends, mode]);

  // ── Sync Now ─────────────────────────────────────────────────────────────────
  const handleSync = async () => {
    if (!ptdSelectedId) {
      setSyncResult({
        sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 0, rows_deleted: 0,
        skipped_tabs: [], errors: ['Select a sheet to sync, or register one with "Add Sheet" first.'], status: "Error",
      });
      return;
    }
    setSyncing(true);
    setSyncResult(null);
    try {
      const url = `${API_URL}/sales/sheet-sources/${ptdSelectedId}/sync`;
      const res = await fetch(url, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      loadHistory(ptdSelectedId || undefined);
      loadPtdSources();
      refreshDashboard();
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
  const periodsLabel = analytics?.periods?.length
    ? (analytics.periods.length === 1 ? analytics.periods[0].label : `${analytics.periods.length} periods`)
    : "Select a period";

  const depotMap = Object.fromEntries((analytics?.depots ?? []).map((d: any) => [d.depot as string, d.amount as number]));

  // One row per depot, one key per category — feeds the stacked "what did each
  // depot buy" bar chart below (composition, not just the total each already
  // shown in Depot Comparison).
  const depotCategoryData = useMemo(() => {
    if (!analytics?.depot_category) return [];
    const byDepot = new Map<string, Record<string, any>>();
    for (const r of analytics.depot_category as { depot: string; category: string; amount: number }[]) {
      if (!byDepot.has(r.depot)) byDepot.set(r.depot, { depot: r.depot });
      byDepot.get(r.depot)![r.category] = r.amount;
    }
    return Array.from(byDepot.values());
  }, [analytics]);
  const depotCategoryKeys = useMemo(() => {
    if (!analytics?.depot_category) return [];
    return Array.from(new Set((analytics.depot_category as { category: string }[]).map((r) => r.category)));
  }, [analytics]);
  const categoryTotalMap: Record<string, number> = Object.fromEntries(
    (analytics?.categories ?? []).map((c: any) => [c.category as string, c.amount as number])
  );

  const kpiCards = analytics ? (() => {
    const total = analytics.kpis.total_amount;
    const janak = depotMap["Janak Motors"] ?? 0;
    const united = depotMap["United Auto"] ?? 0;
    const pct = (v: number) => total > 0 ? `${((v / total) * 100).toFixed(1)}% of total` : "—";
    return [
      {
        id: "sales-total", label: "Total Sales", value: formatCr(total),
        icon: <IndianRupee size={18} />, color: "#3b82f6", bg: "#eff6ff",
        sub: periodsLabel, valueColor: "#111827",
      },
      {
        id: "depot-janak", label: "Janak Motors", value: formatCr(janak),
        icon: <MapPin size={18} />, color: DEPOT_COLORS["Janak Motors"], bg: "#eff6ff",
        sub: pct(janak), valueColor: "#111827",
      },
      {
        id: "depot-united", label: "United Auto", value: formatCr(united),
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
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">
              {activeTab === "plant_to_depot" ? (
                <>
                  {analytics ? `${formatCr(analytics.kpis.total_amount)} total` : "Loading…"}
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
                  className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-red-500 px-2 py-2 rounded-xl border border-gray-200 hover:border-red-200 transition-all disabled:opacity-50">
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={refreshDashboard}
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
                disabled={syncing || !ptdSelectedId}
                title={!ptdSelectedId ? "Select a sheet to sync" : undefined}
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
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Sheet link or ID</label>
                      <input value={ptdNewLink} onChange={(e) => setPtdNewLink(e.target.value)}
                        placeholder="https://docs.google.com/spreadsheets/d/…"
                        className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                    </div>
                    <div className="flex flex-col gap-1 min-w-[130px]">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Fiscal Year</label>
                      <Select
                        value={ptdNewYear}
                        onChange={setPtdNewYear}
                        placeholder="Select…"
                        options={PTD_YEAR_OPTIONS}
                      />
                    </div>
                    <button onClick={handlePtdAddSheet} disabled={ptdAdding}
                      className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
                      {ptdAdding ? "Adding…" : syncing ? "Syncing…" : "Add & Sync"}
                    </button>
                    <button onClick={() => setPtdShowAdd(false)} className="h-10 px-3 text-xs font-medium text-gray-500 hover:text-gray-600">Cancel</button>
                  </div>
                  {ptdAddError && <p className="text-xs text-red-600">{ptdAddError}</p>}
                  <p className="text-[11px] text-gray-500">
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

      {/* Period selector — the primary navigation: pick a mode, then any
          combination of periods (including across years) to view and compare. */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm flex flex-col gap-3">
        <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl w-fit">
          {(["monthly", "quarterly", "yearly"] as PeriodMode[]).map((m) => (
            <button key={m} onClick={() => switchMode(m)}
              className={`px-3 py-1.5 text-xs font-bold rounded-lg capitalize transition-all ${
                mode === m ? "bg-white text-orange-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {m}
            </button>
          ))}
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Year{mode === "yearly" ? " (this is your selection)" : ""}</p>
          <div className="flex flex-wrap gap-1.5">
            {availableFYs.map((fy) => (
              <button key={fy} onClick={() => toggleYear(fy)} className={chipClass(selectedYears.has(fy))}>{fyRangeLabel(fy)}</button>
            ))}
          </div>
        </div>

        {mode === "monthly" && (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Month{selectedMonthTokens.size !== 1 ? "s" : ""} (pick any, need not be consecutive)</p>
            <div className="flex flex-wrap gap-1.5">
              {monthChipOptions.map((m) => {
                const t = `${m.year}-${String(m.month).padStart(2, "0")}`;
                return (
                  <button key={t} onClick={() => toggleMonthToken(t)} className={chipClass(selectedMonthTokens.has(t))}>
                    {MONTH_NAMES[m.month - 1]} {m.year}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {mode === "quarterly" && (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Quarter{selectedQuarterTokens.size !== 1 ? "s" : ""}</p>
            <div className="flex flex-wrap gap-1.5">
              {quarterChipOptions.map((q) => (
                <button key={q.token} onClick={() => toggleQuarterToken(q.token)} className={chipClass(selectedQuarterTokens.has(q.token))}>
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Filter panel — Depot/Brand/Category, orthogonal to period selection */}
      <AnimatePresence>
        {filtersOpen && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <div className="flex flex-wrap gap-4 items-end">
                <FilterSelect label="Depot" value={depotFilter} onChange={setDepotFilter} options={filterOptions?.depots ?? []} />
                <FilterSelect label="Brand" value={brandFilter} onChange={setBrandFilter} options={filterOptions?.brands ?? []} labels={BRAND_FILTER_LABELS} />
                <FilterSelect label="Category" value={categoryFilter} onChange={setCategoryFilter} options={filterOptions?.categories ?? []} />
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

      {periodTokens.length === 0 && !loading && (
        <div className="text-sm text-gray-500 bg-gray-50 rounded-2xl p-8 text-center">
          Select at least one {mode === "monthly" ? "month" : mode === "quarterly" ? "quarter" : "year"} above to view analytics.
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-500">
          <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          Updating charts…
        </div>
      )}

      {analytics && !loading && (
        <>
          {/* Period comparison — the mechanism for cross-period comparison: one
              bar/card per selected period. Degrades gracefully to a single card
              when only one period is selected. */}
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="card-premium p-6">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500"><BarChart3 size={16} /></div>
              <div>
                <h3 className="text-sm font-bold text-gray-800">Period Comparison</h3>
                <p className="text-[11px] text-gray-500">Sales for every period selected above</p>
              </div>
            </div>
            {analytics.periods.length > 1 && (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={analytics.periods.map((p: PeriodRow) => ({ name: p.label, Sales: p.amount }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <Tooltip formatter={(v: number) => formatCr(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="Sales" fill="#f46617" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
            <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${analytics.periods.length > 1 ? "mt-4" : ""}`}>
              {analytics.periods.map((p: PeriodRow) => (
                <div key={p.key} className="rounded-xl border border-gray-100 p-3">
                  <p className="text-xs font-bold text-gray-700 truncate">{p.label}</p>
                  <p className="text-lg font-black mt-1 text-gray-900">{formatCr(p.amount)}</p>
                </div>
              ))}
            </div>
          </motion.div>

          {/* KPI Cards */}
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {kpiCards.map((kpi: any) => (
              <motion.div key={kpi.id} variants={item} id={kpi.id} className="kpi-card">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: kpi.bg, color: kpi.color }}>
                    {kpi.icon}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-600">{kpi.label}</p>
                    <p className="text-[11px] text-gray-500">{kpi.sub}</p>
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
                    {mode === "monthly" ? "Monthly" : mode === "quarterly" ? "Quarterly" : "Yearly"} Sales Trend
                  </h3>
                  <p className="text-[11px] text-gray-500">
                    {mode === "monthly" ? "By month" : mode === "quarterly" ? "By quarter (Indian FY)" : "By financial year"} — selected periods
                  </p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={trendData} margin={{ top: 36, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <Tooltip formatter={(v: number) => [formatCr(v), "Sales"]} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
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
                  <p className="text-[11px] text-gray-500">Sales by category</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={analytics.categories} cx="50%" cy="45%" innerRadius={50} outerRadius={75} paddingAngle={4} dataKey="amount" nameKey="category">
                    {analytics.categories.map((c: any) => <Cell key={c.category} fill={CATEGORY_COLORS[c.category] ?? "#94a3b8"} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatCr(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
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
                  <p className="text-[11px] text-gray-500">Total sales value per depot</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={analytics.depots} layout="vertical" barSize={28} margin={{ right: 64 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <YAxis dataKey="depot" type="category" tick={{ fontSize: 11, fill: "#64748b" }} width={100} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => [formatCr(v), "Sales"]} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
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
                  <p className="text-[11px] text-gray-500">By category coverage</p>
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
                        <span className="text-gray-500">{formatCr(b.amount)} · {pct}%</span>
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

          {/* What each depot bought — category composition per depot, not just totals */}
          {depotCategoryData.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-green-50 flex items-center justify-center text-green-600"><Boxes size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">What Each Depot Bought</h3>
                  <p className="text-[11px] text-gray-500">Category composition per depot</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={Math.max(160, depotCategoryData.length * 90)}>
                <BarChart data={depotCategoryData} layout="vertical" barSize={28} margin={{ right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <YAxis dataKey="depot" type="category" tick={{ fontSize: 11, fill: "#64748b" }} width={100} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number, name: string) => [formatCr(v), name]} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Legend iconType="circle" iconSize={8} formatter={(v) => (
                    <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>
                      {v} · {formatCr(categoryTotalMap[v] ?? 0)}
                    </span>
                  )} />
                  {depotCategoryKeys.map((cat, i) => (
                    <Bar key={cat} dataKey={cat} stackId="a" fill={CATEGORY_COLORS[cat] ?? "#94a3b8"} name={cat}
                      radius={i === depotCategoryKeys.length - 1 ? [0, 6, 6, 0] : undefined} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
          )}

          {/* Detail table */}
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="card-premium overflow-hidden">
            <div className="flex items-center justify-between p-6 pb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><Boxes size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Sales Records</h3>
                  <p className="text-[11px] text-gray-500">Showing {rows.length} of {totalRows.toLocaleString()} rows{activeCount > 0 && " (filtered)"}</p>
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
                      <th key={h} className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-500 px-4 py-3 first:pl-6 last:pr-6">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-8 text-sm text-gray-500">No sales records match the selected filters.</td></tr>
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
            <h2 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2"><History size={16} className="text-gray-500" /> Sync History</h2>
            {!historyLoaded ? (
              <div className="text-sm text-gray-500">Loading…</div>
            ) : history.length === 0 ? (
              <div className="text-sm text-gray-500 bg-gray-50 rounded-2xl p-6 text-center">No syncs yet. Click "Sync Now" above to pull data from the Google Sheet.</div>
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
