import { Fragment, useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CarFront, Phone, Footprints, Building2, Users, RefreshCw, Plus, Trash2,
  Search, History, CheckCircle2, XCircle, Clock, Target, X,
  Printer, ChevronRight, Percent,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, LabelList,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/lib/format";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Series colors follow the entity everywhere on this page: field visits are
// orange, phone calls are blue (same palette as the rest of the app).
const VISIT_COLOR = "#f46617";
const CALL_COLOR = "#3b82f6";

// ── Types ─────────────────────────────────────────────────────────────────────
interface OESource {
  id: string; sheet_id: string; label: string; sheet_type: "visit_plan" | "log_book";
  calendar_year: number | null; month: number | null;
  created_at: string | null; last_synced_at: string | null; last_sync_status: string | null;
}
interface SyncResult {
  rows_total: number; rows_inserted: number; rows_deleted: number;
  skipped_tabs: string[]; errors: string[]; status: string;
}
interface Period { year: number; month: number; }
interface PlanRow {
  id: string; salesperson: string; visit_date: string | null;
  oem: string | null; dealer_name: string; city: string | null; state: string | null;
}
interface LogRow {
  id: string; visit_date: string; salesperson: string | null; contact_mode: string | null;
  oem: string | null; dealership: string; address: string | null; designation: string | null;
  car_sales: number | null; seat_cover_sales: number | null; mats_sales: number | null;
  remarks: string | null; city: string | null; state: string | null;
}
interface PvaRow {
  salesperson: string; log_name: string | null; planned: number; dealers_planned: number;
  visits: number; calls: number; total_logged: number; dealerships_contacted: number;
  coverage_pct: number | null;
}
interface GroupRow { key: string; total: number; visits: number; calls: number; dealerships: number; }
interface LogAnalytics {
  kpis: {
    total_logs: number; visits: number; calls: number; dealerships: number; salespersons: number;
    avg_car_sales: number | null; avg_seat_cover_sales: number | null; avg_mats_sales: number | null;
  };
  by_salesperson: GroupRow[]; by_oem: GroupRow[]; by_state: GroupRow[];
  monthly_trend: { year: number; month: number; total: number; visits: number; calls: number }[];
}

interface DealerRow {
  dealer_name: string; oem: string | null; city: string | null; state: string | null;
  last_salesperson: string | null; last_mode: string | null; last_remark: string | null;
  last_contact: string | null; days_since: number | null;
  total: number; visits: number; calls: number;
  avg_car_sales: number | null; avg_seat_cover_sales: number | null; attach_pct: number | null;
}
interface DealerContact {
  visit_date: string; salesperson: string | null; contact_mode: string | null; oem: string | null;
  designation: string | null; car_sales: number | null; seat_cover_sales: number | null;
  mats_sales: number | null; remarks: string | null; city: string | null; state: string | null;
}
interface AdhDealer {
  dealer_name: string; oem: string | null; city: string | null; planned_visits: number;
  status: "visited" | "called" | "missed"; log_dealership: string | null;
  visits: number; calls: number;
}
interface AdhRow {
  salesperson: string; log_name: string | null;
  planned: number; visited: number; called_only: number; missed: number;
  adherence_pct: number | null; touch_pct: number | null; unplanned_count: number;
  dealers: AdhDealer[];
  unplanned: { dealership: string; oem: string | null; visits: number; calls: number }[];
}
interface AttachOem {
  oem: string; dealers: number; attach_pct: number | null;
  mats_attach_pct: number | null; avg_car_sales: number | null;
}

type TabId = "overview" | "indepth" | "plans" | "logs" | "sheets";
type PeriodMode = "monthly" | "quarterly" | "yearly";

function monthToken(p: Period) { return `${p.year}-${p.month}`; }
function tokenLabel(t: string) {
  const [y, m] = t.split("-").map(Number);
  return `${MONTH_FULL[m - 1]} ${y}`;
}

// Indian FY (Apr–Mar), same convention as the Sales module: Q1 = Apr–Jun and
// "FY26-27" starts April 2026.
function fyOf(year: number, month: number) { return month >= 4 ? year : year - 1; }
function fqOf(month: number) { return month >= 4 ? Math.floor((month - 4) / 3) + 1 : 4; }
function quarterToken(fy: number, q: number) { return `${fy}-Q${q}`; }
function quarterLabel(t: string) {
  const [fyStr, qStr] = t.split("-Q");
  return `Q${qStr} FY${String(Number(fyStr) + 1).slice(2)}`;
}
function fyLabel(fy: number) { return `FY${String(fy).slice(2)}-${String(fy + 1).slice(2)}`; }
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Expands a selected period token into the inclusive YYYY-MM range the API takes. */
function periodRange(mode: PeriodMode, token: string): [string, string] {
  if (mode === "monthly") {
    const [y, m] = token.split("-").map(Number);
    return [`${y}-${pad2(m)}`, `${y}-${pad2(m)}`];
  }
  if (mode === "quarterly") {
    const [fyStr, qStr] = token.split("-Q");
    const fy = Number(fyStr), q = Number(qStr);
    if (q === 4) return [`${fy + 1}-01`, `${fy + 1}-03`];
    const start = 4 + (q - 1) * 3;
    return [`${fy}-${pad2(start)}`, `${fy}-${pad2(start + 2)}`];
  }
  const fy = Number(token);
  return [`${fy}-04`, `${fy + 1}-03`];
}

/** Sticky wrapper so filters stay reachable while the page is scrolled. */
function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="no-print sticky top-0 z-30 -mx-6 px-6 py-2.5 bg-white/85 backdrop-blur-md border-b border-orange-50">
      <div className="flex items-center gap-2 flex-wrap">{children}</div>
    </div>
  );
}
function shortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Axis-tick version of a salesperson name: first real name word, skipping initials. */
function firstName(n: string) {
  return n.split(/\s+/).find((t) => t.length >= 3) ?? n;
}

function coverageColor(pct: number | null) {
  if (pct === null) return "text-gray-400";
  if (pct >= 80) return "text-green-600";
  if (pct >= 50) return "text-amber-600";
  return "text-red-500";
}

function ModeBadge({ mode }: { mode: string | null }) {
  if (!mode) return <span className="text-gray-300">—</span>;
  const isVisit = mode === "Visit";
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
      style={isVisit
        ? { color: VISIT_COLOR, background: "#fff4ed" }
        : { color: CALL_COLOR, background: "#eff6ff" }}
    >
      {isVisit ? <Footprints size={10} /> : <Phone size={10} />}
      {mode}
    </span>
  );
}

function StatCard({ label, value, sub, icon, color, bg }: {
  label: string; value: string | number; sub?: string;
  icon: React.ReactNode; color: string; bg: string;
}) {
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 flex items-center gap-3 shadow-sm min-w-0">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, color }}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 truncate">{label}</p>
        <p className="text-xl font-black text-gray-800 leading-tight">{value}</p>
        {sub && <p className="text-[10px] text-gray-400 truncate">{sub}</p>}
      </div>
    </div>
  );
}

function Pagination({ page, total, perPage, onPage }: {
  page: number; total: number; perPage: number; onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-3">
      <p className="text-[11px] text-gray-400">
        Page {page} of {pages} · {total.toLocaleString("en-IN")} rows
      </p>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}
          className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-orange-200 disabled:opacity-40">
          Previous
        </button>
        <button disabled={page >= pages} onClick={() => onPage(page + 1)}
          className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-orange-200 disabled:opacity-40">
          Next
        </button>
      </div>
    </div>
  );
}

const inputClass =
  "h-9 px-3 rounded-xl border border-gray-200 text-xs text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all";

// ══════════════════════════════════════════════════════════════════════════════
// Overview tab — plan-vs-actual coverage + log analytics for one month
// ══════════════════════════════════════════════════════════════════════════════
function OverviewTab({ headers }: { headers: Record<string, string> }) {
  const toast = useToast();
  const [periods, setPeriods] = useState<{ plan_months: Period[]; log_months: Period[] } | null>(null);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("monthly");
  const [selected, setSelected] = useState<string>("");
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[]; cities: string[]; contact_modes: string[] } | null>(null);
  const [salesperson, setSalesperson] = useState("");
  const [oem, setOem] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [mode, setMode] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [pva, setPva] = useState<{ rows: PvaRow[]; totals: { planned: number; visits: number; calls: number; coverage_pct: number | null } } | null>(null);
  const [analytics, setAnalytics] = useState<LogAnalytics | null>(null);
  const [trend, setTrend] = useState<LogAnalytics["monthly_trend"]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes, srcRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/periods`, { headers }),
        fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers }),
        fetch(`${API_URL}/oe-network/sheet-sources`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (srcRes.ok) {
        const sources: OESource[] = await srcRes.json();
        const stamps = sources.map((s) => s.last_synced_at).filter(Boolean) as string[];
        setLastSynced(stamps.length ? stamps.sort()[stamps.length - 1] : null);
      }
      if (!perRes.ok) return;
      const data = await perRes.json();
      setPeriods(data);
      const union = [...data.plan_months, ...data.log_months]
        .map(monthToken)
        .sort((a, b) => {
          const [ya, ma] = a.split("-").map(Number);
          const [yb, mb] = b.split("-").map(Number);
          return ya - yb || ma - mb;
        });
      // Keep the user's chosen period across sync refreshes.
      if (union.length) setSelected((prev) => prev || union[union.length - 1]);
      else setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`${API_URL}/oe-network/sync-latest`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Sync failed");
      const results: { label: string; status: string; rows_inserted: number; error?: string }[] = data.results;
      const failed = results.filter((r) => r.status !== "Done");
      if (failed.length) {
        toast.error("Some sheets failed to sync", failed.map((f) => f.label).join(", "));
      } else {
        const rows = results.reduce((s, r) => s + (r.rows_inserted ?? 0), 0);
        toast.success("Data refreshed", `${rows.toLocaleString("en-IN")} rows loaded from ${results.length} sheet${results.length > 1 ? "s" : ""}`);
      }
      setRefresh((x) => x + 1);
    } catch (e) {
      toast.error("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    if (!selected) return;
    const [fromYm, toYm] = periodRange(periodMode, selected);
    // Same entity filters everywhere; mode applies only to the log analytics
    // (coverage is by definition visits-vs-plan), period scoping only to the
    // non-trend calls.
    const entity = new URLSearchParams();
    if (salesperson) entity.set("salesperson", salesperson);
    if (oem) entity.set("oem", oem);
    if (state) entity.set("state", state);
    if (city) entity.set("city", city);
    if (qDebounced) entity.set("q", qDebounced);
    const logParams = new URLSearchParams(entity);
    if (mode) logParams.set("contact_mode", mode);
    const periodScoped = new URLSearchParams(logParams);
    periodScoped.set("from_ym", fromYm);
    periodScoped.set("to_ym", toYm);
    const pvaParams = new URLSearchParams(entity);
    pvaParams.set("from_ym", fromYm);
    pvaParams.set("to_ym", toYm);

    setLoading(true);
    (async () => {
      const [pvaRes, anaRes, allRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/plan-vs-actual?${pvaParams}`, { headers }),
        fetch(`${API_URL}/oe-network/log-analytics?${periodScoped}`, { headers }),
        fetch(`${API_URL}/oe-network/log-analytics?${logParams}`, { headers }),
      ]);
      if (pvaRes.ok) setPva(await pvaRes.json());
      if (anaRes.ok) setAnalytics(await anaRes.json());
      if (allRes.ok) setTrend((await allRes.json()).monthly_trend);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, periodMode, salesperson, oem, state, city, mode, qDebounced, refresh]);

  const hasFilters = Boolean(salesperson || oem || state || city || mode || q);
  const clearFilters = () => {
    setSalesperson(""); setOem(""); setState(""); setCity(""); setMode(""); setQ("");
  };

  // Union of months that exist in either sheet, then the quarter/FY option
  // lists derived from them — so future data makes new options appear on its own.
  const optionsByMode = useMemo<Record<PeriodMode, { value: string; label: string }[]>>(() => {
    if (!periods) return { monthly: [], quarterly: [], yearly: [] };
    const months = new Map<string, Period>();
    [...periods.plan_months, ...periods.log_months].forEach((p) => months.set(monthToken(p), p));
    const sorted = [...months.values()].sort((a, b) => b.year - a.year || b.month - a.month);

    const monthly = sorted.map((p) => ({ value: monthToken(p), label: tokenLabel(monthToken(p)) }));
    const quarters = new Set<string>();
    const fys = new Set<number>();
    sorted.forEach((p) => {
      const fy = fyOf(p.year, p.month);
      quarters.add(quarterToken(fy, fqOf(p.month)));
      fys.add(fy);
    });
    const quarterly = [...quarters]
      .sort((a, b) => {
        const [fa, qa] = a.split("-Q").map(Number);
        const [fb, qb] = b.split("-Q").map(Number);
        return fb - fa || qb - qa;
      })
      .map((t) => ({ value: t, label: quarterLabel(t) }));
    const yearly = [...fys].sort((a, b) => b - a).map((fy) => ({ value: String(fy), label: fyLabel(fy) }));
    return { monthly, quarterly, yearly };
  }, [periods]);

  const periodOptions = optionsByMode[periodMode];

  // Switching views lands on the latest period of that view, never an empty selection.
  const switchMode = (m: PeriodMode) => {
    setPeriodMode(m);
    const first = optionsByMode[m][0];
    if (first) setSelected(first.value);
  };

  if (!loading && optionsByMode.monthly.length === 0) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
        No data yet — register and sync the visit plan and log book sheets from the <b>Sheets</b> tab.
      </div>
    );
  }

  const salespersonChart = (analytics?.by_salesperson ?? []).map((r) => ({
    name: r.key, Visits: r.visits, Calls: r.calls, Total: r.total,
  }));
  const stateChart = (analytics?.by_state ?? []).slice(0, 10).map((r) => ({ name: r.key, Contacts: r.total }));
  const trendChart = trend.map((t) => ({
    name: `${MONTH_SHORT[t.month - 1]} ${String(t.year).slice(2)}`, Visits: t.visits, Calls: t.calls,
  }));

  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
          {(["monthly", "quarterly", "yearly"] as PeriodMode[]).map((m) => (
            <button key={m} onClick={() => switchMode(m)}
              className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg capitalize transition-all ${
                periodMode === m ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {m}
            </button>
          ))}
        </div>
        <Select value={selected} onChange={setSelected} options={periodOptions} placeholder="Period…" />
        <Select value={salesperson} onChange={setSalesperson} options={toOpts(options?.salespersons, "All salespersons")} placeholder="Salesperson" />
        <Select value={oem} onChange={setOem} options={toOpts(options?.oems, "All OEMs")} placeholder="OEM" />
        <Select value={state} onChange={setState} options={toOpts(options?.states, "All states")} placeholder="State" />
        <Select value={city} onChange={setCity} options={toOpts(options?.cities, "All cities")} placeholder="City" />
        <Select value={mode} onChange={setMode} options={toOpts(options?.contact_modes, "Visits + Calls")} placeholder="Mode" />
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealership…"
            className={`${inputClass} pl-8 w-40`} />
        </div>
        {hasFilters && (
          <button onClick={clearFilters}
            className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
            <X size={12} /> Clear
          </button>
        )}
        {loading && <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />}
        <div className="flex items-center gap-2 ml-auto">
          {lastSynced && (
            <span className="text-[10px] text-gray-400 hidden xl:block" title="Most recent sheet sync">
              Data as of {formatDate(lastSynced)}
            </span>
          )}
          <button onClick={handleSyncAll} disabled={syncing}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-50 transition-all"
            title="Re-pull the log book and the latest visit plan from Google Sheets">
            {syncing
              ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
              : <><RefreshCw size={11} /> Sync</>}
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all"
            title="Print this view or save it as a PDF">
            <Printer size={12} /> PDF
          </button>
        </div>
      </FilterBar>

      {/* Print-only context line — the filter bar is hidden on paper */}
      <div className="print-only">
        <p className="text-sm font-bold text-gray-900">
          {periodOptions.find((o) => o.value === selected)?.label ?? ""}
          {salesperson && ` · ${salesperson}`}{oem && ` · ${oem}`}{state && ` · ${state}`}
          {city && ` · ${city}`}{mode && ` · ${mode}`}{qDebounced && ` · “${qDebounced}”`}
        </p>
        <p className="text-[10px] text-gray-400">
          {lastSynced ? `Data as of ${formatDate(lastSynced)} · ` : ""}
          Printed {new Date().toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Planned Visits" value={pva?.totals.planned ?? 0}
          icon={<Target size={18} />} color="#a855f7" bg="#f5f3ff" />
        <StatCard label="Visits Done" value={pva?.totals.visits ?? 0}
          icon={<Footprints size={18} />} color={VISIT_COLOR} bg="#fff4ed" />
        <StatCard label="Calls Made" value={pva?.totals.calls ?? 0}
          icon={<Phone size={18} />} color={CALL_COLOR} bg="#eff6ff" />
        <StatCard label="Coverage" value={pva?.totals.coverage_pct != null ? `${pva.totals.coverage_pct}%` : "—"}
          sub="visits done vs planned" icon={<CheckCircle2 size={18} />} color="#22c55e" bg="#f0fdf4" />
        <StatCard label="Dealerships" value={analytics?.kpis.dealerships ?? 0}
          sub="contacted this period" icon={<Building2 size={18} />} color="#0ea5e9" bg="#f0f9ff" />
      </div>

      {/* Plan vs actual table */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Plan vs Actual — by Salesperson</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <th className="py-2 pr-3">Salesperson</th>
                <th className="py-2 pr-3 text-right">Planned</th>
                <th className="py-2 pr-3 text-right">Visits</th>
                <th className="py-2 pr-3 text-right">Calls</th>
                <th className="py-2 pr-3 text-right">Total Logged</th>
                <th className="py-2 pr-3 text-right">Dealerships</th>
                <th className="py-2 text-right">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {(pva?.rows ?? []).map((r) => (
                <tr key={r.salesperson} className="border-b border-gray-50 hover:bg-orange-50/40">
                  <td className="py-2 pr-3 font-semibold text-gray-700">
                    {r.salesperson}
                    {r.log_name && r.log_name !== r.salesperson && (
                      <span className="text-gray-400 font-normal"> · logs as {r.log_name}</span>
                    )}
                    {r.planned === 0 && (
                      <span className="ml-1.5 text-[9px] font-bold uppercase text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">no plan</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right text-gray-600">{r.planned}</td>
                  <td className="py-2 pr-3 text-right font-semibold" style={{ color: VISIT_COLOR }}>{r.visits}</td>
                  <td className="py-2 pr-3 text-right font-semibold" style={{ color: CALL_COLOR }}>{r.calls}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{r.total_logged}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{r.dealerships_contacted}</td>
                  <td className={`py-2 text-right font-bold ${coverageColor(r.coverage_pct)}`}>
                    {r.coverage_pct != null ? `${r.coverage_pct}%` : "—"}
                  </td>
                </tr>
              ))}
              {(pva?.rows ?? []).length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-gray-400">No plan or log data for this month</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-gray-400 mt-2">
          Coverage compares field visits (not calls) against the advance plan. Names are matched across the two
          sheets automatically.
        </p>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Activity by Salesperson</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={salespersonChart} margin={{ top: 16, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false}
                interval={0} tickFormatter={firstName} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="Visits" stackId="a" fill={VISIT_COLOR} radius={[0, 0, 0, 0]}>
                <LabelList dataKey="Visits" position="center" fill="#ffffff" fontSize={10} fontWeight={700}
                  formatter={(v: number) => (v > 0 ? v : "")} />
              </Bar>
              <Bar dataKey="Calls" stackId="a" fill={CALL_COLOR} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="Calls" position="center" fill="#ffffff" fontSize={10} fontWeight={700}
                  formatter={(v: number) => (v > 0 ? v : "")} />
                <LabelList dataKey="Total" position="top" fill="#6b7280" fontSize={10} fontWeight={700} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Monthly Trend — All Time</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={trendChart} margin={{ top: 16, right: 16, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="Visits" stroke={VISIT_COLOR} strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="Calls" stroke={CALL_COLOR} strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* OEM breakdown — table with inline bars (few rows, exact values matter) */}
        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">By OEM</h3>
          <div className="flex flex-col gap-2">
            {(analytics?.by_oem ?? []).map((r) => {
              const max = Math.max(...(analytics?.by_oem ?? []).map((x) => x.total), 1);
              return (
                <div key={r.key} className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-gray-600 w-24 shrink-0 truncate" title={r.key}>{r.key}</span>
                  <div className="flex-1 h-5 bg-gray-50 rounded-md overflow-hidden flex">
                    <div className="flex items-center justify-center text-[9px] font-bold text-white"
                      style={{ width: `${(r.visits / max) * 100}%`, background: VISIT_COLOR }} title={`${r.visits} visits`}>
                      {r.visits / max >= 0.07 ? r.visits : ""}
                    </div>
                    <div className="flex items-center justify-center text-[9px] font-bold text-white"
                      style={{ width: `${(r.calls / max) * 100}%`, background: CALL_COLOR, marginLeft: 2 }} title={`${r.calls} calls`}>
                      {r.calls / max >= 0.07 ? r.calls : ""}
                    </div>
                  </div>
                  <span className="text-xs font-bold text-gray-700 w-10 text-right">{r.total}</span>
                </div>
              );
            })}
            {(analytics?.by_oem ?? []).length === 0 && <p className="text-xs text-gray-400">No data</p>}
          </div>
          <div className="flex items-center gap-4 mt-3">
            <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: VISIT_COLOR }} /> Visits
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CALL_COLOR }} /> Calls
            </span>
          </div>
        </div>

        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Top States by Contacts</h3>
          <ResponsiveContainer width="100%" height={Math.max(160, stateChart.length * 26)}>
            <BarChart data={stateChart} layout="vertical" margin={{ top: 0, right: 24, left: 30, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#6b7280" }} width={90} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }} />
              <Bar dataKey="Contacts" fill={VISIT_COLOR} radius={[0, 4, 4, 0]} barSize={12}>
                <LabelList dataKey="Contacts" position="right" fill="#6b7280" fontSize={10} fontWeight={700} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Dealer-reported averages */}
      {analytics?.kpis.avg_car_sales != null && (
        <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">Dealer-Reported Monthly Figures (averages)</h3>
          <p className="text-[10px] text-gray-400 mb-3">
            Average of what dealerships reported during contacts — these are the dealers' own monthly numbers, not Amato sales.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Avg Car Sales" value={analytics.kpis.avg_car_sales ?? "—"} icon={<CarFront size={18} />} color="#6b7280" bg="#f9fafb" />
            <StatCard label="Avg Seat Cover Sales" value={analytics.kpis.avg_seat_cover_sales ?? "—"} icon={<Users size={18} />} color="#6b7280" bg="#f9fafb" />
            <StatCard label="Avg Mats Sales" value={analytics.kpis.avg_mats_sales ?? "—"} icon={<Users size={18} />} color="#6b7280" bg="#f9fafb" />
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// In-Depth tab — dealer network health, dealer-level plan adherence, attach rates
// ══════════════════════════════════════════════════════════════════════════════

/** "How long since we touched this dealer" — green ≤15d, amber ≤45d, red beyond. */
function RecencyBadge({ days }: { days: number | null }) {
  if (days == null) return <span className="text-gray-300">—</span>;
  const label = days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
  const [color, bg] =
    days <= 15 ? ["#16a34a", "#f0fdf4"] : days <= 45 ? ["#d97706", "#fffbeb"] : ["#ef4444", "#fef2f2"];
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: bg }}>
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: AdhDealer["status"] }) {
  const map: Record<AdhDealer["status"], [string, string, string]> = {
    visited: ["Visited", "#16a34a", "#f0fdf4"],
    called: ["Called only", CALL_COLOR, "#eff6ff"],
    missed: ["Missed", "#ef4444", "#fef2f2"],
  };
  const [label, color, bg] = map[status];
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color, background: bg }}>
      {label}
    </span>
  );
}

function InDepthTab({ headers }: { headers: Record<string, string> }) {
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[] } | null>(null);
  const [planMonths, setPlanMonths] = useState<Period[]>([]);

  // Plan adherence (dealer-level, one month at a time — plans are monthly)
  const [adhMonth, setAdhMonth] = useState("");
  const [adhSp, setAdhSp] = useState("");
  const [adh, setAdh] = useState<{
    rows: AdhRow[];
    totals: { planned: number; visited: number; called_only: number; missed: number; unplanned: number; adherence_pct: number | null; touch_pct: number | null };
  } | null>(null);
  const [adhLoading, setAdhLoading] = useState(false);
  const [expandedSp, setExpandedSp] = useState<string | null>(null);

  // Dealer directory
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [sort, setSort] = useState("recent");
  const [dirOem, setDirOem] = useState("");
  const [dirState, setDirState] = useState("");
  const [dirSp, setDirSp] = useState("");
  const [page, setPage] = useState(1);
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [dirTotal, setDirTotal] = useState(0);
  const [dirSummary, setDirSummary] = useState<{ dealers: number; active_30: number; stale_45: number } | null>(null);
  const [dirLoading, setDirLoading] = useState(true);
  const [expandedDealer, setExpandedDealer] = useState<string | null>(null);
  const [histories, setHistories] = useState<Record<string, DealerContact[]>>({});

  // Attach rates (all-time — dealer figures are monthly self-reports)
  const [attach, setAttach] = useState<{ overall: { dealers: number; attach_pct: number | null }; by_oem: AttachOem[] } | null>(null);

  const perPage = 25;

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes, attRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/periods`, { headers }),
        fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers }),
        fetch(`${API_URL}/oe-network/attach-rates`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (attRes.ok) setAttach(await attRes.json());
      if (perRes.ok) {
        const p = await perRes.json();
        setPlanMonths(p.plan_months);
        if (p.plan_months.length) setAdhMonth(monthToken(p.plan_months[p.plan_months.length - 1]));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!adhMonth) return;
    const [y, m] = adhMonth.split("-");
    const params = new URLSearchParams({ year: y, month: m });
    if (adhSp) params.set("salesperson", adhSp);
    setAdhLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/plan-adherence?${params}`, { headers });
      if (res.ok) setAdh(await res.json());
      setAdhLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adhMonth, adhSp]);

  useEffect(() => { setPage(1); }, [qDeb, sort, dirOem, dirState, dirSp]);

  useEffect(() => {
    const params = new URLSearchParams({ sort, page: String(page), per_page: String(perPage) });
    if (qDeb) params.set("q", qDeb);
    if (dirOem) params.set("oem", dirOem);
    if (dirState) params.set("state", dirState);
    if (dirSp) params.set("salesperson", dirSp);
    setDirLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/dealers?${params}`, { headers });
      if (res.ok) {
        const data = await res.json();
        setDealers(data.data);
        setDirTotal(data.total);
        setDirSummary(data.summary);
      }
      setDirLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeb, sort, dirOem, dirState, dirSp, page]);

  const toggleDealer = async (name: string) => {
    if (expandedDealer === name) { setExpandedDealer(null); return; }
    setExpandedDealer(name);
    if (!histories[name]) {
      const res = await fetch(`${API_URL}/oe-network/dealers/history?name=${encodeURIComponent(name)}`, { headers });
      if (res.ok) {
        const d = await res.json();
        setHistories((prev) => ({ ...prev, [name]: d.contacts }));
      }
    }
  };

  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];
  const adhMonthOptions = planMonths
    .map((p) => ({ value: monthToken(p), label: tokenLabel(monthToken(p)) }))
    .reverse();
  const sortOptions = [
    { value: "recent", label: "Recently contacted" },
    { value: "stale", label: "Stalest first" },
    { value: "most", label: "Most contacted" },
    { value: "name", label: "Name A–Z" },
  ];
  const attachMax = Math.max(...(attach?.by_oem ?? []).map((r) => r.attach_pct ?? 0), 1);

  return (
    <div className="flex flex-col gap-5">
      {/* Network health KPIs — follow the directory filters below */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Network Dealers" value={dirSummary?.dealers ?? 0}
          sub="unique dealerships contacted" icon={<Building2 size={18} />} color="#0ea5e9" bg="#f0f9ff" />
        <StatCard label="Active" value={dirSummary?.active_30 ?? 0}
          sub="contacted in the last 30 days" icon={<CheckCircle2 size={18} />} color="#22c55e" bg="#f0fdf4" />
        <StatCard label="Going Cold" value={dirSummary?.stale_45 ?? 0}
          sub="no contact for 45+ days" icon={<Clock size={18} />} color="#ef4444" bg="#fef2f2" />
        <StatCard label="Avg Attach Rate" value={attach?.overall.attach_pct != null ? `${attach.overall.attach_pct}%` : "—"}
          sub="seat covers vs dealer car sales" icon={<Percent size={18} />} color="#a855f7" bg="#f5f3ff" />
      </div>

      {/* Plan adherence — dealer level */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Plan Adherence — Dealer Level</h3>
            <p className="text-[10px] text-gray-400">
              Was each planned dealership actually contacted? Names are matched approximately across the two sheets.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={adhSp} onChange={setAdhSp} options={toOpts(options?.salespersons, "All salespersons")} placeholder="Salesperson" />
            <Select value={adhMonth} onChange={setAdhMonth} options={adhMonthOptions} placeholder="Month…" />
            {adhLoading && <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />}
          </div>
        </div>

        {adh && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 py-2 text-[11px]">
            <span className={`font-bold ${coverageColor(adh.totals.adherence_pct)}`}>
              {adh.totals.adherence_pct != null ? `${adh.totals.adherence_pct}% adherence` : "No plan data"}
            </span>
            <span className="text-gray-500"><b className="text-gray-700">{adh.totals.planned}</b> planned dealers</span>
            <span className="text-green-600 font-semibold">{adh.totals.visited} visited</span>
            <span className="font-semibold" style={{ color: CALL_COLOR }}>{adh.totals.called_only} called only</span>
            <span className="text-red-500 font-semibold">{adh.totals.missed} missed</span>
            <span className="text-amber-600 font-semibold">{adh.totals.unplanned} contacted off-plan</span>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-1">
          {(adh?.rows ?? []).map((r) => (
            <div key={r.salesperson} className="border border-gray-100 rounded-xl overflow-hidden">
              <button onClick={() => setExpandedSp(expandedSp === r.salesperson ? null : r.salesperson)}
                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-orange-50/40 text-left transition-colors">
                <ChevronRight size={14} className={`text-gray-300 shrink-0 transition-transform ${expandedSp === r.salesperson ? "rotate-90" : ""}`} />
                <span className="text-xs font-semibold text-gray-700 flex-1 min-w-0 truncate">
                  {r.salesperson}
                  {r.planned === 0 && (
                    <span className="ml-1.5 text-[9px] font-bold uppercase text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">no plan</span>
                  )}
                </span>
                <span className="hidden md:flex items-center gap-3 text-[11px] shrink-0">
                  <span className="text-gray-400">{r.planned} planned</span>
                  <span className="text-green-600 font-semibold">{r.visited} visited</span>
                  <span className="font-semibold" style={{ color: CALL_COLOR }}>{r.called_only} called</span>
                  <span className="text-red-500 font-semibold">{r.missed} missed</span>
                  {r.unplanned_count > 0 && <span className="text-amber-600 font-semibold">{r.unplanned_count} off-plan</span>}
                </span>
                <span className={`text-xs font-bold w-14 text-right shrink-0 ${coverageColor(r.adherence_pct)}`}>
                  {r.adherence_pct != null ? `${r.adherence_pct}%` : "—"}
                </span>
              </button>
              <AnimatePresence>
                {expandedSp === r.salesperson && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="px-4 pb-4 pt-2 border-t border-gray-50 flex flex-col gap-3">
                      {r.dealers.length > 0 && (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                                <th className="py-1.5 pr-3">Planned Dealer</th>
                                <th className="py-1.5 pr-3">OEM</th>
                                <th className="py-1.5 pr-3">City</th>
                                <th className="py-1.5 pr-3">Status</th>
                                <th className="py-1.5 pr-3">Logged as</th>
                                <th className="py-1.5 pr-3 text-right">Visits</th>
                                <th className="py-1.5 text-right">Calls</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.dealers.map((d, i) => (
                                <tr key={i} className="border-b border-gray-50 last:border-0">
                                  <td className="py-1.5 pr-3 text-gray-700">{d.dealer_name}</td>
                                  <td className="py-1.5 pr-3 text-gray-500">{d.oem ?? "—"}</td>
                                  <td className="py-1.5 pr-3 text-gray-500">{d.city ?? "—"}</td>
                                  <td className="py-1.5 pr-3"><StatusPill status={d.status} /></td>
                                  <td className="py-1.5 pr-3 text-gray-400">
                                    {d.log_dealership && d.log_dealership.toLowerCase() !== d.dealer_name.toLowerCase()
                                      ? d.log_dealership : d.log_dealership ? "✓" : "—"}
                                  </td>
                                  <td className="py-1.5 pr-3 text-right font-semibold" style={{ color: VISIT_COLOR }}>{d.visits || ""}</td>
                                  <td className="py-1.5 text-right font-semibold" style={{ color: CALL_COLOR }}>{d.calls || ""}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {r.unplanned.length > 0 && (
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mb-1.5">
                            Contacted but not on the plan ({r.unplanned_count})
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {r.unplanned.map((u, i) => (
                              <span key={i} className="text-[10px] text-gray-600 bg-amber-50/70 border border-amber-100 px-2 py-1 rounded-lg"
                                title={`${u.visits} visits · ${u.calls} calls${u.oem ? ` · ${u.oem}` : ""}`}>
                                {u.dealership}
                                <b className="ml-1 text-amber-700">{u.visits + u.calls}</b>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
          {!adhLoading && (adh?.rows ?? []).length === 0 && (
            <p className="text-xs text-gray-400 py-4 text-center">No plan or log data for this month</p>
          )}
        </div>
      </div>

      {/* Dealer directory */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Dealer Directory</h3>
            <p className="text-[10px] text-gray-400">Every dealership ever contacted — click a row for its full history</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealer…"
                className={`${inputClass} pl-8 w-40`} />
            </div>
            <Select value={dirSp} onChange={setDirSp} options={toOpts(options?.salespersons, "All salespersons")} placeholder="Salesperson" />
            <Select value={dirOem} onChange={setDirOem} options={toOpts(options?.oems, "All OEMs")} placeholder="OEM" />
            <Select value={dirState} onChange={setDirState} options={toOpts(options?.states, "All states")} placeholder="State" />
            <Select value={sort} onChange={setSort} options={sortOptions} placeholder="Sort" />
          </div>
        </div>

        {dirLoading ? (
          <div className="py-10 flex justify-center"><div className="w-5 h-5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                    <th className="py-2 pr-3">Dealership</th>
                    <th className="py-2 pr-3">OEM</th>
                    <th className="py-2 pr-3">Last Contact</th>
                    <th className="py-2 pr-3 text-right">Visits</th>
                    <th className="py-2 pr-3 text-right">Calls</th>
                    <th className="py-2 pr-3">Last By</th>
                    <th className="py-2 pr-3 text-right" title="Dealer's reported monthly car sales, averaged">Avg Cars</th>
                    <th className="py-2 pr-3 text-right" title="Seat-cover sales as % of the dealer's car sales">Attach</th>
                    <th className="py-2">Last Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {dealers.map((r) => (
                    <Fragment key={r.dealer_name}>
                      <tr onClick={() => toggleDealer(r.dealer_name)}
                        className="border-b border-gray-50 hover:bg-orange-50/40 cursor-pointer align-top">
                        <td className="py-2 pr-3 min-w-[160px]">
                          <span className="flex items-start gap-1">
                            <ChevronRight size={12} className={`text-gray-300 mt-0.5 shrink-0 transition-transform ${expandedDealer === r.dealer_name ? "rotate-90" : ""}`} />
                            <span>
                              <span className="font-semibold text-gray-700">{r.dealer_name}</span>
                              <span className="block text-[10px] text-gray-400">
                                {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-gray-600">{r.oem ?? "—"}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">
                          <span className="text-gray-500 mr-1.5">{shortDate(r.last_contact)}</span>
                          <RecencyBadge days={r.days_since} />
                        </td>
                        <td className="py-2 pr-3 text-right font-semibold" style={{ color: VISIT_COLOR }}>{r.visits || "—"}</td>
                        <td className="py-2 pr-3 text-right font-semibold" style={{ color: CALL_COLOR }}>{r.calls || "—"}</td>
                        <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{r.last_salesperson ? firstName(r.last_salesperson) : "—"}</td>
                        <td className="py-2 pr-3 text-right text-gray-600">{r.avg_car_sales ?? "—"}</td>
                        <td className="py-2 pr-3 text-right font-semibold text-purple-600">{r.attach_pct != null ? `${r.attach_pct}%` : "—"}</td>
                        <td className="py-2 text-gray-500 max-w-[220px]">
                          <span className="line-clamp-1" title={r.last_remark ?? undefined}>{r.last_remark ?? "—"}</span>
                        </td>
                      </tr>
                      {expandedDealer === r.dealer_name && (
                        <tr className="bg-orange-50/30">
                          <td colSpan={9} className="px-6 py-3">
                            {!histories[r.dealer_name] ? (
                              <div className="py-3 flex justify-center"><div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
                            ) : (
                              <div className="flex flex-col">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1.5">
                                  Contact history ({histories[r.dealer_name].length})
                                </p>
                                {histories[r.dealer_name].map((c, i) => (
                                  <div key={i} className="flex items-start gap-3 py-1.5 border-b border-orange-100/50 last:border-0">
                                    <span className="text-[10px] text-gray-400 w-14 shrink-0 pt-0.5">{shortDate(c.visit_date)}</span>
                                    <ModeBadge mode={c.contact_mode} />
                                    <span className="text-[11px] font-semibold text-gray-600 w-24 shrink-0 truncate" title={c.salesperson ?? undefined}>
                                      {c.salesperson ? firstName(c.salesperson) : "—"}
                                    </span>
                                    <span className="text-[11px] text-gray-400 shrink-0 whitespace-nowrap">
                                      {[
                                        c.car_sales != null ? `${c.car_sales} cars` : null,
                                        c.seat_cover_sales != null ? `${c.seat_cover_sales} SC` : null,
                                        c.mats_sales != null ? `${c.mats_sales} mats` : null,
                                      ].filter(Boolean).join(" · ")}
                                    </span>
                                    <span className="text-[11px] text-gray-500 flex-1 min-w-0">{c.remarks ?? ""}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {dealers.length === 0 && (
                    <tr><td colSpan={9} className="py-6 text-center text-gray-400">No dealerships match these filters</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={dirTotal} perPage={perPage} onPage={setPage} />
          </>
        )}
      </div>

      {/* Attach rate by OEM */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-1">Seat-Cover Attach Rate by OEM</h3>
        <p className="text-[10px] text-gray-400 mb-3">
          Seat-cover sales as a share of each dealer's own car sales, averaged per dealer first — how deep we are in
          each OEM's network, all time.
        </p>
        <div className="flex flex-col gap-2">
          {(attach?.by_oem ?? []).map((r) => (
            <div key={r.oem} className="flex items-center gap-3">
              <span className="text-xs font-semibold text-gray-600 w-24 shrink-0 truncate" title={r.oem}>{r.oem}</span>
              <div className="flex-1 h-5 bg-gray-50 rounded-md overflow-hidden">
                <div className="h-full rounded-md" title={r.mats_attach_pct != null ? `Mats attach: ${r.mats_attach_pct}%` : undefined}
                  style={{ width: `${Math.min(((r.attach_pct ?? 0) / attachMax) * 100, 100)}%`, background: "#a855f7" }} />
              </div>
              <span className="text-xs font-bold text-purple-600 w-14 text-right">{r.attach_pct != null ? `${r.attach_pct}%` : "—"}</span>
              <span className="text-[10px] text-gray-400 w-20 text-right shrink-0">{r.dealers} dealer{r.dealers === 1 ? "" : "s"}</span>
            </div>
          ))}
          {(attach?.by_oem ?? []).length === 0 && <p className="text-xs text-gray-400">No dealer-reported figures yet</p>}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Visit Plans tab
// ══════════════════════════════════════════════════════════════════════════════
function PlansTab({ headers }: { headers: Record<string, string> }) {
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[]; cities: string[] } | null>(null);
  const [months, setMonths] = useState<Period[]>([]);
  const [month, setMonth] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [oem, setOem] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<{ planned_visits: number; salespersons: number; dealers: number; cities: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const perPage = 50;

  useEffect(() => {
    (async () => {
      const [optRes, perRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/filter-options?scope=plans`, { headers }),
        fetch(`${API_URL}/oe-network/periods`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (perRes.ok) {
        const p = await perRes.json();
        setMonths(p.plan_months);
        if (p.plan_months.length) setMonth(monthToken(p.plan_months[p.plan_months.length - 1]));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (month) {
      const [y, m] = month.split("-");
      params.set("year", y); params.set("month", m);
    }
    if (salesperson) params.set("salesperson", salesperson);
    if (oem) params.set("oem", oem);
    if (state) params.set("state", state);
    if (city) params.set("city", city);
    if (q.trim()) params.set("q", q.trim());
    const res = await fetch(`${API_URL}/oe-network/plans?${params}`, { headers });
    if (res.ok) {
      const data = await res.json();
      setRows(data.data); setTotal(data.total); setSummary(data.summary);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, salesperson, oem, state, city, q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [month, salesperson, oem, state, city, q]);

  const monthOptions = [
    { value: "", label: "All months" },
    ...months.map((p) => ({ value: monthToken(p), label: tokenLabel(monthToken(p)) })).reverse(),
  ];
  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Select value={month} onChange={setMonth} options={monthOptions} placeholder="Month" />
        <Select value={salesperson} onChange={setSalesperson} options={toOpts(options?.salespersons, "All salespersons")} placeholder="Salesperson" />
        <Select value={oem} onChange={setOem} options={toOpts(options?.oems, "All OEMs")} placeholder="OEM" />
        <Select value={state} onChange={setState} options={toOpts(options?.states, "All states")} placeholder="State" />
        <Select value={city} onChange={setCity} options={toOpts(options?.cities, "All cities")} placeholder="City" />
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealer…"
            className={`${inputClass} pl-8 w-44`} />
        </div>
        {(salesperson || oem || state || city || q) && (
          <button onClick={() => { setSalesperson(""); setOem(""); setState(""); setCity(""); setQ(""); }}
            className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
            <X size={12} /> Clear
          </button>
        )}
      </FilterBar>

      {/* Summary chips */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Planned Visits" value={summary?.planned_visits ?? 0} icon={<Target size={18} />} color="#a855f7" bg="#f5f3ff" />
        <StatCard label="Salespersons" value={summary?.salespersons ?? 0} icon={<Users size={18} />} color={VISIT_COLOR} bg="#fff4ed" />
        <StatCard label="Unique Dealers" value={summary?.dealers ?? 0} icon={<Building2 size={18} />} color="#0ea5e9" bg="#f0f9ff" />
        <StatCard label="Cities" value={summary?.cities ?? 0} icon={<CarFront size={18} />} color="#22c55e" bg="#f0fdf4" />
      </div>

      {/* Table */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        {loading ? (
          <div className="py-10 flex justify-center"><div className="w-5 h-5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Salesperson</th>
                    <th className="py-2 pr-3">OEM</th>
                    <th className="py-2 pr-3">Dealer</th>
                    <th className="py-2 pr-3">City</th>
                    <th className="py-2">State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-gray-50 hover:bg-orange-50/40">
                      <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">{shortDate(r.visit_date)}</td>
                      <td className="py-2 pr-3 font-semibold text-gray-700">{r.salesperson}</td>
                      <td className="py-2 pr-3 text-gray-600">{r.oem ?? "—"}</td>
                      <td className="py-2 pr-3 text-gray-700">{r.dealer_name}</td>
                      <td className="py-2 pr-3 text-gray-600">{r.city ?? "—"}</td>
                      <td className="py-2 text-gray-600">{r.state ?? "—"}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={6} className="py-6 text-center text-gray-400">No planned visits match these filters</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={total} perPage={perPage} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Log Book tab
// ══════════════════════════════════════════════════════════════════════════════
function LogsTab({ headers }: { headers: Record<string, string> }) {
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[]; cities: string[]; contact_modes: string[] } | null>(null);
  const [months, setMonths] = useState<Period[]>([]);
  const [month, setMonth] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [oem, setOem] = useState("");
  const [state, setState] = useState("");
  const [mode, setMode] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<{ total_logs: number; visits: number; calls: number; dealerships: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const perPage = 50;

  useEffect(() => {
    (async () => {
      const [optRes, perRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers }),
        fetch(`${API_URL}/oe-network/periods`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (perRes.ok) {
        const p = await perRes.json();
        setMonths(p.log_months);
        if (p.log_months.length) setMonth(monthToken(p.log_months[p.log_months.length - 1]));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (month) {
      const [y, m] = month.split("-");
      params.set("year", y); params.set("month", m);
    }
    if (salesperson) params.set("salesperson", salesperson);
    if (oem) params.set("oem", oem);
    if (state) params.set("state", state);
    if (mode) params.set("contact_mode", mode);
    if (q.trim()) params.set("q", q.trim());
    const res = await fetch(`${API_URL}/oe-network/logs?${params}`, { headers });
    if (res.ok) {
      const data = await res.json();
      setRows(data.data); setTotal(data.total); setSummary(data.summary);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, salesperson, oem, state, mode, q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [month, salesperson, oem, state, mode, q]);

  const monthOptions = [
    { value: "", label: "All time" },
    ...months.map((p) => ({ value: monthToken(p), label: tokenLabel(monthToken(p)) })).reverse(),
  ];
  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];

  return (
    <div className="flex flex-col gap-4">
      <FilterBar>
        <Select value={month} onChange={setMonth} options={monthOptions} placeholder="Month" />
        <Select value={salesperson} onChange={setSalesperson} options={toOpts(options?.salespersons, "All salespersons")} placeholder="Salesperson" />
        <Select value={oem} onChange={setOem} options={toOpts(options?.oems, "All OEMs")} placeholder="OEM" />
        <Select value={state} onChange={setState} options={toOpts(options?.states, "All states")} placeholder="State" />
        <Select value={mode} onChange={setMode} options={toOpts(options?.contact_modes, "Visits + Calls")} placeholder="Mode" />
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search dealership…"
            className={`${inputClass} pl-8 w-44`} />
        </div>
        {(salesperson || oem || state || mode || q) && (
          <button onClick={() => { setSalesperson(""); setOem(""); setState(""); setMode(""); setQ(""); }}
            className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
            <X size={12} /> Clear
          </button>
        )}
      </FilterBar>

      {/* Summary chips */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Logged" value={summary?.total_logs ?? 0} icon={<History size={18} />} color="#a855f7" bg="#f5f3ff" />
        <StatCard label="Visits" value={summary?.visits ?? 0} icon={<Footprints size={18} />} color={VISIT_COLOR} bg="#fff4ed" />
        <StatCard label="Calls" value={summary?.calls ?? 0} icon={<Phone size={18} />} color={CALL_COLOR} bg="#eff6ff" />
        <StatCard label="Dealerships" value={summary?.dealerships ?? 0} icon={<Building2 size={18} />} color="#0ea5e9" bg="#f0f9ff" />
      </div>

      {/* Table */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        {loading ? (
          <div className="py-10 flex justify-center"><div className="w-5 h-5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Salesperson</th>
                    <th className="py-2 pr-3">Mode</th>
                    <th className="py-2 pr-3">OEM</th>
                    <th className="py-2 pr-3">Dealership</th>
                    <th className="py-2 pr-3">City</th>
                    <th className="py-2 pr-3">State</th>
                    <th className="py-2 pr-3 text-right" title="Dealer's reported monthly car sales">Cars</th>
                    <th className="py-2 pr-3 text-right" title="Dealer's reported monthly seat cover sales">Seat Covers</th>
                    <th className="py-2 pr-3 text-right" title="Dealer's reported monthly mats sales">Mats</th>
                    <th className="py-2">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-gray-50 hover:bg-orange-50/40 align-top">
                      <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">{shortDate(r.visit_date)}</td>
                      <td className="py-2 pr-3 font-semibold text-gray-700 whitespace-nowrap">{r.salesperson ?? "—"}</td>
                      <td className="py-2 pr-3"><ModeBadge mode={r.contact_mode} /></td>
                      <td className="py-2 pr-3 text-gray-600">{r.oem ?? "—"}</td>
                      <td className="py-2 pr-3 text-gray-700 min-w-[140px]">{r.dealership}</td>
                      <td className="py-2 pr-3 text-gray-600">{r.city ?? "—"}</td>
                      <td className="py-2 pr-3 text-gray-600 whitespace-nowrap">{r.state ?? "—"}</td>
                      <td className="py-2 pr-3 text-right text-gray-600">{r.car_sales ?? "—"}</td>
                      <td className="py-2 pr-3 text-right text-gray-600">{r.seat_cover_sales ?? "—"}</td>
                      <td className="py-2 pr-3 text-right text-gray-600">{r.mats_sales ?? "—"}</td>
                      <td className="py-2 text-gray-500 max-w-[240px]">
                        <span className="line-clamp-2" title={r.remarks ?? undefined}>{r.remarks ?? "—"}</span>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={11} className="py-6 text-center text-gray-400">No log entries match these filters</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={total} perPage={perPage} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Sheets tab — registry + sync for both sheet types
// ══════════════════════════════════════════════════════════════════════════════
interface HistoryItem {
  id: string; sheet_type: string; source_label: string; rows_total: number;
  rows_inserted: number; rows_failed: number; rows_deleted: number;
  status: string; synced_at: string | null;
}

function SheetsTab({ headers }: { headers: Record<string, string> }) {
  const toast = useToast();
  const [sources, setSources] = useState<OESource[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  // Add-form state — one form per sheet type
  const [showAddPlan, setShowAddPlan] = useState(false);
  const [planLink, setPlanLink] = useState("");
  const now = new Date();
  const [planMonth, setPlanMonth] = useState(String(now.getMonth() + 1));
  const [planYear, setPlanYear] = useState(String(now.getFullYear()));
  const [showAddLog, setShowAddLog] = useState(false);
  const [logLink, setLogLink] = useState("");
  const [adding, setAdding] = useState(false);

  const loadSources = useCallback(async () => {
    const res = await fetch(`${API_URL}/oe-network/sheet-sources`, { headers });
    if (res.ok) setSources(await res.json());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const loadHistory = useCallback(async () => {
    const res = await fetch(`${API_URL}/oe-network/sync-history`, { headers });
    if (res.ok) setHistory(await res.json());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadSources(); loadHistory(); }, [loadSources, loadHistory]);

  const handleSync = async (id: string) => {
    setSyncingId(id);
    setLastResult(null);
    try {
      const res = await fetch(`${API_URL}/oe-network/sheet-sources/${id}/sync`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Sync failed");
      setLastResult(data);
      toast.success("Sync complete", `${data.rows_inserted} rows loaded${data.rows_deleted ? `, ${data.rows_deleted} old rows replaced` : ""}`);
    } catch (e) {
      toast.error("Sync failed", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingId(null);
      loadSources();
      loadHistory();
    }
  };

  const handleDelete = async (s: OESource) => {
    if (!window.confirm(`Remove "${s.label}" and all its synced data? This cannot be undone.`)) return;
    setDeletingId(s.id);
    try {
      const res = await fetch(`${API_URL}/oe-network/sheet-sources/${s.id}`, { method: "DELETE", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Delete failed");
      toast.success("Sheet removed", `${data.rows_deleted} data rows cleared`);
    } catch (e) {
      toast.error("Could not remove sheet", e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
      loadSources();
    }
  };

  const handleAdd = async (sheetType: "visit_plan" | "log_book") => {
    const link = sheetType === "visit_plan" ? planLink : logLink;
    if (!link.trim()) return;
    setAdding(true);
    try {
      const body: Record<string, unknown> = { sheet_url_or_id: link.trim(), sheet_type: sheetType };
      if (sheetType === "visit_plan") {
        body.month = Number(planMonth);
        body.year = Number(planYear);
      }
      const res = await fetch(`${API_URL}/oe-network/sheet-sources`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Could not add sheet");
      toast.success("Sheet registered", data.label);
      if (sheetType === "visit_plan") { setShowAddPlan(false); setPlanLink(""); }
      else { setShowAddLog(false); setLogLink(""); }
      await loadSources();
      // First sync right away, like every other sheet module.
      await handleSync(data.id);
    } catch (e) {
      toast.error("Could not add sheet", e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const planSources = sources.filter((s) => s.sheet_type === "visit_plan");
  const logSources = sources.filter((s) => s.sheet_type === "log_book");

  const monthOptions = MONTH_FULL.map((m, i) => ({ value: String(i + 1), label: m }));
  const yearOptions = Array.from({ length: 4 }, (_, i) => now.getFullYear() - 2 + i)
    .map((y) => ({ value: String(y), label: String(y) }));

  const statusIcon = (status: string | null) => {
    if (status === "Done") return <CheckCircle2 size={13} className="text-green-500" />;
    if (status === "Failed") return <XCircle size={13} className="text-red-500" />;
    if (status) return <Clock size={13} className="text-amber-500" />;
    return null;
  };

  const sourceRow = (s: OESource) => (
    <div key={s.id} className="flex items-center justify-between gap-3 py-2.5 border-b border-gray-50 last:border-0">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-700 truncate">{s.label}</p>
        <p className="text-[10px] text-gray-400 flex items-center gap-1">
          {statusIcon(s.last_sync_status)}
          {s.last_synced_at ? `Last synced ${formatDate(s.last_synced_at)}` : "Never synced"}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button onClick={() => handleSync(s.id)} disabled={syncingId !== null}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-50 transition-all">
          {syncingId === s.id
            ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>
            : <><RefreshCw size={11} /> Sync Now</>}
        </button>
        <button onClick={() => handleDelete(s)} disabled={deletingId === s.id}
          className="flex items-center text-gray-300 hover:text-red-500 p-1.5 rounded-lg border border-transparent hover:border-red-100 transition-all disabled:opacity-40">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Visit plan sheets */}
        <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Advance Visit Plans</h3>
              <p className="text-[10px] text-gray-400">One sheet per month — salesperson tabs are detected automatically</p>
            </div>
            <button onClick={() => setShowAddPlan(!showAddPlan)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
              <Plus size={13} /> Add Month
            </button>
          </div>
          <AnimatePresence>
            {showAddPlan && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex flex-col gap-2">
                  <input value={planLink} onChange={(e) => setPlanLink(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/…" className={inputClass} />
                  <div className="flex gap-2">
                    <Select value={planMonth} onChange={setPlanMonth} options={monthOptions} className="flex-1" />
                    <Select value={planYear} onChange={setPlanYear} options={yearOptions} />
                    <button onClick={() => handleAdd("visit_plan")} disabled={adding || !planLink.trim()}
                      className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                      {adding ? "Adding…" : "Add & Sync"}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {planSources.length
            ? planSources.map(sourceRow)
            : <p className="text-xs text-gray-400 py-3">No visit plan sheets registered yet.</p>}
        </div>

        {/* Log book */}
        <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Log Book</h3>
              <p className="text-[10px] text-gray-400">The continuous Google Form responses sheet</p>
            </div>
            {logSources.length === 0 && (
              <button onClick={() => setShowAddLog(!showAddLog)}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
                <Plus size={13} /> Add Sheet
              </button>
            )}
          </div>
          <AnimatePresence>
            {showAddLog && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex gap-2">
                  <input value={logLink} onChange={(e) => setLogLink(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/…" className={`${inputClass} flex-1`} />
                  <button onClick={() => handleAdd("log_book")} disabled={adding || !logLink.trim()}
                    className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                    {adding ? "Adding…" : "Add & Sync"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {logSources.length
            ? logSources.map(sourceRow)
            : <p className="text-xs text-gray-400 py-3">No log book registered yet.</p>}
        </div>
      </div>

      {/* Last sync result */}
      {lastResult && (
        <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Last Sync Result</h3>
          <div className="flex flex-wrap gap-6 text-xs">
            <span><b className="text-gray-800">{lastResult.rows_total}</b> <span className="text-gray-400">rows read</span></span>
            <span><b className="text-green-600">{lastResult.rows_inserted}</b> <span className="text-gray-400">loaded</span></span>
            <span><b className="text-gray-600">{lastResult.rows_deleted}</b> <span className="text-gray-400">replaced</span></span>
            {lastResult.skipped_tabs.length > 0 && (
              <span className="text-gray-400">Skipped tabs: {lastResult.skipped_tabs.join(", ")}</span>
            )}
          </div>
          {lastResult.errors.length > 0 && (
            <div className="mt-3 bg-amber-50 border border-amber-100 rounded-xl p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 mb-1">Row notes</p>
              {lastResult.errors.map((e, i) => (
                <p key={i} className="text-[11px] text-amber-700">{e}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sync history */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
          <History size={13} /> Sync History
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                <th className="py-2 pr-3">Sheet</th>
                <th className="py-2 pr-3">Type</th>
                <th className="py-2 pr-3 text-right">Rows</th>
                <th className="py-2 pr-3 text-right">Replaced</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-gray-50">
                  <td className="py-2 pr-3 text-gray-700 font-medium">{h.source_label}</td>
                  <td className="py-2 pr-3 text-gray-500">{h.sheet_type === "visit_plan" ? "Visit Plan" : "Log Book"}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{h.rows_inserted}</td>
                  <td className="py-2 pr-3 text-right text-gray-600">{h.rows_deleted}</td>
                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-1">
                      {statusIcon(h.status)}
                      <span className="text-gray-600">{h.status}</span>
                    </span>
                  </td>
                  <td className="py-2 text-gray-500">{h.synced_at ? formatDate(h.synced_at) : "—"}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-gray-400">No syncs yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Page shell
// ══════════════════════════════════════════════════════════════════════════════
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "indepth", label: "In-Depth" },
  { id: "plans", label: "Visit Plans" },
  { id: "logs", label: "Log Book" },
  { id: "sheets", label: "Sheets" },
];

const TAB_SUBTITLES: Record<TabId, string> = {
  overview: "Plan coverage and field activity",
  indepth: "Dealer network health, plan adherence and attach rates",
  plans: "Advance dealer visit plans by month",
  logs: "Dealership visits and calls from the field team",
  sheets: "Connect and sync the source Google Sheets",
};

export default function OENetworkPage() {
  const { token } = useAuth();
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [activeTab, setActiveTab] = useState<TabId>("overview");

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Print-only header (the interactive chrome is hidden on paper) */}
      <div className="print-only mb-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">Amato · OE Network</div>
        <div className="text-xl font-bold text-gray-900 mt-0.5">{TABS.find((t) => t.id === activeTab)?.label}</div>
      </div>

      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="no-print flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-3">
            <span className="page-title-dark">OE NETWORK</span>
            <span className="page-title-orange">{TABS.find((t) => t.id === activeTab)?.label.toUpperCase()}</span>
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-8 h-0.5 bg-gray-800 rounded" />
            <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">{TAB_SUBTITLES[activeTab]}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                activeTab === t.id ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </motion.div>

      {activeTab === "overview" && <OverviewTab headers={headers} />}
      {activeTab === "indepth" && <InDepthTab headers={headers} />}
      {activeTab === "plans" && <PlansTab headers={headers} />}
      {activeTab === "logs" && <LogsTab headers={headers} />}
      {activeTab === "sheets" && <SheetsTab headers={headers} />}
    </div>
  );
}
