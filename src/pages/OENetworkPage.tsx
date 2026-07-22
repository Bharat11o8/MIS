import { Fragment, useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CarFront, Phone, Footprints, Building2, Users, RefreshCw, Plus, Trash2,
  Search, History, CheckCircle2, XCircle, Clock, Target, X,
  Printer, ChevronRight, Percent, TrendingUp, MessageSquare, Tag,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, LabelList,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { formatCompact, formatDate } from "@/lib/format";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Series colors follow the entity everywhere on this page: field visits are
// orange, phone calls are blue (same palette as the rest of the app).
const VISIT_COLOR = "#f46617";
const CALL_COLOR = "#3b82f6";
// On the bullet charts the grey track is the goal (planned visits / the target).
const TGT_TRACK = "#e5e7eb";
const OVER_COLOR = "#22c55e";
// A quarter from 90% of target up counts as on-track for the business, so the
// target bars turn green there rather than at a literal 100%.
const ON_TRACK_PCT = 90;

// ── Types ─────────────────────────────────────────────────────────────────────
interface OESource {
  id: string; sheet_id: string; label: string; sheet_type: "visit_plan" | "log_book" | "targets";
  calendar_year: number | null; month: number | null; quarter: string | null;
  created_at: string | null; last_synced_at: string | null; last_sync_status: string | null;
}
interface SyncResult {
  rows_total: number; rows_inserted: number; rows_deleted: number;
  skipped_tabs: string[]; errors: string[]; status: string;
}
interface Period { year: number; month: number; }
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

/** Every targets payload carries units AND money side by side — they tell
 *  different stories (Hyundai AMJ: 72% on units, 84% on money), so the tab
 *  toggles between them without refetching and neither is "the" number. */
interface TgtMetrics {
  tgt_nos: number; ach_nos: number; tgt_value: number; ach_value: number;
  ach_pct_nos: number | null; ach_pct_value: number | null;
  gap_nos: number; gap_value: number;
}
interface TgtGroup extends TgtMetrics { key: string; region?: string | null }
interface TgtSummary {
  fy_year: number; quarter: number; label: string;
  kpis: TgtMetrics;
  by_salesperson: TgtGroup[];
  by_oem: TgtGroup[];
  by_oem_category: (TgtMetrics & { oem: string; key: string })[];
  by_region: TgtGroup[];
  by_month: (TgtMetrics & { year: number; month: number })[];
  value_scales: Record<string, string>;
}
interface TgtPeriod { fy_year: number; quarter: number; token: string; label: string }

// ── Field Activity (remarks) ───────────────────────────────────────────────────
interface RemarkTheme { key: string; label: string; count: number }
interface RemarkLatest {
  visit_date: string; dealership: string | null; oem: string | null;
  contact_mode: string | null; remarks: string; themes: string[];
}
interface PersonRollup {
  salesperson: string; remarks: number; visits: number; calls: number; dealers: number;
  top_themes: RemarkTheme[]; latest: RemarkLatest | null;
}
interface RemarkFeedRow {
  id: string; visit_date: string; salesperson: string | null; contact_mode: string | null;
  oem: string | null; dealership: string | null; city: string | null; state: string | null;
  remarks: string; themes: string[];
}
interface RemarksData {
  kpis: { remarks: number; dealers: number; salespersons: number; visits: number; calls: number };
  themes: RemarkTheme[];
  by_salesperson: PersonRollup[];
  feed: { total: number; page: number; per_page: number; data: RemarkFeedRow[] };
}

// Each theme reads in its own muted colour everywhere it appears (chips in the
// feed, the rollup cards, and the theme filter row) so the eye can track a theme
// across the page. Keys mirror services/remark_themes.py.
const THEME_META: Record<string, { label: string; color: string; bg: string }> = {
  order_booked: { label: "Order booked", color: "#16a34a", bg: "#f0fdf4" },
  order_push: { label: "Order pushed", color: "#f46617", bg: "#fff4ed" },
  follow_up: { label: "Follow-up", color: "#d97706", bg: "#fffbeb" },
  product_pitch: { label: "Catalogue pitched", color: "#3b82f6", bg: "#eff6ff" },
  back_order: { label: "Back order", color: "#dc2626", bg: "#fef2f2" },
  stock: { label: "Stock", color: "#0d9488", bg: "#f0fdfa" },
  payment_issue: { label: "Fund / payment", color: "#e11d48", bg: "#fff1f2" },
  new_dealer: { label: "New dealer", color: "#a855f7", bg: "#f5f3ff" },
  incentive: { label: "Incentive", color: "#6366f1", bg: "#eef2ff" },
  market_feedback: { label: "Market", color: "#64748b", bg: "#f1f5f9" },
  complaint: { label: "Concern", color: "#b91c1c", bg: "#fef2f2" },
};
const themeMeta = (key: string) => THEME_META[key] ?? { label: key, color: "#6b7280", bg: "#f9fafb" };

type TabId = "overview" | "indepth" | "activity" | "targets" | "sheets";
type Metric = "value" | "nos";
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

/**
 * Bar widths on the bullet charts stop short of the full track so the value
 * printed at the bar's tip always has somewhere to go. Labels sit outside the
 * bar in the bar's own colour rather than reversed out in white inside it —
 * a white label only stays readable while it's over the fill, and the moment a
 * bar falls short of its target the tail of the number lands on the grey track
 * and disappears.
 *
 * The gutter is reserved in PIXELS, not percent: a label is a fixed width no
 * matter how wide the card is, so a percentage reserve would quietly stop being
 * enough on a laptop even though it looked fine on a monitor.
 */
const LABEL_RESERVE = 54;
const barWidth = (n: number, max: number) =>
  `calc(${Math.min(n / max, 1).toFixed(4)} * (100% - ${LABEL_RESERVE}px))`;

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

/**
 * Target-vs-actual bullet rows, one per salesperson. Grey track = visits planned,
 * orange fill = visits actually done (past the tick means they beat the plan),
 * blue bar = calls, which are real work but never count toward coverage.
 * Every bar shares one scale, so lengths are comparable across the team.
 */
function PlanVsActualChart({ rows }: { rows: PvaRow[] }) {
  // Ranked best-to-worst — the point of the chart is who is off plan.
  // "No plan" people have no coverage to rank, so they sit at the bottom.
  const ranked = [...rows].sort((a, b) => {
    if (a.coverage_pct == null) return b.coverage_pct == null ? 0 : 1;
    if (b.coverage_pct == null) return -1;
    return b.coverage_pct - a.coverage_pct;
  });
  const max = Math.max(1, ...rows.flatMap((r) => [r.planned, r.visits, r.calls]));
  const w = (n: number) => barWidth(n, max);

  if (ranked.length === 0) {
    return <p className="text-xs text-gray-400 py-6 text-center">No plan or log data for this period</p>;
  }

  return (
    <div className="flex flex-col gap-3.5 pt-1">
      {ranked.map((r) => (
        <div key={r.salesperson} className="flex items-center gap-3">
          <div className="w-[118px] shrink-0 min-w-0">
            <p className="text-xs font-semibold text-gray-700 truncate"
              title={r.log_name && r.log_name !== r.salesperson ? `${r.salesperson} · logs as ${r.log_name}` : r.salesperson}>
              {r.salesperson}
            </p>
            {r.planned === 0 && <p className="text-[9px] font-bold uppercase text-amber-600">no plan</p>}
          </div>

          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {/* Visits against the plan — the grey track ends at the plan, so it
                marks the goal on its own; only an overshoot needs a notch. */}
            <div className="relative h-5">
              {r.planned > 0 && (
                <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(r.planned), background: TGT_TRACK }} />
              )}
              <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(r.visits), background: VISIT_COLOR }} />
              {r.visits > r.planned && r.planned > 0 && (
                <div className="absolute inset-y-0 w-[2px]" style={{ left: w(r.planned), background: "rgba(255,255,255,0.9)" }} />
              )}
              {/* Done-out-of-planned reads at the bar tip, where the eye already is. */}
              <span className="absolute top-1/2 -translate-y-1/2 text-[9px] font-bold leading-none whitespace-nowrap"
                style={{ left: `calc(${w(r.visits)} + 5px)`, color: VISIT_COLOR }}>
                {r.visits}
                {r.planned > 0 && <span className="font-semibold text-gray-400">/{r.planned}</span>}
              </span>
            </div>
            {/* Calls — same scale, deliberately outside the coverage measure */}
            <div className="relative h-2.5">
              <div className="absolute inset-y-0 left-0 rounded" style={{ width: w(r.calls), background: CALL_COLOR }} />
              <span className="absolute top-1/2 -translate-y-1/2 text-[9px] font-bold leading-none"
                style={{ left: `calc(${w(r.calls)} + 5px)`, color: CALL_COLOR }}>
                {r.calls}
              </span>
            </div>
          </div>

          <div className="w-[72px] shrink-0 text-right">
            <p className={`text-sm font-black leading-none ${coverageColor(r.coverage_pct)}`}>
              {r.coverage_pct != null ? `${r.coverage_pct}%` : "—"}
            </p>
            <p className="text-[9px] text-gray-400 mt-0.5">{r.dealerships_contacted} dealers</p>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-4 flex-wrap pt-1">
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: VISIT_COLOR }} /> Visits done
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: CALL_COLOR }} /> Calls
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: TGT_TRACK }} /> Planned
        </span>
      </div>
    </div>
  );
}

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
          <button onClick={() => setRefresh((x) => x + 1)} disabled={loading}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 disabled:opacity-50 transition-all"
            title="Re-fetch this view (and its filters) from the server — no Google Sheets pull">
            <RefreshCw size={11} /> Refresh
          </button>
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

      {/* Plan vs actual */}
      <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Plan vs Actual — by Salesperson</h3>
        <p className="text-[10px] text-gray-400 mb-1">Ranked by coverage — field visits against the advance plan</p>
        <PlanVsActualChart rows={pva?.rows ?? []} />
        <p className="text-[10px] text-gray-400 mt-3">
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
// Field Activity tab — remark themes, per-salesperson rollup, full field log
// ══════════════════════════════════════════════════════════════════════════════

/** A theme tag as it appears in the feed and rollup cards. */
function ThemeChip({ themeKey, count }: { themeKey: string; count?: number }) {
  const m = themeMeta(themeKey);
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ color: m.color, background: m.bg }}>
      {m.label}{count != null && <span className="opacity-70">{count}</span>}
    </span>
  );
}

/** The clickable theme filter row — one chip per theme with its tally, the
 *  active one lit. Clicking narrows the feed; clicking it again clears it. */
function ThemeFilterRow({ themes, active, onPick }: {
  themes: RemarkTheme[]; active: string; onPick: (k: string) => void;
}) {
  if (!themes.length) return <p className="text-xs text-gray-400 py-2">No themed remarks in this slice.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {themes.map((t) => {
        const m = themeMeta(t.key);
        const on = active === t.key;
        return (
          <button key={t.key} onClick={() => onPick(t.key)}
            className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1 transition-all"
            style={{
              borderColor: on ? m.color : "#f1f0ee",
              background: on ? m.bg : "#fff",
            }}
            title={`${t.count} remark${t.count === 1 ? "" : "s"} — click to ${on ? "clear" : "filter"}`}>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: m.color }} />
            <span className="text-[11px] font-semibold" style={{ color: on ? m.color : "#374151" }}>{m.label}</span>
            <span className="text-[11px] font-black" style={{ color: m.color }}>{t.count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One field person's card — activity counts and what they're mostly doing
 *  (top themes). Clicking scopes the whole tab to them. */
function PersonCard({ p, active, onPick }: {
  p: PersonRollup; active: boolean; onPick: () => void;
}) {
  return (
    <button onClick={onPick}
      className={`text-left bg-white border rounded-2xl p-4 shadow-sm transition-all hover:border-orange-200 ${
        active ? "border-orange-300 ring-2 ring-orange-100" : "border-orange-100"
      }`}>
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-100 to-orange-50 text-orange-500 flex items-center justify-center font-black text-sm shrink-0">
          {(p.salesperson[0] || "?").toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-gray-800 truncate" title={p.salesperson}>{p.salesperson}</p>
          <p className="text-[10px] text-gray-400">
            <b className="text-gray-600">{p.remarks}</b> notes · {p.dealers} dealer{p.dealers === 1 ? "" : "s"}
          </p>
        </div>
        <div className="text-right shrink-0">
          <span className="text-[10px] font-bold" style={{ color: VISIT_COLOR }}>{p.visits}V</span>
          <span className="text-[10px] font-bold text-gray-300"> · </span>
          <span className="text-[10px] font-bold" style={{ color: CALL_COLOR }}>{p.calls}C</span>
        </div>
      </div>

      {p.top_themes.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-3">
          {p.top_themes.map((t) => <ThemeChip key={t.key} themeKey={t.key} count={t.count} />)}
        </div>
      )}
    </button>
  );
}

function FieldActivityTab({ headers }: { headers: Record<string, string> }) {
  const [logMonths, setLogMonths] = useState<Period[]>([]);
  const [periodMode, setPeriodMode] = useState<PeriodMode>("monthly");
  const [selected, setSelected] = useState("");
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[]; cities: string[]; contact_modes: string[] } | null>(null);

  const [salesperson, setSalesperson] = useState("");
  const [oem, setOem] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [mode, setMode] = useState("");
  const [theme, setTheme] = useState("");
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<RemarksData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    (async () => {
      const [perRes, optRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/periods`, { headers }),
        fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (perRes.ok) {
        const p = await perRes.json();
        setLogMonths(p.log_months);
        if (!p.log_months.length) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Period option lists derived from the months that actually have logs.
  const optionsByMode = useMemo<Record<PeriodMode, { value: string; label: string }[]>>(() => {
    const sorted = [...logMonths].sort((a, b) => b.year - a.year || b.month - a.month);
    const monthly = sorted.map((p) => ({ value: monthToken(p), label: tokenLabel(monthToken(p)) }));
    const quarters = new Set<string>();
    const fys = new Set<number>();
    sorted.forEach((p) => {
      const fy = fyOf(p.year, p.month);
      quarters.add(quarterToken(fy, fqOf(p.month)));
      fys.add(fy);
    });
    const quarterly = [...quarters].sort((a, b) => {
      const [fa, qa] = a.split("-Q").map(Number);
      const [fb, qb] = b.split("-Q").map(Number);
      return fb - fa || qb - qa;
    }).map((t) => ({ value: t, label: quarterLabel(t) }));
    const yearly = [...fys].sort((a, b) => b - a).map((fy) => ({ value: String(fy), label: fyLabel(fy) }));
    return { monthly, quarterly, yearly };
  }, [logMonths]);

  const periodOptions = optionsByMode[periodMode];
  useEffect(() => {
    // Land on the latest available period once the lists are built.
    if (!selected && optionsByMode.monthly.length) setSelected(optionsByMode.monthly[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsByMode]);

  const switchMode = (m: PeriodMode) => {
    setPeriodMode(m);
    const first = optionsByMode[m][0];
    if (first) setSelected(first.value);
  };

  // Any change to the slice resets to the first page of the feed.
  useEffect(() => { setPage(1); }, [selected, periodMode, salesperson, oem, state, city, mode, theme, qDeb]);

  useEffect(() => {
    if (!selected) return;
    const [fromYm, toYm] = periodRange(periodMode, selected);
    const params = new URLSearchParams({ from_ym: fromYm, to_ym: toYm, page: String(page), per_page: "30" });
    if (salesperson) params.set("salesperson", salesperson);
    if (oem) params.set("oem", oem);
    if (state) params.set("state", state);
    if (city) params.set("city", city);
    if (mode) params.set("contact_mode", mode);
    if (theme) params.set("theme", theme);
    if (qDeb) params.set("q", qDeb);
    setLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/remarks?${params}`, { headers });
      if (res.ok) setData(await res.json());
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, periodMode, salesperson, oem, state, city, mode, theme, qDeb, page, refreshKey]);

  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];
  const hasFilters = Boolean(salesperson || oem || state || city || mode || theme || q);
  const clearFilters = () => {
    setSalesperson(""); setOem(""); setState(""); setCity(""); setMode(""); setTheme(""); setQ("");
  };

  if (!loading && optionsByMode.monthly.length === 0) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
        No log book data yet — register and sync the log book from the <b>Sheets</b> tab.
      </div>
    );
  }

  const feed = data?.feed.data ?? [];

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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search remark or dealer…"
            className={`${inputClass} pl-8 w-44`} />
        </div>
        {hasFilters && (
          <button onClick={clearFilters}
            className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
            <X size={12} /> Clear
          </button>
        )}
        {loading && <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />}
        <button onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 disabled:opacity-50 transition-all"
          title="Re-fetch this view (and its filters) from the server">
          <RefreshCw size={11} /> Refresh
        </button>
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
          <Printer size={12} /> PDF
        </button>
      </FilterBar>

      <div className="print-only">
        <p className="text-sm font-bold text-gray-900">
          Field Activity · {periodOptions.find((o) => o.value === selected)?.label ?? ""}
          {salesperson && ` · ${salesperson}`}{oem && ` · ${oem}`}{theme && ` · ${themeMeta(theme).label}`}
          {qDeb && ` · “${qDeb}”`}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Remarks" value={data?.kpis.remarks ?? 0} sub="field notes logged"
          icon={<MessageSquare size={18} />} color="#f46617" bg="#fff4ed" />
        <StatCard label="Dealers Touched" value={data?.kpis.dealers ?? 0}
          icon={<Building2 size={18} />} color="#0ea5e9" bg="#f0f9ff" />
        <StatCard label="People Active" value={data?.kpis.salespersons ?? 0}
          icon={<Users size={18} />} color="#a855f7" bg="#f5f3ff" />
        <StatCard label="Visits" value={data?.kpis.visits ?? 0}
          icon={<Footprints size={18} />} color={VISIT_COLOR} bg="#fff4ed" />
        <StatCard label="Calls" value={data?.kpis.calls ?? 0}
          icon={<Phone size={18} />} color={CALL_COLOR} bg="#eff6ff" />
      </div>

      {/* What's being reported — theme filter row */}
      <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
              <Tag size={13} /> What the field is reporting
            </h3>
            <p className="text-[10px] text-gray-400">
              Every remark auto-tagged by what it's about — click a theme to filter the log below. A note can carry more than one.
            </p>
          </div>
          {theme && (
            <button onClick={() => setTheme("")}
              className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
              <X size={12} /> Clear theme
            </button>
          )}
        </div>
        <ThemeFilterRow themes={data?.themes ?? []} active={theme} onPick={(k) => setTheme(theme === k ? "" : k)} />
      </div>

      {/* Per-salesperson rollup — "what is everyone up to" */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By Salesperson — click to focus</h3>
          {salesperson && (
            <button onClick={() => setSalesperson("")}
              className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
              <X size={12} /> Show everyone
            </button>
          )}
        </div>
        {(data?.by_salesperson ?? []).length === 0 ? (
          <div className="bg-white border border-orange-100 rounded-2xl p-8 text-center text-xs text-gray-400">
            No remarks for this selection.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {(data?.by_salesperson ?? []).map((p) => (
              <PersonCard key={p.salesperson} p={p} active={salesperson === p.salesperson}
                onPick={() => setSalesperson(salesperson === p.salesperson ? "" : p.salesperson)} />
            ))}
          </div>
        )}
      </div>

      {/* Full field log */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            <MessageSquare size={13} /> Field Log
            {theme && <ThemeChip themeKey={theme} />}
          </h3>
          <p className="text-[10px] text-gray-400">{data?.feed.total.toLocaleString("en-IN") ?? 0} remarks</p>
        </div>

        <div className="flex flex-col divide-y divide-gray-50">
          {feed.map((r) => (
            <div key={r.id} className="py-3 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
              <div className="flex items-center gap-2 sm:w-40 shrink-0">
                <span className="text-[10px] text-gray-400 w-12 shrink-0">{shortDate(r.visit_date)}</span>
                <ModeBadge mode={r.contact_mode} />
              </div>
              <div className="sm:w-36 shrink-0 min-w-0">
                <p className="text-xs font-semibold text-gray-700 truncate" title={r.dealership ?? undefined}>{r.dealership ?? "—"}</p>
                <p className="text-[10px] text-gray-400 truncate">
                  {r.salesperson ? firstName(r.salesperson) : "—"}{r.oem && ` · ${r.oem}`}
                </p>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-gray-700 leading-snug">{r.remarks}</p>
                {r.themes.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {r.themes.map((t) => <ThemeChip key={t} themeKey={t} />)}
                  </div>
                )}
              </div>
            </div>
          ))}
          {feed.length === 0 && !loading && (
            <p className="py-8 text-center text-xs text-gray-400">No remarks match these filters.</p>
          )}
        </div>

        {data && (
          <Pagination page={data.feed.page} total={data.feed.total} perPage={data.feed.per_page} onPage={setPage} />
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Targets tab — quarterly target vs achievement
// ══════════════════════════════════════════════════════════════════════════════
/** Units or money out of the same row — the API sends both. */
function pick(r: TgtMetrics, m: Metric) {
  return m === "value"
    ? { tgt: r.tgt_value, ach: r.ach_value, pct: r.ach_pct_value }
    : { tgt: r.tgt_nos, ach: r.ach_nos, pct: r.ach_pct_nos };
}

const fmtNos = (n: number) => Math.round(n).toLocaleString("en-IN");
const fmtBy = (m: Metric) => (m === "value" ? formatCompact : fmtNos);

function achColor(pct: number | null) {
  if (pct == null) return "text-gray-400";
  if (pct >= ON_TRACK_PCT) return "text-green-600";
  if (pct >= 80) return "text-amber-600";
  return "text-red-500";
}

/**
 * Target-vs-achievement bullet rows — the same idiom as Plan vs Actual on the
 * Overview, so coverage and targets read the same way. Grey track = target,
 * fill = achieved (green once it passes the tick), one shared scale per chart.
 */
function TargetBulletChart({ rows, metric }: { rows: TgtGroup[]; metric: Metric }) {
  const fmt = fmtBy(metric);
  const vals = rows.map((r) => pick(r, metric));
  const max = Math.max(1, ...vals.map((v) => Math.max(v.tgt, v.ach)));
  const w = (n: number) => barWidth(n, max);

  if (!rows.length) {
    return <p className="text-xs text-gray-400 py-6 text-center">Nothing to show for these filters</p>;
  }

  return (
    <div className="flex flex-col gap-3.5 pt-1">
      {rows.map((r, i) => {
        const { tgt, ach, pct } = vals[i];
        // Colour says "on track" (90%+); the notch is a separate question —
        // it only exists once the bar has actually run past the target.
        const onTrack = pct != null && pct >= ON_TRACK_PCT;
        const over = ach > tgt && tgt > 0;
        const fill = onTrack ? OVER_COLOR : VISIT_COLOR;
        return (
          <div key={r.key} className="flex items-center gap-3">
            <div className="w-[118px] shrink-0 min-w-0">
              <p className="text-xs font-semibold text-gray-700 truncate" title={r.key}>{r.key}</p>
              {r.region && <p className="text-[9px] text-gray-400 truncate" title={r.region}>{r.region}</p>}
            </div>

            <div className="relative h-5 flex-1 min-w-0">
              {/* The track IS the target — where it ends is the goal, so no
                  separate marker is needed while the bar falls short of it. */}
              {tgt > 0 && (
                <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(tgt), background: TGT_TRACK }} />
              )}
              <div className="absolute inset-y-0 left-0 rounded-md" style={{ width: w(ach), background: fill }} />
              {/* Overshot the target: the bar has swallowed the track, so notch
                  the goal back on top of it. */}
              {over && (
                <div className="absolute inset-y-0 w-[2px]" style={{ left: w(tgt), background: "rgba(255,255,255,0.9)" }} />
              )}
              <span className="absolute top-1/2 -translate-y-1/2 text-[9px] font-bold leading-none whitespace-nowrap"
                style={{ left: `calc(${w(ach)} + 5px)`, color: fill }}>
                {fmt(ach)}
              </span>
            </div>

            <div className="w-[78px] shrink-0 text-right">
              <p className={`text-sm font-black leading-none ${achColor(pct)}`}>
                {pct != null ? `${pct}%` : "—"}
              </p>
              <p className="text-[9px] text-gray-400 mt-0.5">of {fmt(tgt)}</p>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-4 flex-wrap pt-1">
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: OVER_COLOR }} />
          On track — {ON_TRACK_PCT}% of target or better
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: VISIT_COLOR }} />
          Behind — under {ON_TRACK_PCT}%
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: TGT_TRACK }} /> Target
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-[2px] h-3 bg-gray-400 rounded" /> Target mark, once beaten
        </span>
      </div>
    </div>
  );
}

function TargetsTab({ headers }: { headers: Record<string, string> }) {
  const [periods, setPeriods] = useState<TgtPeriod[]>([]);
  const [token, setToken] = useState("");
  const [options, setOptions] = useState<{ oems: string[]; categories: string[]; salespersons: string[]; regions: string[] } | null>(null);
  const [metric, setMetric] = useState<Metric>("value");
  const [oem, setOem] = useState("");
  const [category, setCategory] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [region, setRegion] = useState("");
  const [data, setData] = useState<TgtSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    (async () => {
      const [perRes, optRes] = await Promise.all([
        fetch(`${API_URL}/oe-network/targets/periods`, { headers }),
        fetch(`${API_URL}/oe-network/targets/filter-options`, { headers }),
      ]);
      if (optRes.ok) setOptions(await optRes.json());
      if (perRes.ok) {
        const p: TgtPeriod[] = await perRes.json();
        setPeriods(p);
        if (p.length) setToken(p[0].token);
        else { setEmpty(true); setLoading(false); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    if (!token) return;
    const [fy, q] = token.split("-Q");
    const params = new URLSearchParams({ fy_year: fy, quarter: q });
    if (oem) params.set("oem", oem);
    if (category) params.set("category", category);
    if (salesperson) params.set("salesperson", salesperson);
    if (region) params.set("region", region);
    setLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/targets/summary?${params}`, { headers });
      setData(res.ok ? await res.json() : null);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, oem, category, salesperson, region, refreshKey]);

  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];
  const hasFilters = Boolean(oem || category || salesperson || region);
  const fmt = fmtBy(metric);
  const k = data?.kpis;
  const kv = k ? pick(k, metric) : null;

  // A crore-scaled block can only express ₹0.01 Cr, i.e. ₹1 lakh — worth saying
  // out loud when someone reconciles a total against the sheet to the rupee.
  const croreOems = Object.entries(data?.value_scales ?? {})
    .filter(([, s]) => s === "crores").map(([o]) => o);

  if (empty) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
        No target data yet — register a quarter's target sheet from the <b>Sheets</b> tab.
      </div>
    );
  }

  const monthChart = (data?.by_month ?? []).map((m) => {
    const v = pick(m, metric);
    return { name: `${MONTH_SHORT[m.month - 1]} ${String(m.year).slice(2)}`, Target: v.tgt, Achieved: v.ach };
  });

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <Select value={token} onChange={setToken}
          options={periods.map((p) => ({ value: p.token, label: p.label }))} placeholder="Quarter…" />
        <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
          {(["value", "nos"] as Metric[]).map((m) => (
            <button key={m} onClick={() => setMetric(m)}
              className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
                metric === m ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {m === "value" ? "Value" : "Units"}
            </button>
          ))}
        </div>
        <Select value={oem} onChange={setOem} options={toOpts(options?.oems, "All OEMs")} placeholder="OEM" />
        <Select value={category} onChange={setCategory}
          options={[{ value: "", label: "All products" },
                    ...(options?.categories ?? []).map((c) => ({ value: c, label: c === "SC" ? "Seat Covers" : c === "MAT" ? "Mats" : c }))]}
          placeholder="Product" />
        <Select value={salesperson} onChange={setSalesperson} options={toOpts(options?.salespersons, "All salespersons")} placeholder="Salesperson" />
        <Select value={region} onChange={setRegion} options={toOpts(options?.regions, "All regions")} placeholder="Region" />
        {hasFilters && (
          <button onClick={() => { setOem(""); setCategory(""); setSalesperson(""); setRegion(""); }}
            className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
            <X size={12} /> Clear
          </button>
        )}
        {loading && <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />}
        <button onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 disabled:opacity-50 transition-all"
          title="Re-fetch this view (and its filters) from the server">
          <RefreshCw size={11} /> Refresh
        </button>
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
          <Printer size={12} /> PDF
        </button>
      </FilterBar>

      <div className="print-only">
        <p className="text-sm font-bold text-gray-900">
          Target vs Achievement · {data?.label ?? ""} · {metric === "value" ? "Value" : "Units"}
          {oem && ` · ${oem}`}{category && ` · ${category}`}{salesperson && ` · ${salesperson}`}{region && ` · ${region}`}
        </p>
      </div>

      {!data && !loading ? (
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
          No target data matches these filters.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={metric === "value" ? "Target Value" : "Target Units"}
              value={kv ? fmt(kv.tgt) : "—"} icon={<Target size={18} />} color="#a855f7" bg="#f5f3ff" />
            <StatCard label={metric === "value" ? "Achieved Value" : "Achieved Units"}
              value={kv ? fmt(kv.ach) : "—"} icon={<TrendingUp size={18} />} color={VISIT_COLOR} bg="#fff4ed" />
            <StatCard label="Achievement" value={kv?.pct != null ? `${kv.pct}%` : "—"}
              sub={metric === "value" ? "on value" : "on units"}
              icon={<Percent size={18} />} color={(kv?.pct ?? 0) >= ON_TRACK_PCT ? OVER_COLOR : "#f59e0b"}
              bg={(kv?.pct ?? 0) >= ON_TRACK_PCT ? "#f0fdf4" : "#fffbeb"} />
            <StatCard label="Gap"
              value={kv ? `${kv.ach - kv.tgt >= 0 ? "+" : "−"}${fmt(Math.abs(kv.ach - kv.tgt))}` : "—"}
              sub={kv && kv.ach >= kv.tgt ? "ahead of target" : "short of target"}
              icon={<Building2 size={18} />} color={kv && kv.ach >= kv.tgt ? "#22c55e" : "#ef4444"}
              bg={kv && kv.ach >= kv.tgt ? "#f0fdf4" : "#fef2f2"} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By Salesperson</h3>
              <p className="text-[10px] text-gray-400 mb-1">Ranked by target size</p>
              <TargetBulletChart rows={data?.by_salesperson ?? []} metric={metric} />
            </div>

            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By OEM</h3>
              <p className="text-[10px] text-gray-400 mb-1">TATA's seat covers and mats are clubbed — use the Product filter to split them</p>
              <TargetBulletChart rows={data?.by_oem ?? []} metric={metric} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">Month by Month</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthChart} margin={{ top: 18, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} interval={0} />
                  <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false}
                    tickFormatter={(v: number) => (metric === "value" ? formatCompact(v).replace("₹", "") : fmtNos(v))} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 12, border: "1px solid #fed7aa" }}
                    formatter={(v: number) => fmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Target" fill={TGT_TRACK} radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="Target" position="top" fill="#9ca3af" fontSize={9} fontWeight={700}
                      formatter={(v: number) => fmt(v)} />
                  </Bar>
                  <Bar dataKey="Achieved" fill={VISIT_COLOR} radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="Achieved" position="top" fill="#6b7280" fontSize={9} fontWeight={700}
                      formatter={(v: number) => fmt(v)} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By Region</h3>
              <p className="text-[10px] text-gray-400 mb-1">Regions come from the sheet's own "NAME- REGION" column</p>
              <TargetBulletChart rows={data?.by_region ?? []} metric={metric} />
            </div>
          </div>

          {/* Product split — the detail behind the clubbed OEM view */}
          <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">OEM × Product</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                    <th className="py-2 pr-3">OEM</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3 text-right">Target</th>
                    <th className="py-2 pr-3 text-right">Achieved</th>
                    <th className="py-2 pr-3 text-right">Gap</th>
                    <th className="py-2 text-right">Achievement</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.by_oem_category ?? []).map((r, i) => {
                    const v = pick(r, metric);
                    return (
                      <tr key={i} className="border-b border-gray-50 hover:bg-orange-50/40">
                        <td className="py-2 pr-3 font-semibold text-gray-700">{r.oem}</td>
                        <td className="py-2 pr-3 text-gray-500">
                          {r.key === "SC" ? "Seat Covers" : r.key === "MAT" ? "Mats" : r.key ?? "—"}
                        </td>
                        <td className="py-2 pr-3 text-right text-gray-600">{fmt(v.tgt)}</td>
                        <td className="py-2 pr-3 text-right font-semibold" style={{ color: VISIT_COLOR }}>{fmt(v.ach)}</td>
                        <td className={`py-2 pr-3 text-right font-semibold ${v.ach >= v.tgt ? "text-green-600" : "text-red-500"}`}>
                          {v.ach - v.tgt >= 0 ? "+" : "−"}{fmt(Math.abs(v.ach - v.tgt))}
                        </td>
                        <td className={`py-2 text-right font-bold ${achColor(v.pct)}`}>
                          {v.pct != null ? `${v.pct}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {croreOems.length > 0 && metric === "value" && (
              <p className="text-[10px] text-gray-400 mt-3">
                {croreOems.join(", ")} are entered in the source sheet in crores to two decimals, so their money
                figures carry a ±₹1 lakh rounding per cell. Unit counts are exact.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Sheets tab — registry + sync for all three sheet types
// ══════════════════════════════════════════════════════════════════════════════
interface HistoryItem {
  id: string; sheet_type: string; source_label: string; rows_total: number;
  rows_inserted: number; rows_failed: number; rows_deleted: number;
  status: string; synced_at: string | null;
}

const SHEET_TYPE_LABELS: Record<string, string> = {
  visit_plan: "Visit Plan", log_book: "Log Book", targets: "Targets",
};

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
  const [showAddTgt, setShowAddTgt] = useState(false);
  const [tgtLink, setTgtLink] = useState("");
  // Default to the quarter and FY the current month sits in (Indian FY, Apr–Mar).
  const [tgtQuarter, setTgtQuarter] = useState(`Q${Math.floor(((now.getMonth() + 9) % 12) / 3) + 1}`);
  const [tgtFy, setTgtFy] = useState(String(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1));
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

  const handleAdd = async (sheetType: "visit_plan" | "log_book" | "targets") => {
    const link = sheetType === "visit_plan" ? planLink : sheetType === "targets" ? tgtLink : logLink;
    if (!link.trim()) return;
    setAdding(true);
    try {
      const body: Record<string, unknown> = { sheet_url_or_id: link.trim(), sheet_type: sheetType };
      if (sheetType === "visit_plan") {
        body.month = Number(planMonth);
        body.year = Number(planYear);
      } else if (sheetType === "targets") {
        body.quarter = tgtQuarter;
        body.year = Number(tgtFy);   // FY start year
      }
      const res = await fetch(`${API_URL}/oe-network/sheet-sources`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? "Could not add sheet");
      toast.success("Sheet registered", data.label);
      if (sheetType === "visit_plan") { setShowAddPlan(false); setPlanLink(""); }
      else if (sheetType === "targets") { setShowAddTgt(false); setTgtLink(""); }
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
  const tgtSources = sources.filter((s) => s.sheet_type === "targets");

  const monthOptions = MONTH_FULL.map((m, i) => ({ value: String(i + 1), label: m }));
  const yearOptions = Array.from({ length: 4 }, (_, i) => now.getFullYear() - 2 + i)
    .map((y) => ({ value: String(y), label: String(y) }));
  const quarterOptions = [
    { value: "Q1", label: "Q1 — AMJ" }, { value: "Q2", label: "Q2 — JAS" },
    { value: "Q3", label: "Q3 — OND" }, { value: "Q4", label: "Q4 — JFM" },
  ];
  const fyOptions = Array.from({ length: 4 }, (_, i) => now.getFullYear() - 2 + i)
    .map((y) => ({ value: String(y), label: `FY${y % 100}-${(y + 1) % 100}` }));

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

      {/* Quarterly targets */}
      <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">Quarterly Targets</h3>
            <p className="text-[10px] text-gray-400">
              One sheet per quarter — OEM blocks are found by their headers, and money in crores is converted automatically
            </p>
          </div>
          <button onClick={() => setShowAddTgt(!showAddTgt)}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
            <Plus size={13} /> Add Quarter
          </button>
        </div>
        <AnimatePresence>
          {showAddTgt && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="bg-orange-50/50 rounded-xl p-3 my-2 flex flex-col gap-2">
                <input value={tgtLink} onChange={(e) => setTgtLink(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/…" className={inputClass} />
                <div className="flex gap-2">
                  <Select value={tgtQuarter} onChange={setTgtQuarter} options={quarterOptions} className="flex-1" />
                  <Select value={tgtFy} onChange={setTgtFy} options={fyOptions} />
                  <button onClick={() => handleAdd("targets")} disabled={adding || !tgtLink.trim()}
                    className="text-xs font-semibold text-white px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 transition-all">
                    {adding ? "Adding…" : "Add & Sync"}
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {tgtSources.length
          ? tgtSources.map(sourceRow)
          : <p className="text-xs text-gray-400 py-3">No target sheets registered yet.</p>}
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
                  <td className="py-2 pr-3 text-gray-500">{SHEET_TYPE_LABELS[h.sheet_type] ?? h.sheet_type}</td>
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
// In-Depth is built but parked — add { id: "indepth", label: "In-Depth" } back
// here to show the tab again. Raw plan/log row listings were dropped on purpose:
// this page is for visualisation, and a flat filterable table is what the source
// spreadsheet already does better.
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Plan vs Actual" },
  { id: "activity", label: "Field Activity" },
  { id: "targets", label: "Targets" },
  { id: "sheets", label: "Sheets" },
];

const TAB_SUBTITLES: Record<TabId, string> = {
  overview: "Plan coverage and field activity",
  indepth: "Dealer network health, plan adherence and attach rates",
  activity: "What the team is up to — remark themes, per-person rollup and the field log",
  targets: "Quarterly target vs achievement by salesperson and OEM",
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
      {activeTab === "activity" && <FieldActivityTab headers={headers} />}
      {activeTab === "targets" && <TargetsTab headers={headers} />}
      {activeTab === "sheets" && <SheetsTab headers={headers} />}
    </div>
  );
}
