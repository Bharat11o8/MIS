import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  IndianRupee, Target, TrendingUp, Users, RefreshCw, Plus, ChevronDown, ChevronUp,
  CheckCircle2, XCircle, Clock, History, Trash2, Percent, Gauge, BarChart3,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, Legend,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import { formatINR, formatCr, formatCompact, formatDate } from "@/lib/format";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pctColor(pct: number | null) {
  if (pct === null) return "#94a3b8";
  if (pct >= 100) return "#22c55e";
  if (pct >= 70) return "#f59e0b";
  return "#ef4444";
}
// A partial period (a single selected month, or a quarter that isn't fully
// registered) can't be meaningfully judged against a full quarterly target —
// red/amber/green thresholds would misleadingly read low. Use the brand accent
// instead of grey so it still reads as "a real number" rather than disabled.
function pctColorScoped(pct: number | null, isPartial: boolean) {
  return isPartial ? "#f46617" : pctColor(pct);
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface SheetSourceItem {
  id: string; sheet_id: string; label: string; calendar_year: number; quarter: string | null;
  created_at: string; last_synced_at: string | null; last_sync_status: string | null;
}
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;

type PeriodMode = "monthly" | "quarterly" | "yearly";
type CategoryFilter = "ALL" | "SAM" | "EV";

interface MonthlyAmount { year: number; month: number; sam: number; ev: number; }
interface YearMonth { year: number; month: number; }
interface DistributorRow {
  distributor: string; area_head: string | null; target: number | null;
  monthly: MonthlyAmount[]; achieved: number; attainment_pct: number | null;
}
interface AreaHeadGroup {
  area_head: string; target: number | null; achieved: number; attainment_pct: number | null;
  monthly: MonthlyAmount[];
  distributors: DistributorRow[];
}
interface PeriodRow {
  key: string; label: string; is_partial: boolean;
  target: number; achieved: number; attainment_pct: number | null;
}
interface PeriodAnalytics {
  mode: PeriodMode;
  is_partial: boolean;
  periods: PeriodRow[];
  kpis: { total_target: number; total_achieved: number; attainment_pct: number | null; top_area_head: string | null };
  area_heads: AreaHeadGroup[];
  depot_direct: DistributorRow[];
  company_total: {
    target: number; achieved_distributors: number; achieved_depot_direct: number;
    achieved_total: number; attainment_pct: number | null; monthly: MonthlyAmount[];
  };
}
interface AvailablePeriods {
  months: YearMonth[];
  quarters: { year: number; quarter: string; label: string; sheet_source_id: string }[];
  years: number[];
}
interface SyncResult {
  sync_id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; errors: string[]; status: string;
}
interface SyncHistoryItem {
  id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; status: string; synced_at: string;
}

function allMonths(analytics: PeriodAnalytics): YearMonth[] {
  const map = new Map<string, YearMonth>();
  for (const g of analytics.area_heads) for (const d of g.distributors) for (const m of d.monthly) map.set(`${m.year}-${m.month}`, { year: m.year, month: m.month });
  for (const d of analytics.depot_direct) for (const m of d.monthly) map.set(`${m.year}-${m.month}`, { year: m.year, month: m.month });
  return Array.from(map.values()).sort((a, b) => a.year - b.year || a.month - b.month);
}
function monthValue(d: DistributorRow, ym: YearMonth, category: "sam" | "ev"): number {
  return d.monthly.find((m) => m.year === ym.year && m.month === ym.month)?.[category] ?? 0;
}
function sumByCategory(monthly: MonthlyAmount[], categoryFilter: CategoryFilter): number {
  let total = 0;
  for (const m of monthly) {
    if (categoryFilter === "ALL") total += m.sam + m.ev;
    else if (categoryFilter === "SAM") total += m.sam;
    else total += m.ev;
  }
  return Math.round(total * 100) / 100;
}
function pctOf(achieved: number, target: number | null): number | null {
  return target ? Math.round((achieved / target) * 100 * 100) / 100 : null;
}
function extremeBy<T>(items: T[], selector: (item: T) => number | null, mode: "max" | "min"): T | null {
  let best: T | null = null;
  let bestVal: number | null = null;
  for (const item of items) {
    const v = selector(item);
    if (v === null) continue;
    if (bestVal === null || (mode === "max" ? v > bestVal : v < bestVal)) { best = item; bestVal = v; }
  }
  return best;
}
function chipClass(active: boolean) {
  return `text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
    active ? "bg-orange-500 text-white border-orange-500" : "text-gray-600 border-gray-200 hover:border-orange-200"
  }`;
}

interface KpiCardDef {
  id: string; label: string; value: string; sub?: string; exact?: string;
  icon: JSX.Element; color: string; bg: string; valueColor?: string;
}
function AttainmentLegend({ isPartial }: { isPartial: boolean }) {
  const items: { color: string; label: string }[] = [
    { color: "#22c55e", label: "≥100% target met" },
    { color: "#f59e0b", label: "70–99% near target" },
    { color: "#ef4444", label: "<70% off track" },
    { color: "#94a3b8", label: "no target set" },
  ];
  if (isPartial) items.push({ color: "#f46617", label: "partial period vs. full target — not graded" });
  return (
    <div className="flex items-center gap-4 flex-wrap px-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Attainment</span>
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: it.color }} />
          <span className="text-[11px] text-gray-500">{it.label}</span>
        </div>
      ))}
    </div>
  );
}
function KpiCard({ kpi }: { kpi: KpiCardDef }) {
  return (
    <div className="kpi-card">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: kpi.bg, color: kpi.color }}>
          {kpi.icon}
        </div>
        <p className="text-xs font-bold text-gray-600 truncate">{kpi.label}</p>
      </div>
      <p className="text-2xl font-black mt-3 truncate" style={{ color: kpi.valueColor ?? "#111827" }} title={kpi.exact ?? kpi.value}>{kpi.value}</p>
      {kpi.sub && <p className="text-xs font-semibold text-gray-500 mt-0.5 truncate" title={kpi.sub}>{kpi.sub}</p>}
    </div>
  );
}

export default function DepotToDistributorTab() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [sheetSources, setSheetSources] = useState<SheetSourceItem[]>([]);
  const [selectedManageSheetId, setSelectedManageSheetId] = useState<string>("");
  const [analytics, setAnalytics] = useState<PeriodAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedHeads, setExpandedHeads] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("ALL");
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 1 + i).map((y) => ({ value: String(y), label: String(y) }));

  // ── Period selector ────────────────────────────────────────────────────────
  const [mode, setMode] = useState<PeriodMode>("quarterly");
  const [availablePeriods, setAvailablePeriods] = useState<AvailablePeriods>({ months: [], quarters: [], years: [] });
  const [selectedYears, setSelectedYears] = useState<Set<number>>(new Set());
  const [selectedMonthTokens, setSelectedMonthTokens] = useState<Set<string>>(new Set());
  const [selectedQuarterTokens, setSelectedQuarterTokens] = useState<Set<string>>(new Set());

  const [showAddForm, setShowAddForm] = useState(false);
  const [newLink, setNewLink] = useState("");
  const [newQuarter, setNewQuarter] = useState("");
  const [newYear, setNewYear] = useState(String(new Date().getFullYear()));
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);
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
      if (data.length && !selectedManageSheetId) setSelectedManageSheetId(data[0].id);
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

  useEffect(() => {
    if (selectedManageSheetId) loadHistory(selectedManageSheetId);
  }, [selectedManageSheetId, loadHistory]);

  const loadAvailablePeriods = useCallback(async (): Promise<AvailablePeriods | null> => {
    try {
      const res = await fetch(`${API_URL}/distributor-sales/periods`, { headers });
      if (res.ok) {
        const data: AvailablePeriods = await res.json();
        setAvailablePeriods(data);
        return data;
      }
    } catch { /* ignore */ }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadPeriodAnalytics = useCallback(async (m: PeriodMode, tokens: string[]) => {
    if (tokens.length === 0) { setAnalytics(null); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/distributor-sales/period-analytics?mode=${m}&periods=${tokens.join(",")}`, { headers });
      if (res.ok) setAnalytics(await res.json());
      else setAnalytics(null);
    } catch { setAnalytics(null); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Default to the most recently registered quarter — same "opens on the
  // latest data" behavior as before the period selector existed.
  useEffect(() => {
    loadAvailablePeriods().then((data) => {
      if (data && data.quarters.length > 0) {
        const latest = data.quarters[data.quarters.length - 1];
        setSelectedQuarterTokens(new Set([`${latest.year}-${latest.quarter}`]));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const periodTokens = useMemo(() => {
    if (mode === "monthly") return Array.from(selectedMonthTokens);
    if (mode === "quarterly") return Array.from(selectedQuarterTokens);
    return Array.from(selectedYears).map(String);
  }, [mode, selectedMonthTokens, selectedQuarterTokens, selectedYears]);
  const periodTokensKey = periodTokens.join(",");

  useEffect(() => {
    loadPeriodAnalytics(mode, periodTokens);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, periodTokensKey, loadPeriodAnalytics]);

  const switchMode = (m: PeriodMode) => {
    setMode(m);
    setSelectedYears(new Set());
    setSelectedMonthTokens(new Set());
    setSelectedQuarterTokens(new Set());
  };
  const toggleYear = (y: number) => {
    setSelectedYears((prev) => {
      const next = new Set(prev);
      next.has(y) ? next.delete(y) : next.add(y);
      return next;
    });
  };
  const toggleMonthToken = (t: string) => {
    setSelectedMonthTokens((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };
  const toggleQuarterToken = (t: string) => {
    setSelectedQuarterTokens((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };

  const visibleMonthOptions = useMemo(
    () => availablePeriods.months.filter((m) => selectedYears.size === 0 || selectedYears.has(m.year)),
    [availablePeriods.months, selectedYears]
  );
  const visibleQuarterOptions = useMemo(
    () => availablePeriods.quarters.filter((q) => selectedYears.size === 0 || selectedYears.has(q.year)),
    [availablePeriods.quarters, selectedYears]
  );

  // ── Delete sheet source ───────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!selectedManageSheetId) return;
    const source = sheetSources.find((s) => s.id === selectedManageSheetId);
    if (!source) return;
    const ok = window.confirm(
      `Delete "${source.label}"?\n\nThis will permanently remove all distributor sales data for this quarter. This cannot be undone.`
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await fetch(`${API_URL}/distributor-sales/sheet-sources/${selectedManageSheetId}`, { method: "DELETE", headers });
      setSelectedManageSheetId("");
      await loadSheetSources();
      await loadAvailablePeriods();
      loadPeriodAnalytics(mode, periodTokens);
    } catch { /* ignore */ } finally {
      setDeleting(false);
    }
  };

  // ── Add sheet ────────────────────────────────────────────────────────────────
  const handleAddSheet = async () => {
    if (!newLink.trim() || !newQuarter || !newYear.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`${API_URL}/distributor-sales/sheet-sources`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: newLink.trim(), quarter: newQuarter, calendar_year: Number(newYear) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not add sheet");
      const addedQuarter = newQuarter;
      const addedYear = newYear;
      setNewLink(""); setNewQuarter(""); setShowAddForm(false);
      await loadSheetSources();
      setSelectedManageSheetId(data.id);
      // Auto-sync on first add — use data.id directly since state hasn't flushed yet
      setSyncing(true);
      setSyncResult(null);
      try {
        const syncRes = await fetch(`${API_URL}/distributor-sales/sheet-sources/${data.id}/sync`, { method: "POST", headers });
        const syncData = await syncRes.json();
        if (!syncRes.ok) throw new Error(syncData.detail || "Sync failed");
        setSyncResult(syncData);
        loadHistory(data.id);
        loadSheetSources();
        await loadAvailablePeriods();
        // Jump the dashboard to the newly added quarter — same "show what you
        // just added" behavior as before the period selector existed.
        setMode("quarterly");
        setSelectedYears(new Set());
        setSelectedMonthTokens(new Set());
        setSelectedQuarterTokens(new Set([`${addedYear}-${addedQuarter}`]));
      } catch (syncErr: any) {
        setSyncResult({
          sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0,
          errors: [syncErr.message], status: "Error",
        });
      } finally {
        setSyncing(false);
      }
    } catch (e: any) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  };

  // ── Sync ─────────────────────────────────────────────────────────────────────
  const handleSync = async () => {
    if (!selectedManageSheetId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${API_URL}/distributor-sales/sheet-sources/${selectedManageSheetId}/sync`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      loadHistory(selectedManageSheetId);
      loadSheetSources();
      await loadAvailablePeriods();
      loadPeriodAnalytics(mode, periodTokens);
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
  const visibleCategories: ("sam" | "ev")[] = categoryFilter === "ALL" ? ["sam", "ev"] : [categoryFilter === "SAM" ? "sam" : "ev"];

  // Category is the only client-side filter left — period selection (which
  // months/quarters/years) is now resolved server-side. Re-derives achieved/
  // attainment_pct from the same monthly breakdown the backend already blended.
  const filteredAreaHeads = useMemo(() => {
    if (!analytics) return [];
    return analytics.area_heads.map((g) => {
      const achieved = sumByCategory(g.monthly, categoryFilter);
      const distributors = g.distributors.map((d) => {
        const dAchieved = sumByCategory(d.monthly, categoryFilter);
        return { ...d, achieved: dAchieved, attainment_pct: pctOf(dAchieved, d.target) };
      });
      return { ...g, achieved, attainment_pct: pctOf(achieved, g.target), distributors };
    });
  }, [analytics, categoryFilter]);

  const filteredCompanyTotal = useMemo(() => {
    if (!analytics) return null;
    const achieved = sumByCategory(analytics.company_total.monthly, categoryFilter);
    return { target: analytics.company_total.target, achieved, attainment_pct: pctOf(achieved, analytics.company_total.target) };
  }, [analytics, categoryFilter]);

  const topAreaHeadByPct = useMemo(() => extremeBy(filteredAreaHeads, (g) => g.attainment_pct, "max"), [filteredAreaHeads]);
  const topAreaHeadByValue = useMemo(() => extremeBy(filteredAreaHeads, (g) => g.achieved, "max"), [filteredAreaHeads]);
  const bottomAreaHeadByPct = useMemo(() => extremeBy(filteredAreaHeads, (g) => g.attainment_pct, "min"), [filteredAreaHeads]);
  const bottomAreaHeadByValue = useMemo(() => extremeBy(filteredAreaHeads, (g) => g.achieved, "min"), [filteredAreaHeads]);

  // Always reflects both categories regardless of the category filter — this is
  // the "how is SAM vs EV doing" at-a-glance split the filter itself can't show.
  const samEvSplit = useMemo(() => {
    if (!analytics) return { sam: 0, ev: 0 };
    return { sam: sumByCategory(analytics.company_total.monthly, "SAM"), ev: sumByCategory(analytics.company_total.monthly, "EV") };
  }, [analytics]);

  const chartData = useMemo(
    () => filteredAreaHeads.map((g) => ({ area_head: g.area_head, attainment_pct: g.attainment_pct ?? 0 })),
    [filteredAreaHeads]
  );

  const distributorChartData = useMemo(() => {
    return filteredAreaHeads
      .flatMap((g) => g.distributors)
      .sort((a, b) => (b.attainment_pct ?? -1) - (a.attainment_pct ?? -1));
  }, [filteredAreaHeads]);

  const topDistributorByPct = useMemo(() => extremeBy(distributorChartData, (d) => d.attainment_pct, "max"), [distributorChartData]);
  const topDistributorByValue = useMemo(() => extremeBy(distributorChartData, (d) => d.achieved, "max"), [distributorChartData]);
  const bottomDistributorByPct = useMemo(() => extremeBy(distributorChartData, (d) => d.attainment_pct, "min"), [distributorChartData]);
  const bottomDistributorByValue = useMemo(() => extremeBy(distributorChartData, (d) => d.achieved, "min"), [distributorChartData]);

  // Always uses all months, category filter not applied — the whole point is
  // to see SAM vs EV trajectory across the selection unobstructed.
  const trendData = useMemo(() => {
    if (!analytics) return [];
    return analytics.company_total.monthly.map((m) => ({
      name: `${MONTH_NAMES[m.month]} ${m.year}`,
      SAM: Math.round(m.sam),
      EV: Math.round(m.ev),
    }));
  }, [analytics]);

  const samEvByAreaHead = useMemo(() => {
    if (!analytics) return [];
    return analytics.area_heads
      .map((g) => ({ area_head: g.area_head, SAM: sumByCategory(g.monthly, "SAM"), EV: sumByCategory(g.monthly, "EV") }))
      .sort((a, b) => (b.SAM + b.EV) - (a.SAM + a.EV));
  }, [analytics]);

  const isPartial = analytics?.is_partial ?? false;

  // Gap uses the same "grey out for a partial period" rule as the table's Gap
  // column — a partial period's achieved can't be meaningfully compared to the
  // full quarterly target.
  const gapRaw = filteredCompanyTotal ? filteredCompanyTotal.target - filteredCompanyTotal.achieved : null;
  const gapColor = gapRaw === null || isPartial ? "#94a3b8" : gapRaw <= 0 ? "#22c55e" : "#ef4444";
  const gapBg = gapRaw === null || isPartial ? "#f8fafc" : gapRaw <= 0 ? "#f0fdf4" : "#fef2f2";
  const gapValueStr = gapRaw === null ? "—"
    : gapRaw <= 0 ? `+${formatCompact(filteredCompanyTotal!.achieved - filteredCompanyTotal!.target)}`
    : formatCompact(gapRaw);
  const gapExactStr = gapRaw === null ? undefined
    : gapRaw <= 0 ? `+${formatINR(filteredCompanyTotal!.achieved - filteredCompanyTotal!.target)}`
    : formatINR(gapRaw);

  // Every performance metric is colored off its own attainment_pct — not off
  // "is this the top or bottom card" — so a bottom-ranked ASM who still cleared
  // 100% of target still reads green, and a top-ranked one short of target reads
  // red/amber. pctColorScoped already grey/orange-outs the color for a partial
  // period, since that can't be judged against the full target.
  const statusColor = (pct: number | null | undefined) => pctColorScoped(pct ?? null, isPartial);
  const statusBg = (color: string) => `${color}20`;

  const attainmentColor = filteredCompanyTotal ? statusColor(filteredCompanyTotal.attainment_pct) : "#94a3b8";

  const kpiCards: KpiCardDef[] = analytics && filteredCompanyTotal ? [
    {
      id: "dd-target", label: "Total Target", value: formatCompact(filteredCompanyTotal.target), exact: formatINR(filteredCompanyTotal.target),
      icon: <Target size={18} />, color: "#3b82f6", bg: "#eff6ff",
    },
    {
      id: "dd-achieved", label: "Total Achieved", value: formatCompact(filteredCompanyTotal.achieved), exact: formatINR(filteredCompanyTotal.achieved),
      icon: <IndianRupee size={18} />, color: "#f46617", bg: "#fff7ed",
    },
    {
      id: "dd-attainment", label: "Attainment %",
      value: filteredCompanyTotal.attainment_pct !== null ? `${filteredCompanyTotal.attainment_pct}%` : "—",
      icon: <TrendingUp size={18} />, color: attainmentColor, bg: statusBg(attainmentColor), valueColor: attainmentColor,
    },
    { id: "dd-gap", label: "Gap to Target", value: gapValueStr, exact: gapExactStr, icon: <Gauge size={18} />, color: gapColor, bg: gapBg, valueColor: gapColor },
  ] : [];

  const asmKpiCards: KpiCardDef[] = analytics ? [
    {
      id: "dd-asm-top-pct", label: "Top ASM (% Wise)",
      value: topAreaHeadByPct?.attainment_pct != null ? `${topAreaHeadByPct.attainment_pct}%` : "—",
      sub: topAreaHeadByPct?.area_head,
      icon: <Percent size={18} />, color: statusColor(topAreaHeadByPct?.attainment_pct), bg: statusBg(statusColor(topAreaHeadByPct?.attainment_pct)),
      valueColor: statusColor(topAreaHeadByPct?.attainment_pct),
    },
    {
      id: "dd-asm-top-val", label: "Top ASM (Value Wise)",
      value: topAreaHeadByValue ? formatCompact(topAreaHeadByValue.achieved) : "—",
      exact: topAreaHeadByValue ? formatINR(topAreaHeadByValue.achieved) : undefined,
      sub: topAreaHeadByValue?.area_head,
      icon: <IndianRupee size={18} />, color: statusColor(topAreaHeadByValue?.attainment_pct), bg: statusBg(statusColor(topAreaHeadByValue?.attainment_pct)),
      valueColor: statusColor(topAreaHeadByValue?.attainment_pct),
    },
    {
      id: "dd-asm-bottom-pct", label: "Bottom ASM (% Wise)",
      value: bottomAreaHeadByPct?.attainment_pct != null ? `${bottomAreaHeadByPct.attainment_pct}%` : "—",
      sub: bottomAreaHeadByPct?.area_head,
      icon: <Percent size={18} />, color: statusColor(bottomAreaHeadByPct?.attainment_pct), bg: statusBg(statusColor(bottomAreaHeadByPct?.attainment_pct)),
      valueColor: statusColor(bottomAreaHeadByPct?.attainment_pct),
    },
    {
      id: "dd-asm-bottom-val", label: "Bottom ASM (Value Wise)",
      value: bottomAreaHeadByValue ? formatCompact(bottomAreaHeadByValue.achieved) : "—",
      exact: bottomAreaHeadByValue ? formatINR(bottomAreaHeadByValue.achieved) : undefined,
      sub: bottomAreaHeadByValue?.area_head,
      icon: <IndianRupee size={18} />, color: statusColor(bottomAreaHeadByValue?.attainment_pct), bg: statusBg(statusColor(bottomAreaHeadByValue?.attainment_pct)),
      valueColor: statusColor(bottomAreaHeadByValue?.attainment_pct),
    },
  ] : [];

  const distKpiCards: KpiCardDef[] = analytics ? [
    {
      id: "dd-dist-top-pct", label: "Top Dist (% Wise)",
      value: topDistributorByPct?.attainment_pct != null ? `${topDistributorByPct.attainment_pct}%` : "—",
      sub: topDistributorByPct?.distributor,
      icon: <Percent size={18} />, color: statusColor(topDistributorByPct?.attainment_pct), bg: statusBg(statusColor(topDistributorByPct?.attainment_pct)),
      valueColor: statusColor(topDistributorByPct?.attainment_pct),
    },
    {
      id: "dd-dist-top-val", label: "Top Dist (Value Wise)",
      value: topDistributorByValue ? formatCompact(topDistributorByValue.achieved) : "—",
      exact: topDistributorByValue ? formatINR(topDistributorByValue.achieved) : undefined,
      sub: topDistributorByValue?.distributor,
      icon: <IndianRupee size={18} />, color: statusColor(topDistributorByValue?.attainment_pct), bg: statusBg(statusColor(topDistributorByValue?.attainment_pct)),
      valueColor: statusColor(topDistributorByValue?.attainment_pct),
    },
    {
      id: "dd-dist-bottom-pct", label: "Bottom Dist (% Wise)",
      value: bottomDistributorByPct?.attainment_pct != null ? `${bottomDistributorByPct.attainment_pct}%` : "—",
      sub: bottomDistributorByPct?.distributor,
      icon: <Percent size={18} />, color: statusColor(bottomDistributorByPct?.attainment_pct), bg: statusBg(statusColor(bottomDistributorByPct?.attainment_pct)),
      valueColor: statusColor(bottomDistributorByPct?.attainment_pct),
    },
    {
      id: "dd-dist-bottom-val", label: "Bottom Dist (Value Wise)",
      value: bottomDistributorByValue ? formatCompact(bottomDistributorByValue.achieved) : "—",
      exact: bottomDistributorByValue ? formatINR(bottomDistributorByValue.achieved) : undefined,
      sub: bottomDistributorByValue?.distributor,
      icon: <IndianRupee size={18} />, color: statusColor(bottomDistributorByValue?.attainment_pct), bg: statusBg(statusColor(bottomDistributorByValue?.attainment_pct)),
      valueColor: statusColor(bottomDistributorByValue?.attainment_pct),
    },
  ] : [];

  return (
    <div className="flex flex-col gap-5">
      {/* Sheet management + actions */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Select
            value={selectedManageSheetId}
            onChange={setSelectedManageSheetId}
            placeholder="Manage a quarter…"
            options={sheetSources.map((s) => ({ value: s.id, label: s.label }))}
            className="min-w-[160px]"
          />
          <button onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
            <Plus size={13} /> Add Sheet
          </button>
          {selectedManageSheetId && (
            <button onClick={handleDelete} disabled={deleting}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-500 px-2 py-2 rounded-xl border border-gray-200 hover:border-red-200 transition-all disabled:opacity-50">
              <Trash2 size={13} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-[130px]">
            <Select
              value={categoryFilter === "ALL" ? "" : categoryFilter}
              onChange={(v) => setCategoryFilter((v || "ALL") as CategoryFilter)}
              placeholder="All Categories"
              options={[{ value: "", label: "All Categories" }, { value: "SAM", label: "SAM" }, { value: "EV", label: "EV" }]}
            />
          </div>
          <button
            onClick={handleSync}
            disabled={syncing || !selectedManageSheetId}
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
                <div className="flex flex-col gap-1 min-w-[110px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Quarter</label>
                  <Select
                    value={newQuarter}
                    onChange={setNewQuarter}
                    placeholder="Select…"
                    options={QUARTERS.map((q) => ({ value: q, label: q }))}
                  />
                </div>
                <div className="flex flex-col gap-1 min-w-[110px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Year</label>
                  <Select
                    value={newYear}
                    onChange={setNewYear}
                    placeholder="Select…"
                    options={yearOptions}
                  />
                </div>
                <button onClick={handleAddSheet} disabled={adding}
                  className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
                  {adding ? "Adding…" : syncing ? "Syncing…" : "Add & Sync"}
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
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Year{mode === "yearly" ? " (this is your selection)" : ""}</p>
          <div className="flex flex-wrap gap-1.5">
            {availablePeriods.years.map((y) => (
              <button key={y} onClick={() => toggleYear(y)} className={chipClass(selectedYears.has(y))}>{y}</button>
            ))}
            {availablePeriods.years.length === 0 && <span className="text-xs text-gray-400">No data synced yet</span>}
          </div>
        </div>

        {mode === "monthly" && (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Month{selectedMonthTokens.size !== 1 ? "s" : ""} (pick any, need not be consecutive)</p>
            <div className="flex flex-wrap gap-1.5">
              {visibleMonthOptions.map((m) => {
                const t = `${m.year}-${String(m.month).padStart(2, "0")}`;
                return (
                  <button key={t} onClick={() => toggleMonthToken(t)} className={chipClass(selectedMonthTokens.has(t))}>
                    {MONTH_NAMES[m.month]} {m.year}
                  </button>
                );
              })}
              {visibleMonthOptions.length === 0 && <span className="text-xs text-gray-400">No months available</span>}
            </div>
          </div>
        )}

        {mode === "quarterly" && (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">Quarter{selectedQuarterTokens.size !== 1 ? "s" : ""}</p>
            <div className="flex flex-wrap gap-1.5">
              {visibleQuarterOptions.map((q) => {
                const t = `${q.year}-${q.quarter}`;
                return (
                  <button key={t} onClick={() => toggleQuarterToken(t)} className={chipClass(selectedQuarterTokens.has(t))}>
                    {q.label}
                  </button>
                );
              })}
              {visibleQuarterOptions.length === 0 && <span className="text-xs text-gray-400">No quarters registered</span>}
            </div>
          </div>
        )}
      </div>

      {sheetSources.length === 0 && (
        <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">
          No quarter registered yet. Click "Add Sheet" above to register the team's quarterly Depot-to-Distributor sheet.
        </div>
      )}

      {sheetSources.length > 0 && periodTokens.length === 0 && !loading && (
        <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">
          Select at least one {mode === "monthly" ? "month" : mode === "quarterly" ? "quarter" : "year"} above to view analytics.
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
          {/* Period comparison — the mechanism for cross-period comparison: one
              bar/card per selected period. Degrades gracefully to a single card
              when only one period is selected. */}
          <div className="card-premium p-6">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500"><BarChart3 size={16} /></div>
              <div>
                <h3 className="text-sm font-bold text-gray-800">Period Comparison</h3>
                <p className="text-[11px] text-gray-400">Target vs Achieved for every period selected above</p>
              </div>
            </div>
            {analytics.periods.length > 1 && (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={analytics.periods.map((p) => ({ name: p.label, Target: p.target, Achieved: p.achieved }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{v}</span>} />
                  <Bar dataKey="Target" fill="#3b82f6" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="Achieved" fill="#f46617" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
            <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${analytics.periods.length > 1 ? "mt-4" : ""}`}>
              {analytics.periods.map((p) => (
                <div key={p.key} className="rounded-xl border border-gray-100 p-3">
                  <div className="flex items-center gap-1.5">
                    <p className="text-xs font-bold text-gray-700 truncate">{p.label}</p>
                    {p.is_partial && (
                      <span className="text-[9px] font-bold uppercase tracking-wide text-orange-500 bg-orange-50 px-1.5 py-0.5 rounded-full shrink-0">Partial</span>
                    )}
                  </div>
                  <p className="text-lg font-black mt-1" style={{ color: pctColorScoped(p.attainment_pct, p.is_partial) }}>
                    {p.attainment_pct !== null ? `${p.attainment_pct}%` : "—"}
                  </p>
                  <p className="text-[11px] text-gray-400">{formatCr(p.achieved)} of {formatCr(p.target)}</p>
                </div>
              ))}
            </div>
          </div>

          <AttainmentLegend isPartial={isPartial} />

          {/* KPI cards — company (blended across the whole selection) */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {kpiCards.map((kpi) => <KpiCard key={kpi.id} kpi={kpi} />)}
          </div>

          {/* KPI cards — Area Heads */}
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 ml-1">Area Head Performance</p>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              {asmKpiCards.map((kpi) => <KpiCard key={kpi.id} kpi={kpi} />)}
            </div>
          </div>

          {/* KPI cards — Distributors */}
          <div>
            <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2 ml-1">Distributor Performance</p>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              {distKpiCards.map((kpi) => <KpiCard key={kpi.id} kpi={kpi} />)}
            </div>
          </div>

          {/* Monthly trend + SAM vs EV company split */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="card-premium p-6 xl:col-span-2">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><TrendingUp size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Monthly Trend</h3>
                  <p className="text-[11px] text-gray-400">SAM and EV trajectory across the selection</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{v}</span>} />
                  <Line type="monotone" dataKey="SAM" stroke="#3b82f6" strokeWidth={2.5} dot={{ fill: "#3b82f6", r: 4 }} activeDot={{ r: 6 }} />
                  <Line type="monotone" dataKey="EV" stroke="#a855f7" strokeWidth={2.5} dot={{ fill: "#a855f7", r: 4 }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            {/* SAM vs EV split — always shows both, independent of the category filter */}
            <div className="card-premium p-5">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">SAM vs EV Split</h3>
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
          </div>

          {/* Area Head attainment chart */}
          {chartData.length > 0 && (
            <div className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500"><Users size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Area Head Attainment</h3>
                  <p className="text-[11px] text-gray-400">% of target achieved per ASM, blended across the selection</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 32)}>
                <BarChart data={chartData} layout="vertical" barSize={18}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                  <YAxis dataKey="area_head" type="category" tick={{ fontSize: 11, fill: "#64748b" }} width={120} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => `${v}%`} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="attainment_pct" radius={[0, 6, 6, 0]} name="Attainment">
                    {chartData.map((d) => <Cell key={d.area_head} fill={pctColorScoped(d.attainment_pct, isPartial)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* SAM vs EV breakdown per Area Head */}
          {samEvByAreaHead.length > 0 && (
            <div className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-purple-50 flex items-center justify-center text-purple-500"><Users size={16} /></div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">SAM vs EV per Area Head</h3>
                  <p className="text-[11px] text-gray-400">Category mix by ASM, blended across the selection</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={Math.max(200, samEvByAreaHead.length * 36)}>
                <BarChart data={samEvByAreaHead} layout="vertical" barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => formatCr(v)} />
                  <YAxis dataKey="area_head" type="category" tick={{ fontSize: 11, fill: "#64748b" }} width={120} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v: number) => formatINR(v)} contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Legend iconType="circle" iconSize={8} formatter={(v) => <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{v}</span>} />
                  <Bar dataKey="SAM" stackId="a" fill="#3b82f6" name="SAM" />
                  <Bar dataKey="EV" stackId="a" fill="#a855f7" name="EV" radius={[0, 6, 6, 0]} />
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
                            <p className="font-bold mt-1" style={{ color: pctColorScoped(d.attainment_pct, isPartial) }}>
                              {d.attainment_pct !== null ? `${d.attainment_pct}%` : "—"}
                            </p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="attainment_pct" radius={[0, 6, 6, 0]} name="Attainment">
                      {distributorChartData.map((d) => <Cell key={d.distributor} fill={pctColorScoped(d.attainment_pct, isPartial)} />)}
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
                      <span className="text-gray-500">Target {g.target !== null ? formatCr(g.target) : "—"}</span>
                      <span className="text-gray-700 font-semibold">Achieved {formatCr(g.achieved)}</span>
                      <span className="font-bold px-2 py-0.5 rounded-full" style={{ color: pctColorScoped(g.attainment_pct, isPartial), background: pctColorScoped(g.attainment_pct, isPartial) + "20" }}>
                        {g.attainment_pct !== null ? `${g.attainment_pct}%` : "—"}
                      </span>
                      {g.target !== null && g.target > 0 && (
                        <span className="font-semibold" style={{ color: isPartial ? "#94a3b8" : g.target - g.achieved <= 0 ? "#22c55e" : "#ef4444" }}>
                          {g.target - g.achieved <= 0 ? `+${formatCr(g.achieved - g.target)} extra` : `Gap ${formatCr(g.target - g.achieved)}`}
                        </span>
                      )}
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
                                {months.map((ym) => visibleCategories.map((cat) => (
                                  <th key={`${ym.year}-${ym.month}-${cat}`} className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2 whitespace-nowrap">
                                    {MONTH_NAMES[ym.month]} {ym.year} {cat.toUpperCase()}
                                  </th>
                                )))}
                                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">Achieved</th>
                                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-3 py-2">Gap</th>
                                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-2">%</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {g.distributors.map((d) => (
                                <tr key={d.distributor} className="hover:bg-gray-50/30">
                                  <td className="px-6 py-2.5 text-xs font-medium text-gray-700">{d.distributor}</td>
                                  <td className="px-3 py-2.5 text-xs text-gray-500 text-right">{d.target !== null ? formatINR(d.target) : "—"}</td>
                                  {months.map((ym) => visibleCategories.map((cat) => (
                                    <td key={`${ym.year}-${ym.month}-${cat}`} className="px-3 py-2.5 text-xs text-gray-500 text-right whitespace-nowrap">
                                      {formatINR(monthValue(d, ym, cat))}
                                    </td>
                                  )))}
                                  <td className="px-3 py-2.5 text-xs font-semibold text-gray-800 text-right">{formatINR(d.achieved)}</td>
                                  <td className="px-3 py-2.5 text-xs font-semibold text-right whitespace-nowrap"
                                    style={{ color: d.target === null ? "#94a3b8" : isPartial ? "#94a3b8" : d.target - d.achieved <= 0 ? "#22c55e" : "#ef4444" }}>
                                    {d.target !== null ? (d.target - d.achieved <= 0 ? `+${formatINR(d.achieved - d.target)}` : formatINR(d.target - d.achieved)) : "—"}
                                  </td>
                                  <td className="px-4 py-2.5 text-xs font-bold text-right" style={{ color: pctColorScoped(d.attainment_pct, isPartial) }}>
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
                  <span className="font-bold" style={{ color: pctColorScoped(filteredCompanyTotal.attainment_pct, isPartial) }}>
                    {filteredCompanyTotal.attainment_pct !== null ? `${filteredCompanyTotal.attainment_pct}%` : "—"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Sync history — scoped to whichever sheet is selected in the manage picker above */}
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
