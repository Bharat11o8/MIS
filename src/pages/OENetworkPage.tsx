import { Fragment, useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CarFront, Phone, Footprints, Building2, Users, RefreshCw, Plus, Trash2,
  Search, History, CheckCircle2, XCircle, Clock, Target, X,
  Printer, ChevronRight, Percent, TrendingUp, MessageSquare, Tag,
  Package, Store,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, LabelList, ComposedChart, ReferenceLine,
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
// A grey that is actually VISIBLE as a filled series. TGT_TRACK is a background
// track and is nearly invisible when used as a bar on a white card next to a
// #f3f4f6 grid, so anything carrying data uses this instead.
const NEUTRAL_BAR = "#c2c8d0";
// Chart labels must never inherit their series colour — recharts draws legend
// and tooltip text in the series colour by default, which makes any pale series
// unreadable. Text stays dark; the colour swatch does the identifying.
const CHART_LABEL = "#4b5563";
const OVER_COLOR = "#22c55e";
// Targets that belong to no salesperson (MSIL/TATA accessories) get a colour of
// their own on the bullet charts — they sit in the same total as the people bars
// but are not a person, and must never be read as one.
const UNOWNED_COLOR = "#8b5cf6";
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
  /** Targets nobody owns — MSIL and TATA book accessories as one line inside
   *  their seat-cover block. They're in the KPIs but can't be in the
   *  salesperson or region charts, so those charts show this row explicitly
   *  rather than quietly adding up to less than the headline. */
  unattributed: (TgtMetrics & { oems: string[] }) | null;
  value_scales: Record<string, string>;
}
interface TgtPeriod { fy_year: number; quarter: number; token: string; label: string }

// ── Field Activity (remarks) ───────────────────────────────────────────────────
interface RemarkTheme { key: string; label: string; count: number }
/** One note = one remark category the rep filled in. Since 29 Jul 2026 the form
 *  makes them tick categories and write separately in each, so a single visit
 *  routinely carries two or three of these. */
interface RemarkNote { category: string; label: string; text: string; themes: string[] }
/** A category with its own nested theme breakdown — the primary axis of this tab. */
interface RemarkCategory { key: string; label: string; count: number; themes: RemarkTheme[] }
interface RemarkLatest {
  visit_date: string; dealership: string | null; oem: string | null;
  contact_mode: string | null; notes: RemarkNote[]; themes: string[];
}
interface PersonRollup {
  salesperson: string; remarks: number; visits: number; calls: number; dealers: number;
  top_themes: RemarkTheme[]; categories: { key: string; label: string; count: number }[];
  latest: RemarkLatest | null;
}
interface RemarkFeedRow {
  id: string; visit_date: string; salesperson: string | null; contact_mode: string | null;
  oem: string | null; dealership: string | null; city: string | null; state: string | null;
  notes: RemarkNote[]; themes: string[];
}
interface RemarksData {
  kpis: { remarks: number; notes: number; dealers: number; salespersons: number; visits: number; calls: number };
  categories: RemarkCategory[];
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

// The four categories the rep picks on the form, plus `general` for the
// pre-29-Jul-2026 rows that only ever had one unlabelled blob. Keys mirror
// REMARK_CATEGORIES in routers/oe_network.py.
const CATEGORY_META: Record<string, { color: string; bg: string }> = {
  sales: { color: "#16a34a", bg: "#f0fdf4" },
  product_feedback: { color: "#3b82f6", bg: "#eff6ff" },
  replacement: { color: "#d97706", bg: "#fffbeb" },
  others: { color: "#a855f7", bg: "#f5f3ff" },
  general: { color: "#6b7280", bg: "#f4f4f5" },
};
const categoryMeta = (key: string) => CATEGORY_META[key] ?? { color: "#6b7280", bg: "#f9fafb" };

type TabId = "overview" | "indepth" | "dealers" | "activity" | "targets" | "sheets";
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

/**
 * Period selection, shared by every tab so the behaviour can't drift between
 * them. The three preset modes send a month range; "custom" sends exact dates.
 *
 * What the two produce is genuinely different, not just finer:
 *   • from_date/to_date cut the LOG BOOK to the day, because a visit has a date.
 *   • Visit plans and dealer sales have no day on them — they are one row per
 *     month — so on those the range widens to the months it touches. The
 *     endpoints that compare logs against plans widen BOTH sides rather than
 *     cutting one finer than the other, which would deflate every coverage
 *     percentage. Each tab says which happened.
 */
type PeriodChoice = PeriodMode | "custom" | "all";
interface DateRange { from: string; to: string }
const PERIOD_CHOICES: PeriodChoice[] = ["monthly", "quarterly", "yearly", "custom", "all"];
const PERIOD_LABELS: Record<PeriodChoice, string> = {
  monthly: "monthly", quarterly: "quarterly", yearly: "yearly",
  custom: "custom", all: "all time",
};

function PeriodControls({ mode, onMode, token, onToken, options, range, onRange }: {
  mode: PeriodChoice; onMode: (m: PeriodChoice) => void;
  token: string; onToken: (t: string) => void;
  options: { value: string; label: string }[];
  range: DateRange; onRange: (r: DateRange) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
        {PERIOD_CHOICES.map((m) => (
          <button key={m} onClick={() => onMode(m)}
            className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg capitalize transition-all ${
              mode === m ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}>
            {PERIOD_LABELS[m]}
          </button>
        ))}
      </div>
      {mode === "all" ? null : mode === "custom" ? (
        <div className="flex items-center gap-1">
          <input type="date" value={range.from} max={range.to || undefined} className={inputClass}
            onChange={(e) => onRange({ ...range, from: e.target.value })} />
          <span className="text-[11px] text-gray-400">to</span>
          <input type="date" value={range.to} min={range.from || undefined} className={inputClass}
            onChange={(e) => onRange({ ...range, to: e.target.value })} />
        </div>
      ) : (
        <Select value={token} onChange={onToken} options={options} placeholder="Period…" />
      )}
    </>
  );
}

/** Query params for a period selection, or null when it isn't usable yet —
 *  a half-entered custom range must not fire a request for "everything". */
function periodParams(mode: PeriodChoice, token: string, range: DateRange):
  Record<string, string> | null {
  if (mode === "all") return {};        // no period params at all = every month
  if (mode === "custom") {
    if (!range.from || !range.to) return null;
    return { from_date: range.from, to_date: range.to };
  }
  if (!token) return null;
  const [fromYm, toYm] = periodRange(mode, token);
  return { from_ym: fromYm, to_ym: toYm };
}

/** Period option lists derived from the months that actually hold data, so
 *  future months make new options appear on their own. */
function buildPeriodOptions(months: Period[]): Record<PeriodMode, { value: string; label: string }[]> {
  const sorted = [...months].sort((a, b) => b.year - a.year || b.month - a.month);
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
  const [periodMode, setPeriodMode] = useState<PeriodChoice>("monthly");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
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
    const pp = periodParams(periodMode, selected, range);
    if (!pp) return;
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
    const pvaParams = new URLSearchParams(entity);
    for (const [k, v] of Object.entries(pp)) {
      periodScoped.set(k, v);
      pvaParams.set(k, v);
    }

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
  }, [selected, periodMode, range, salesperson, oem, state, city, mode, qDebounced, refresh]);

  const hasFilters = Boolean(salesperson || oem || state || city || mode || q);
  const clearFilters = () => {
    setSalesperson(""); setOem(""); setState(""); setCity(""); setMode(""); setQ("");
  };

  // Union of months that exist in either sheet, then the quarter/FY option
  // lists derived from them — so future data makes new options appear on its own.
  const optionsByMode = useMemo<Record<PeriodMode, { value: string; label: string }[]>>(() => {
    if (!periods) return { monthly: [], quarterly: [], yearly: [] };
    // Either sheet can carry a month the other doesn't, so the union is what
    // the picker should offer.
    const months = new Map<string, Period>();
    [...periods.plan_months, ...periods.log_months].forEach((p) => months.set(monthToken(p), p));
    return buildPeriodOptions([...months.values()]);
  }, [periods]);

  const periodOptions =
    periodMode === "custom" || periodMode === "all" ? [] : optionsByMode[periodMode];

  // Switching views lands on the latest period of that view, never an empty selection.
  const switchMode = (m: PeriodChoice) => {
    setPeriodMode(m);
    if (m === "custom" || m === "all") return;   // neither needs a token
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
        <PeriodControls
          mode={periodMode} onMode={switchMode}
          token={selected} onToken={setSelected} options={periodOptions}
          range={range} onRange={setRange}
        />
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

      {/* Visit plans are written per month with no day on them, so coverage can
          only be measured month-for-month. Saying so beats showing a percentage
          that looks like it honours the dates and doesn't. */}
      {periodMode === "custom" && range.from && range.to && (
        <p className="no-print text-[11px] text-gray-400 -mt-2">
          Plans are set monthly, so this compares whole months
          ({shortDate(range.from)} → {shortDate(range.to)} covers{" "}
          {MONTH_SHORT[Number(range.from.slice(5, 7)) - 1]}–{MONTH_SHORT[Number(range.to.slice(5, 7)) - 1]}).
          Field activity below is counted to the exact day.
        </p>
      )}

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

/** The category the rep themselves chose, as a chip. */
function CategoryChip({ categoryKey, label }: { categoryKey: string; label: string }) {
  const m = categoryMeta(categoryKey);
  return (
    <span className="inline-flex items-center text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
      style={{ color: m.color, background: m.bg }}>
      {label}
    </span>
  );
}

/** The primary filter surface: one column per remark category, with the keyword
 *  themes nested underneath it. The rep hand-classifies every note on the form,
 *  so the category is the trustworthy axis and the themes only add detail
 *  *within* it ("of the 161 Sales notes, 67 are chasing an order").
 *  Clicking a category scopes the feed; clicking a nested theme scopes to that
 *  theme inside that category. */
function CategoryPanel({ categories, activeCategory, activeTheme, onPick }: {
  categories: RemarkCategory[];
  activeCategory: string; activeTheme: string;
  onPick: (category: string, theme: string) => void;
}) {
  if (!categories.length) return <p className="text-xs text-gray-400 py-2">No remarks in this slice.</p>;
  const total = categories.reduce((s, c) => s + c.count, 0);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
      {categories.map((c) => {
        const m = categoryMeta(c.key);
        const on = activeCategory === c.key;
        const share = total ? Math.round((c.count / total) * 100) : 0;
        return (
          <div key={c.key} className="rounded-xl border transition-all"
            style={{ borderColor: on ? m.color : "#f1f0ee", background: on ? m.bg : "#fff" }}>
            <button onClick={() => onPick(on && !activeTheme ? "" : c.key, "")}
              className="w-full text-left px-3 pt-2.5 pb-2"
              title={`${c.count} note${c.count === 1 ? "" : "s"} — click to ${on && !activeTheme ? "clear" : "filter"}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-bold" style={{ color: m.color }}>{c.label}</span>
                <span className="text-[10px] text-gray-400">{share}%</span>
              </div>
              <p className="text-xl font-black leading-tight" style={{ color: m.color }}>{c.count}</p>
              <div className="h-1 rounded-full mt-1.5 overflow-hidden" style={{ background: "#f1f0ee" }}>
                <div className="h-full rounded-full" style={{ width: `${share}%`, background: m.color }} />
              </div>
            </button>
            {c.themes.length > 0 && (
              <div className="flex flex-col px-2 pb-2 pt-0.5 gap-0.5">
                {c.themes.slice(0, 5).map((t) => {
                  const tm = themeMeta(t.key);
                  const tOn = on && activeTheme === t.key;
                  return (
                    <button key={t.key} onClick={() => onPick(c.key, tOn ? "" : t.key)}
                      className="flex items-center justify-between gap-2 px-1.5 py-0.5 rounded-md hover:bg-white/70 transition-colors"
                      style={tOn ? { background: tm.bg } : undefined}
                      title={`${t.count} ${c.label} note${t.count === 1 ? "" : "s"} tagged ${tm.label}`}>
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="w-1 h-1 rounded-full shrink-0" style={{ background: tm.color }} />
                        <span className="text-[10px] truncate" style={{ color: tOn ? tm.color : "#6b7280" }}>{tm.label}</span>
                      </span>
                      <span className="text-[10px] font-bold shrink-0" style={{ color: tOn ? tm.color : "#9ca3af" }}>{t.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
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

      {/* Category mix first — it's what the rep actually declared they were
          doing; the themes below are the inferred detail. */}
      {p.categories.length > 0 && (
        <div className="flex h-1.5 rounded-full overflow-hidden mt-3" title={p.categories.map((c) => `${c.label}: ${c.count}`).join(" · ")}>
          {p.categories.map((c) => (
            <div key={c.key} style={{
              flexGrow: c.count,
              background: categoryMeta(c.key).color,
            }} />
          ))}
        </div>
      )}
      {p.categories.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {p.categories.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-md"
              style={{ color: categoryMeta(c.key).color, background: categoryMeta(c.key).bg }}>
              {c.label}<span className="opacity-70">{c.count}</span>
            </span>
          ))}
        </div>
      )}
      {p.top_themes.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.top_themes.map((t) => <ThemeChip key={t.key} themeKey={t.key} count={t.count} />)}
        </div>
      )}
    </button>
  );
}

function FieldActivityTab({ headers }: { headers: Record<string, string> }) {
  const [logMonths, setLogMonths] = useState<Period[]>([]);
  const [periodMode, setPeriodMode] = useState<PeriodChoice>("monthly");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [selected, setSelected] = useState("");
  const [options, setOptions] = useState<{ salespersons: string[]; oems: string[]; states: string[]; cities: string[]; contact_modes: string[] } | null>(null);

  const [salesperson, setSalesperson] = useState("");
  const [oem, setOem] = useState("");
  const [state, setState] = useState("");
  const [city, setCity] = useState("");
  const [mode, setMode] = useState("");
  const [category, setCategory] = useState("");
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
  const optionsByMode = useMemo(() => buildPeriodOptions(logMonths), [logMonths]);

  const periodOptions =
    periodMode === "custom" || periodMode === "all" ? [] : optionsByMode[periodMode];
  useEffect(() => {
    // Land on the latest available period once the lists are built.
    if (!selected && optionsByMode.monthly.length) setSelected(optionsByMode.monthly[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsByMode]);

  const switchMode = (m: PeriodChoice) => {
    setPeriodMode(m);
    if (m === "custom" || m === "all") return;   // neither needs a token
    const first = optionsByMode[m][0];
    if (first) setSelected(first.value);
  };

  // Any change to the slice resets to the first page of the feed.
  useEffect(() => { setPage(1); }, [selected, periodMode, range, salesperson, oem, state, city, mode, category, theme, qDeb]);

  useEffect(() => {
    const pp = periodParams(periodMode, selected, range);
    if (!pp) return;
    const params = new URLSearchParams({ ...pp, page: String(page), per_page: "30" });
    if (salesperson) params.set("salesperson", salesperson);
    if (oem) params.set("oem", oem);
    if (state) params.set("state", state);
    if (city) params.set("city", city);
    if (mode) params.set("contact_mode", mode);
    if (category) params.set("category", category);
    if (theme) params.set("theme", theme);
    if (qDeb) params.set("q", qDeb);
    setLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/remarks?${params}`, { headers });
      if (res.ok) setData(await res.json());
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, periodMode, range, salesperson, oem, state, city, mode, category, theme, qDeb, page, refreshKey]);

  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];
  const hasFilters = Boolean(salesperson || oem || state || city || mode || category || theme || q);
  const clearFilters = () => {
    setSalesperson(""); setOem(""); setState(""); setCity(""); setMode("");
    setCategory(""); setTheme(""); setQ("");
  };
  const categoryLabel = (key: string) =>
    data?.categories.find((c) => c.key === key)?.label ?? key;

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
        <PeriodControls
          mode={periodMode} onMode={switchMode}
          token={selected} onToken={setSelected} options={periodOptions}
          range={range} onRange={setRange}
        />
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
          {salesperson && ` · ${salesperson}`}{oem && ` · ${oem}`}
          {category && ` · ${categoryLabel(category)}`}{theme && ` · ${themeMeta(theme).label}`}
          {qDeb && ` · “${qDeb}”`}
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Remarks" value={data?.kpis.remarks ?? 0}
          sub={data && data.kpis.notes > data.kpis.remarks
            ? `${data.kpis.notes.toLocaleString("en-IN")} notes across categories`
            : "field notes logged"}
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
              Grouped by the category the rep chose on the form, then auto-tagged within it. Click a category — or a
              tag inside one — to filter the log below.
            </p>
          </div>
          {(category || theme) && (
            <button onClick={() => { setCategory(""); setTheme(""); }}
              className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
              <X size={12} /> Clear
              {category && ` ${categoryLabel(category)}`}{theme && ` · ${themeMeta(theme).label}`}
            </button>
          )}
        </div>
        <CategoryPanel categories={data?.categories ?? []} activeCategory={category} activeTheme={theme}
          onPick={(c, t) => { setCategory(c); setTheme(t); }} />
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
            {category && <CategoryChip categoryKey={category} label={categoryLabel(category)} />}
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
              {/* One block per category the rep wrote in. When a category is
                  being filtered on, the others stay visible but dimmed — the
                  matching note is the point, the rest is context for it. */}
              <div className="flex-1 min-w-0 flex flex-col gap-2">
                {r.notes.map((n, i) => {
                  const dim = Boolean(category) && n.category !== category;
                  return (
                    <div key={`${n.category}-${i}`} className={dim ? "opacity-40" : undefined}>
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 mt-px"><CategoryChip categoryKey={n.category} label={n.label} /></span>
                        <p className="text-[13px] text-gray-700 leading-snug min-w-0">{n.text}</p>
                      </div>
                      {n.themes.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1 ml-1">
                          {n.themes.map((t) => <ThemeChip key={t} themeKey={t} />)}
                        </div>
                      )}
                    </div>
                  );
                })}
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

/** Product codes as the target sheet titles them. Anything unrecognised shows
 *  as typed rather than being hidden behind a guess. */
const CATEGORY_LABELS: Record<string, string> = {
  SC: "Seat Covers", MAT: "Mats", ACC: "Accessories",
};
const categoryLabel = (c: string | null | undefined) =>
  (c && (CATEGORY_LABELS[c] ?? c)) || "—";

function achColor(pct: number | null) {
  if (pct == null) return "text-gray-400";
  if (pct >= ON_TRACK_PCT) return "text-green-600";
  if (pct >= 80) return "text-amber-600";
  return "text-red-500";
}

/** One bullet row, whether or not a person owns it. */
interface BulletRow { key: string; sub?: string | null; m: TgtMetrics; unowned?: boolean }

/**
 * Target-vs-achievement bullet rows — the same idiom as Plan vs Actual on the
 * Overview, so coverage and targets read the same way. Grey track = target,
 * fill = achieved (green once it passes the tick), one shared scale per chart.
 *
 * `unattributed` is for the charts that group by a person or their region: the
 * MSIL/TATA accessories lines belong to no salesperson, so they cannot be a bar
 * among the others, but leaving them out entirely would make the chart add up to
 * less than the KPI above it with nothing on screen to explain the difference.
 * They get their own row below the rule instead, in their own colour.
 */
function TargetBulletChart({
  rows, metric, unattributed,
}: {
  rows: TgtGroup[];
  metric: Metric;
  unattributed?: (TgtMetrics & { oems: string[] }) | null;
}) {
  const fmt = fmtBy(metric);
  const all: BulletRow[] = [
    ...rows.map((r) => ({ key: r.key, sub: r.region, m: r })),
    ...(unattributed
      ? [{
          key: "Accessories",
          sub: `${unattributed.oems.join(", ")} · no salesperson`,
          m: unattributed,
          unowned: true,
        }]
      : []),
  ];
  // One scale across every row including the unowned one, so its bar is
  // honestly comparable to the people above it.
  const vals = all.map((r) => pick(r.m, metric));
  const max = Math.max(1, ...vals.map((v) => Math.max(v.tgt, v.ach)));
  const w = (n: number) => barWidth(n, max);

  if (!all.length) {
    return <p className="text-xs text-gray-400 py-6 text-center">Nothing to show for these filters</p>;
  }

  return (
    <div className="flex flex-col gap-3.5 pt-1">
      {all.map((r, i) => {
        const { tgt, ach, pct } = vals[i];
        // Colour says "on track" (90%+); the notch is a separate question —
        // it only exists once the bar has actually run past the target.
        const onTrack = pct != null && pct >= ON_TRACK_PCT;
        const over = ach > tgt && tgt > 0;
        const fill = r.unowned ? UNOWNED_COLOR : onTrack ? OVER_COLOR : VISIT_COLOR;
        return (
          <div key={r.key}
            className={`flex items-center gap-3${r.unowned ? " pt-3 mt-0.5 border-t border-dashed border-gray-200" : ""}`}>
            <div className="w-[118px] shrink-0 min-w-0">
              <p className={`text-xs font-semibold truncate ${r.unowned ? "italic text-violet-600" : "text-gray-700"}`}
                title={r.key}>{r.key}</p>
              {r.sub && <p className="text-[9px] text-gray-400 truncate" title={r.sub}>{r.sub}</p>}
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
        {unattributed && (
          <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: UNOWNED_COLOR }} />
            Accessories — an OEM product line, not anybody's number
          </span>
        )}
      </div>
    </div>
  );
}

function TargetsTab({ headers }: { headers: Record<string, string> }) {
  const [periods, setPeriods] = useState<TgtPeriod[]>([]);
  const [token, setToken] = useState("");
  const [useRange, setUseRange] = useState(false);
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
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
    // Targets are stored per month inside their quarter, so a date range picks
    // whole months. A range covering Apr–Jun reads identically to Q1.
    let params: URLSearchParams;
    if (useRange) {
      if (!range.from || !range.to) return;
      params = new URLSearchParams({ from_date: range.from, to_date: range.to });
    } else {
      if (!token) return;
      const [fy, q] = token.split("-Q");
      params = new URLSearchParams({ fy_year: fy, quarter: q });
    }
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
  }, [token, useRange, range, oem, category, salesperson, region, refreshKey]);

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

  // A date range can easily land outside every quarter we hold a target sheet
  // for. That is a real answer, not a failure, so name it rather than leaving
  // the tab blank.
  if (!loading && !data && useRange && range.from && range.to) {
    return (
      <div className="flex flex-col gap-5">
        <FilterBar>
          <button onClick={() => setUseRange(false)}
            className="text-[11px] font-semibold text-orange-500 hover:text-orange-600 px-2">
            ← Back to quarters
          </button>
        </FilterBar>
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
          No targets cover {shortDate(range.from)} – {shortDate(range.to)}.
          Targets are published per quarter, and only{" "}
          <b className="text-gray-600">{periods.map((p) => p.label).join(", ") || "—"}</b>{" "}
          {periods.length === 1 ? "has" : "have"} been registered.
        </div>
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
        {/* Targets are published per quarter, so that stays the default way in;
            the range is for reading part of one, or across two. */}
        <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
          {([false, true] as const).map((r) => (
            <button key={String(r)} onClick={() => setUseRange(r)}
              className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all ${
                useRange === r ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}>
              {r ? "custom" : "quarterly"}
            </button>
          ))}
        </div>
        {useRange ? (
          <div className="flex items-center gap-1">
            <input type="date" value={range.from} max={range.to || undefined} className={inputClass}
              onChange={(e) => setRange((v) => ({ ...v, from: e.target.value }))} />
            <span className="text-[11px] text-gray-400">to</span>
            <input type="date" value={range.to} min={range.from || undefined} className={inputClass}
              onChange={(e) => setRange((v) => ({ ...v, to: e.target.value }))} />
          </div>
        ) : (
          <Select value={token} onChange={setToken}
            options={periods.map((p) => ({ value: p.token, label: p.label }))} placeholder="Quarter…" />
        )}
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
                    ...(options?.categories ?? []).map((c) => ({ value: c, label: categoryLabel(c) }))]}
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
              <p className="text-[10px] text-gray-400 mb-1">
                Ranked by target size
                {data?.unattributed && " · the last row is not a person — see the note below"}
              </p>
              <TargetBulletChart rows={data?.by_salesperson ?? []} metric={metric}
                unattributed={data?.unattributed} />
            </div>

            <div className="print-avoid-break bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500">By OEM</h3>
              <p className="text-[10px] text-gray-400 mb-1">All of an OEM's products clubbed together — use the Product filter to split seat covers, mats and accessories</p>
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
                    itemStyle={{ color: CHART_LABEL }} formatter={(v: number) => fmt(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }}
                    formatter={(value: string) => <span style={{ color: CHART_LABEL }}>{value}</span>} />
                  <Bar dataKey="Target" fill={NEUTRAL_BAR} radius={[4, 4, 0, 0]}>
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
              <p className="text-[10px] text-gray-400 mb-1">
                Regions come from the sheet's own "NAME- REGION" column, so an OEM that
                writes a territory differently gets its own row
              </p>
              <TargetBulletChart rows={data?.by_region ?? []} metric={metric}
                unattributed={data?.unattributed} />
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
                        <td className="py-2 pr-3 text-gray-500">{categoryLabel(r.key)}</td>
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
            {data?.unattributed && (
              <p className="text-[10px] text-gray-400 mt-3">
                <b className="text-violet-600">Accessories</b> for {data.unattributed.oems.join(" and ")} are
                agreed as one number for the OEM and are not split between salespeople, so they carry no name
                and no region. They are counted in the KPIs, in <i>By OEM</i> and in <i>Month by Month</i>; in{" "}
                <i>By Salesperson</i> and <i>By Region</i> they sit on their own row below the rule, which is
                why those bars add up to less than the headline on their own.
                {(data.by_oem_category ?? []).some((r) => r.key === "ACC" && !data.unattributed?.oems.includes(r.oem))
                  && " Other OEMs do split accessories by salesperson, and those rows behave like any other."}
              </p>
            )}
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
// ── Dealers tab ───────────────────────────────────────────────────────────────
// The dealer-centric half of the module. Every other tab is keyed on the rep;
// this one is keyed on the dealership, which is how the OE team's own file is
// keyed and how leadership asks its questions.

interface PerfDealer {
  id: string; oem: string; name: string; city: string; state: string;
  salesperson: string | null; codes: string | null;
  car_sales: number; our_sales: number; penetration: number | null;
  contacts: number; visits: number; calls: number; last_contact: string | null;
  target: number | null; achievement: number | null; has_sales: boolean;
}
interface DealerSpRow {
  salesperson: string; assigned: number; contacted: number; coverage: number | null;
  car_sales: number; our_sales: number; penetration: number | null;
  visits: number; calls: number; target: number; achievement: number;
}
interface DealerMonth {
  month: string; car_sales: number | null; our_sales: number | null;
  penetration: number | null; visits: number; calls: number;
}
interface DealerQuarter {
  quarter: string; fy_year: number; label: string; period_start: string; period_end: string;
  target: number | null; achievement: number | null;
  car_sales: number | null; our_sales: number | null; penetration: number | null;
}
interface ContactBucket {
  bucket: string; dealer_months: number; car_sales: number; our_sales: number;
  penetration: number | null;
}
interface DealerPerf {
  period: { month_from: string | null; month_to: string | null; date_from: string | null; date_to: string | null };
  kpis: {
    dealers: number; contacted: number; coverage: number | null;
    car_sales: number; our_sales: number; penetration: number | null;
    /** Whole-OEM penetration for the period — the yardstick Opportunity is
     *  measured against. Unaffected by the rep/state filters, unlike
     *  `penetration` above, which is this view's own figure. */
    benchmark: number | null;
    visits: number; calls: number; target: number; achievement: number;
  };
  dealers: PerfDealer[];
  by_salesperson: DealerSpRow[];
  by_month: DealerMonth[];
  by_quarter: DealerQuarter[];
  contact_effect: { months: number; buckets: ContactBucket[] };
}
interface DealerNote { category: string; label: string; text: string; themes: string[] }
interface PerfContact {
  id: string; visit_date: string | null; salesperson: string; contact_mode: string;
  channel: string | null; contact_person: string | null; designation: string | null;
  car_sales: number | null; seat_cover_sales: number | null; mats_sales: number | null;
  notes: DealerNote[];
}
interface DealerDetail {
  dealer: PerfDealer & { source: string };
  totals: { car_sales: number; our_sales: number; penetration: number | null; visits: number; calls: number };
  by_month: DealerMonth[];
  targets: { quarter: string; fy_year: number; label: string; target: number | null; achievement: number | null }[];
  last_field_note: PerfContact | null;
  history: PerfContact[];
}

const n0 = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-IN");
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);

/**
 * A plain-language note under a panel heading saying what the thing means.
 *
 * Not optional decoration: "Bottom 20 by Opportunity" reads like a list of bad
 * dealers when it is in fact a list of our best ones, and nobody should have to
 * reverse-engineer a sign convention from the numbers to find that out.
 */
function Explain({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 mb-3 rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
      <p className="text-[11px] leading-relaxed text-gray-500">{children}</p>
    </div>
  );
}

/** Rankings a dealer list can be read by. `gap` is the one that matters most:
 *  units we would gain at this dealer if it merely performed like the network
 *  average — it puts a big dealer at 2% penetration above a small one at 0%.
 *
 *  Each ranking says what BOTH of its ends mean, because for a signed metric
 *  the bottom is not "the worst". The bottom of Opportunity is the dealers
 *  furthest AHEAD of average — the ones to protect and learn from, not the
 *  ones to worry about, and labelling that "bottom 20" without saying so
 *  inverts the meaning.
 *
 *  `floor` marks the rankings whose bottom end is meaningless without a volume
 *  cut-off: sorted by a ratio, the worst dealers are simply the smallest ones.
 *  Opportunity needs no floor — it already scales with volume, so a small
 *  dealer cannot produce a big gap in either direction. */
type RankMetric = "our_sales" | "penetration" | "gap" | "car_sales";
const RANK_META: Record<RankMetric, {
  label: string; what: string; top: string; bottom: string; floor: boolean;
}> = {
  gap: {
    label: "Opportunity",
    what: "how many units this dealer is short of what the OEM average would predict — "
      + "their car sales × the average penetration, minus what we actually sell them",
    top: "the dealers furthest BEHIND the average. This is the list to work: "
      + "the units are there and we aren't getting them.",
    bottom: "the dealers furthest AHEAD of the average — where we're already "
      + "outperforming. Not a problem list: these are the ones to protect, and "
      + "to copy. Their Opp. figure is negative because they beat the benchmark.",
    floor: false,
  },
  our_sales: {
    label: "Our units",
    what: "the number of our units the dealer bought in this period",
    top: "our biggest dealers by volume",
    bottom: "the dealers buying least from us",
    floor: true,
  },
  penetration: {
    label: "Penetration",
    what: "our units ÷ the cars that dealer retailed — our share of their business",
    top: "where we take the biggest share of a dealer's cars",
    bottom: "where we take the smallest share",
    floor: true,
  },
  car_sales: {
    label: "Their volume",
    what: "how many cars the dealer retailed, whether or not any were ours",
    top: "the biggest dealerships in the network",
    bottom: "the smallest dealerships",
    floor: false,
  },
};

const rankValue = (d: PerfDealer, m: RankMetric, avgPene: number): number => {
  if (m === "gap") return d.car_sales * (avgPene / 100) - d.our_sales;
  if (m === "penetration") return d.penetration ?? 0;
  return m === "our_sales" ? d.our_sales : d.car_sales;
};

/**
 * Volume vs penetration, one dot per dealer.
 *
 * The single view that says WHERE the money is: bottom-right is a dealer who
 * sells a lot of cars and almost none of ours. A ranked list can only answer
 * one question at a time; this answers "big or small" and "in or out" at once,
 * and the eye finds the outliers without reading a single number.
 *
 * The x axis is square-rooted because dealer volume is very long-tailed — a
 * linear axis buries three quarters of the network in the left tenth of the
 * chart. Ticks are drawn at real car-sales values so the compression is
 * visible rather than silently distorting the picture.
 */
function DealerMap({ dealers, avgPene, onPick }: {
  dealers: PerfDealer[]; avgPene: number; onPick: (d: PerfDealer) => void;
}) {
  const [hover, setHover] = useState<PerfDealer | null>(null);
  const pts = dealers.filter((d) => d.has_sales && d.car_sales > 0);
  if (!pts.length) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
        No dealer sales data for this selection — the OE dealer file only covers MSIL so far.
      </div>
    );
  }

  const W = 900, H = 380, PL = 52, PR = 18, PT = 16, PB = 40;
  const maxCars = Math.max(...pts.map((d) => d.car_sales));
  // Cap the y axis at a sane ceiling so a single 90% dealer can't flatten
  // everyone else into the baseline.
  const peneCap = Math.min(100, Math.max(20, ...pts.map((d) => d.penetration ?? 0)) * 1.05);
  const maxOurs = Math.max(...pts.map((d) => d.our_sales), 1);

  const x = (v: number) => PL + (Math.sqrt(v) / Math.sqrt(maxCars)) * (W - PL - PR);
  const y = (v: number) => H - PB - (Math.min(v, peneCap) / peneCap) * (H - PT - PB);
  const r = (v: number) => 3 + Math.sqrt(v / maxOurs) * 11;

  const xTicks = [0, 0.05, 0.2, 0.45, 1].map((f) => Math.round(maxCars * f));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => +(peneCap * f).toFixed(0));
  const midX = x(maxCars * 0.18);

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 print-avoid-break">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <div>
          <h3 className="text-sm font-bold text-gray-800">Where the opportunity is</h3>
          <p className="text-[11px] text-gray-400">
            Each dot is one dealership · size = units we sell there · click to open
          </p>
        </div>
        <p className="text-[11px] text-gray-400">
          OEM average penetration <b className="text-gray-600">{avgPene.toFixed(1)}%</b>
        </p>
      </div>

      <Explain>
        Left-to-right is <b className="text-gray-600">how big the dealer is</b> (cars
        they retail); bottom-to-top is <b className="text-gray-600">how much of that
        we win</b>. The dotted line is the {avgPene.toFixed(1)}% OEM average.
        So <span style={{ color: VISIT_COLOR }} className="font-semibold">orange dots
        on the right, below the line</span> are big dealerships where we are
        under-performing — the most units available anywhere on this chart.
        Blue above the line is where we are already ahead.
      </Explain>

      <div className="relative overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" style={{ height: 380 }}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="#f3f4f6" />
              <text x={PL - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#9ca3af">{t}%</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - PB + 15} textAnchor="middle" fontSize="10" fill="#9ca3af">
              {t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t}
            </text>
          ))}
          {/* The two lines that make the quadrants readable. */}
          <line x1={PL} x2={W - PR} y1={y(avgPene)} y2={y(avgPene)}
            stroke={VISIT_COLOR} strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
          <line x1={midX} x2={midX} y1={PT} y2={H - PB}
            stroke="#d1d5db" strokeWidth={1} strokeDasharray="4 4" />
          <text x={W - PR - 6} y={y(avgPene) - 5} textAnchor="end" fontSize="9"
            fill={VISIT_COLOR} fontWeight="600">network average</text>
          <text x={W - PR - 6} y={H - PB - 8} textAnchor="end" fontSize="11"
            fill="#9ca3af" fontWeight="700" opacity={0.65}>
            big volume, low penetration
          </text>

          {pts.map((d) => {
            const below = (d.penetration ?? 0) < avgPene;
            const big = d.car_sales >= maxCars * 0.18;
            const isTarget = below && big;
            return (
              <circle
                key={d.id}
                cx={x(d.car_sales)} cy={y(d.penetration ?? 0)} r={r(d.our_sales)}
                fill={isTarget ? VISIT_COLOR : below ? "#fbbf24" : CALL_COLOR}
                fillOpacity={hover && hover.id !== d.id ? 0.18 : isTarget ? 0.62 : 0.4}
                stroke={isTarget ? VISIT_COLOR : "transparent"} strokeWidth={1}
                className="cursor-pointer transition-opacity"
                onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)}
                onClick={() => onPick(d)}
              />
            );
          })}
          <text x={(W - PL) / 2 + PL} y={H - 4} textAnchor="middle" fontSize="10" fill="#9ca3af">
            Their car sales (square-root scale)
          </text>
          <text x={-(H / 2)} y={13} transform="rotate(-90)" textAnchor="middle" fontSize="10" fill="#9ca3af">
            Our penetration
          </text>
        </svg>

        {hover && (
          <div className="absolute top-2 left-14 bg-gray-900/92 text-white rounded-xl px-3 py-2 pointer-events-none shadow-lg">
            <p className="text-xs font-bold">{hover.name}</p>
            <p className="text-[10px] text-gray-300">
              {hover.city} · {hover.salesperson ?? "—"}
            </p>
            <p className="text-[10px] mt-1">
              {n0(hover.car_sales)} cars · {n0(hover.our_sales)} ours · {pct(hover.penetration)}
            </p>
            <p className="text-[10px] text-gray-300">
              {hover.contacts} contact{hover.contacts === 1 ? "" : "s"} in period
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Top / bottom N by a chosen metric.
 *
 *  The bottom list applies a VOLUME FLOOR. Ranked purely by penetration the
 *  worst dealers are simply the smallest ones, which is true and useless —
 *  the floor makes it read "big dealers we are failing at" instead. */
function DealerRankTable({ dealers, avgPene, onPick }: {
  dealers: PerfDealer[]; avgPene: number; onPick: (d: PerfDealer) => void;
}) {
  const [metric, setMetric] = useState<RankMetric>("gap");
  const [end, setEnd] = useState<"top" | "bottom">("top");

  const withSales = dealers.filter((d) => d.has_sales);
  const floor = useMemo(() => {
    const vols = withSales.map((d) => d.car_sales).sort((a, b) => a - b);
    return vols.length ? vols[Math.floor(vols.length / 2)] : 0;
  }, [withSales]);

  const meta = RANK_META[metric];
  const flooring = end === "bottom" && meta.floor;
  const pool = flooring ? withSales.filter((d) => d.car_sales >= floor) : withSales;
  const sorted = [...pool].sort((a, b) =>
    rankValue(b, metric, avgPene) - rankValue(a, metric, avgPene));
  const rows = (end === "top" ? sorted : [...sorted].reverse()).slice(0, 20);

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 print-avoid-break">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800">
            {end === "top" ? "Top" : "Bottom"} 20 · {meta.label}
          </h3>
          <p className="text-[11px] text-gray-400">{meta.what}</p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
            {(["top", "bottom"] as const).map((e) => (
              <button key={e} onClick={() => setEnd(e)}
                className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg capitalize transition-all ${
                  end === e ? "bg-white text-orange-500 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}>{e}</button>
            ))}
          </div>
          <Select value={metric} onChange={(v) => setMetric(v as RankMetric)}
            options={(Object.keys(RANK_META) as RankMetric[]).map((k) => ({ value: k, label: RANK_META[k].label }))} />
        </div>
      </div>

      <Explain>
        <b className="text-gray-600">
          Showing the {end === "top" ? "top" : "bottom"} 20:
        </b>{" "}
        {end === "top" ? meta.top : meta.bottom}
        {flooring && (
          <> Only dealers retailing <b>{n0(floor)}+</b> cars are included, otherwise
            the bottom of a share-based list is just the smallest dealerships.</>
        )}
        {" "}The <b className="text-gray-600">Opp.</b> column is the same figure in
        every view: <span className="text-orange-500 font-semibold">+n</span> means
        we are n units <i>behind</i> the <b>{avgPene.toFixed(1)}%</b> OEM
        average and could gain them;{" "}
        <span className="text-green-600 font-semibold">−n</span> means we are n units{" "}
        <i>ahead</i> of it.
      </Explain>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-gray-400 border-b border-gray-100">
              <th className="text-left font-bold py-2 pl-1">#</th>
              <th className="text-left font-bold py-2">Dealership</th>
              <th className="text-left font-bold py-2">Rep</th>
              <th className="text-right font-bold py-2">Their cars</th>
              <th className="text-right font-bold py-2">Our units</th>
              <th className="text-right font-bold py-2">Pene</th>
              <th className="text-right font-bold py-2"
                title="Units vs what network-average penetration would predict: + = room to gain, − = already ahead">
                Opp.
              </th>
              <th className="text-right font-bold py-2 pr-1">Contacts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const gap = Math.round(rankValue(d, "gap", avgPene));
              return (
                <tr key={d.id} onClick={() => onPick(d)}
                  className="border-b border-gray-50 hover:bg-orange-50/40 cursor-pointer">
                  <td className="py-2 pl-1 text-gray-300 font-semibold">{i + 1}</td>
                  <td className="py-2">
                    <span className="font-semibold text-gray-800">{d.name}</span>
                    <span className="text-gray-400"> · {d.city}</span>
                  </td>
                  <td className="py-2 text-gray-500">{d.salesperson ?? "—"}</td>
                  <td className="py-2 text-right tabular-nums text-gray-600">{n0(d.car_sales)}</td>
                  <td className="py-2 text-right tabular-nums font-semibold text-gray-800">{n0(d.our_sales)}</td>
                  <td className={`py-2 text-right tabular-nums font-semibold ${
                    (d.penetration ?? 0) >= avgPene ? "text-green-600" : "text-red-500"}`}>
                    {pct(d.penetration)}
                  </td>
                  {/* Signed, both ways. A negative gap is not "no data" — it is
                      a dealer already selling MORE than network average would
                      predict, which is worth seeing. */}
                  <td className={`py-2 text-right tabular-nums font-semibold ${
                    gap > 0 ? "text-orange-500" : gap < 0 ? "text-green-600" : "text-gray-300"}`}>
                    {gap > 0 ? `+${n0(gap)}` : gap < 0 ? `−${n0(-gap)}` : "—"}
                  </td>
                  <td className="py-2 pr-1 text-right tabular-nums">
                    {d.contacts === 0
                      ? <span className="text-red-400 font-semibold">none</span>
                      : <span className="text-gray-600">{d.contacts}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Coverage per rep: how much of the patch they actually touched. */
function CoveragePanel({ rows }: { rows: DealerSpRow[] }) {
  const real = rows.filter((r) => r.salesperson !== "Unassigned");
  const max = Math.max(...real.map((r) => r.assigned), 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Coverage</h3>
      <Explain>
        How much of a rep's patch they actually reached in this period: dealerships
        contacted at least once, out of every dealership assigned to them in the OEM's
        own dealer list. Bar length is the size of the patch, fill is the share
        covered — so a short full bar is a small patch worked thoroughly, and a long
        empty one is a big patch going untouched. A visit and a phone call both count.
      </Explain>
      <div className="flex flex-col gap-2.5">
        {[...real].sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0)).map((r) => (
          <div key={r.salesperson} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs font-semibold text-gray-700 truncate">
              {firstName(r.salesperson)}
            </span>
            <div className="flex-1 h-6 rounded-lg bg-gray-100 relative overflow-hidden"
              style={{ maxWidth: `${(r.assigned / max) * 100}%` }}>
              <div className="h-full rounded-lg transition-all"
                style={{ width: `${r.coverage ?? 0}%`, background: VISIT_COLOR, opacity: 0.85 }} />
              <span className="absolute inset-y-0 left-2 flex items-center text-[10px] font-bold text-white mix-blend-luminosity">
                {r.contacted}
              </span>
            </div>
            <span className={`w-28 shrink-0 text-[11px] font-bold tabular-nums ${coverageColor(r.coverage)}`}>
              {pct(r.coverage)} <span className="text-gray-400 font-medium">of {r.assigned}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Quarter vs quarter: target, achievement, and what actually sold. */
function QuarterPanel({ rows }: { rows: DealerQuarter[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.flatMap((r) => [r.target ?? 0, r.achievement ?? 0, r.our_sales ?? 0]), 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Quarter vs quarter</h3>
      <Explain>
        Units targeted against units achieved, per quarter, for the dealerships in
        view. A quarter appears whenever the period touches it at all and its target
        is always shown <b className="text-gray-600">whole</b> — targets are agreed per
        quarter, so cutting one into part-months would invent a number nobody set.
        A quarter still in progress shows its target with no achievement yet.
      </Explain>
      <div className="flex flex-col gap-4">
        {rows.map((r) => {
          const ach = r.achievement ?? 0;
          const tgt = r.target ?? 0;
          const hitPct = tgt ? Math.round((ach / tgt) * 100) : null;
          return (
            <div key={`${r.fy_year}${r.quarter}`}>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-xs font-bold text-gray-700">{r.label}</span>
                <span className="text-[11px] text-gray-400">
                  {n0(r.car_sales)} cars · {pct(r.penetration)} penetration
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Target</span>
                <div className="flex-1 h-4 rounded bg-gray-50">
                  <div className="h-full rounded" style={{ width: `${(tgt / max) * 100}%`, background: NEUTRAL_BAR }} />
                </div>
                <span className="w-16 text-right text-[11px] font-semibold tabular-nums text-gray-500">{n0(tgt)}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="w-16 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Achieved</span>
                <div className="flex-1 h-4 rounded bg-gray-100">
                  <div className="h-full rounded transition-all" style={{
                    width: `${(ach / max) * 100}%`,
                    background: hitPct !== null && hitPct >= ON_TRACK_PCT ? OVER_COLOR : VISIT_COLOR,
                  }} />
                </div>
                <span className="w-16 text-right text-[11px] font-bold tabular-nums text-gray-700">
                  {ach ? n0(ach) : "—"}
                </span>
              </div>
              {hitPct !== null && (
                <p className="text-[10px] text-gray-400 mt-1 pl-[4.5rem]">
                  {ach ? `${hitPct}% of target` : "quarter still open"}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Does contacting a dealer more actually move what we sell there? */
function ContactEffectPanel({ data }: { data: DealerPerf["contact_effect"] }) {
  if (!data.buckets.length) return null;
  const max = Math.max(...data.buckets.map((b) => b.penetration ?? 0), 1);
  const thin = data.months < 3;
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Does contacting them help?</h3>
      <Explain>
        Dealerships grouped by how many times they were contacted in a month, and what
        our penetration was at them <b className="text-gray-600">in that same month</b>.
        Each bar is a group, not a dealer — "3-4" means every dealer-month with three
        or four contacts in it. If contact moved the needle, the bars would climb left
        to right.
      </Explain>
      <div className="flex items-end gap-3 h-40">
        {data.buckets.map((b) => (
          <div key={b.bucket} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
            <span className="text-[11px] font-bold text-gray-700">{pct(b.penetration)}</span>
            <div className="w-full rounded-t-lg transition-all" style={{
              height: `${((b.penetration ?? 0) / max) * 100}%`,
              background: VISIT_COLOR,
              opacity: 0.35 + 0.65 * ((b.penetration ?? 0) / max),
            }} />
            <span className="text-[10px] font-semibold text-gray-500">{b.bucket}</span>
            <span className="text-[9px] text-gray-400">{b.dealer_months} mo</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-3 leading-relaxed">
        <b>Read this carefully.</b> It is an association, not proof — reps go where they
        already do well, so some of this gradient is them picking good dealers rather
        than the contact creating the sale.
        {thin && (
          <> Right now it rests on <b>{data.months} month{data.months === 1 ? "" : "s"}</b> where
            dealer sales and visit logs overlap at all, which is far too thin to lean on.</>
        )}
      </p>
    </div>
  );
}

/** Their volume, our volume and our activity on one timeline. */
/**
 * Their volume, our share of it, and our activity — on one time axis.
 *
 * Replaces an earlier hand-rolled version that failed at the one job the panel
 * has. It drew penetration as a floating 1px mark per column with no line
 * joining them, so the trend had to be inferred by eye; it scaled the bars and
 * the marks to two different unlabelled maxima, so nothing could be read as a
 * value; and it showed activity as a single dot per mode, so one call and forty
 * looked identical. On the real data that hid the headline: penetration nearly
 * halved between March and June while their car sales barely moved.
 *
 * What it does now:
 *   • ONE stacked bar per month whose full height is the cars they retailed,
 *     with the orange portion being the ones carrying our product. The bar IS
 *     penetration, drawn to scale — the eye gets the ratio without arithmetic.
 *   • A real connected line for penetration on its own right-hand axis, with a
 *     dashed reference at the OEM benchmark so "good" has a fixed position.
 *   • A separate aligned strip for visits and calls, to scale, so the question
 *     "did activity move it" can actually be looked at.
 *
 * Used for the whole network and for a single dealership unchanged; only the
 * magnitudes differ.
 */
function DealerTrend({ rows, benchmark, title = "Network trend", subject = "these dealerships" }: {
  rows: DealerMonth[]; benchmark?: number | null; title?: string; subject?: string;
}) {
  if (!rows.length) return null;

  const data = rows.map((r) => {
    const cars = r.car_sales;
    const ours = r.our_sales;
    return {
      name: `${MONTH_SHORT[Number(r.month.slice(5, 7)) - 1]} '${r.month.slice(2, 4)}`,
      // Split so the stack totals their car sales: orange = ours, grey = the
      // rest of their business. our_sales never exceeds car_sales in the data.
      ours: cars === null ? undefined : ours ?? 0,
      rest: cars === null ? undefined : Math.max(0, cars - (ours ?? 0)),
      cars: cars ?? undefined,
      pene: r.penetration ?? undefined,
      visits: r.visits,
      calls: r.calls,
    };
  });
  const anyActivity = data.some((d) => d.visits > 0 || d.calls > 0);
  // Same margins on both charts so the two x axes line up column for column.
  const margin = { top: 8, right: 8, bottom: 0, left: 0 };

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-4 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      <Explain>
        Each bar is one month of cars {subject} retailed. The{" "}
        <span style={{ color: VISIT_COLOR }} className="font-semibold">orange part</span>{" "}
        is the cars that carried our product, the grey is the rest of their business —
        so the orange share of the bar <i>is</i> our penetration, drawn to scale. The{" "}
        <span style={{ color: VISIT_COLOR }} className="font-semibold">orange line</span>{" "}
        reads that share as a percentage against the right-hand axis
        {benchmark ? <>, and the dashed line is the {benchmark.toFixed(1)}% OEM average</> : null}.
        {anyActivity && " The strip underneath is how many visits and calls were logged that month."}
      </Explain>

      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={data} margin={margin}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
          <YAxis yAxisId="units" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false}
            width={44} tickFormatter={(v: number) => formatCompact(v)} />
          <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 10, fill: VISIT_COLOR }}
            axisLine={false} tickLine={false} width={38} unit="%" />
          <Tooltip
            contentStyle={{ borderRadius: 12, border: "1px solid #ffe4d3", fontSize: 12 }}
            itemStyle={{ color: CHART_LABEL }}
            formatter={(v: number, key: string) => {
              if (key === "pene") return [`${v}%`, "Penetration"];
              if (key === "ours") return [n0(v), "Cars carrying our product"];
              if (key === "rest") return [n0(v), "Rest of their cars"];
              return [n0(v), key];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7}
            formatter={(value: string) => <span style={{ color: CHART_LABEL }}>{value}</span>} />
          <Bar yAxisId="units" dataKey="ours" stackId="cars" name="Cars carrying our product"
            fill={VISIT_COLOR} radius={[0, 0, 0, 0]} />
          <Bar yAxisId="units" dataKey="rest" stackId="cars" name="Rest of their cars"
            fill={NEUTRAL_BAR} radius={[4, 4, 0, 0]} />
          {benchmark ? (
            <ReferenceLine yAxisId="pct" y={benchmark} stroke={VISIT_COLOR} strokeDasharray="4 4"
              strokeOpacity={0.5} />
          ) : null}
          <Line yAxisId="pct" type="monotone" dataKey="pene" name="Penetration"
            stroke={VISIT_COLOR} strokeWidth={2}
            dot={{ r: 3, fill: "#fff", stroke: VISIT_COLOR, strokeWidth: 2 }} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>

      {anyActivity && (
        <ResponsiveContainer width="100%" height={78}>
          <ComposedChart data={data} margin={margin}>
            <XAxis dataKey="name" hide />
            <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false}
              width={44} allowDecimals={false} />
            <Tooltip
              contentStyle={{ borderRadius: 12, border: "1px solid #ffe4d3", fontSize: 12 }}
              itemStyle={{ color: CHART_LABEL }}
              formatter={(v: number, key: string) => [n0(v), key === "visits" ? "Visits" : "Calls"]}
            />
            <Bar dataKey="visits" stackId="act" name="Visits" fill={VISIT_COLOR} />
            <Bar dataKey="calls" stackId="act" name="Calls" fill={CALL_COLOR} radius={[4, 4, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Everything about one dealership, opened from any row or dot. */
function DealerDrawer({ dealerId, headers, benchmark, onClose }: {
  dealerId: string; headers: Record<string, string>;
  /** The OEM average, carried in from the tab so a single dealer's chart is
   *  read against the same yardstick as everything else on the page. */
  benchmark?: number | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<DealerDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/dealer-performance/${dealerId}`, { headers });
      if (res.ok) setData(await res.json());
      setLoading(false);
    })();
  }, [dealerId, headers]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const d = data?.dealer;
  return (
    <div className="no-print fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-gray-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <motion.div
        initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.18 }}
        className="relative w-full max-w-2xl h-full bg-gray-50 overflow-y-auto shadow-2xl"
      >
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-orange-100 px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-gray-900 truncate">{d?.name ?? "Loading…"}</h2>
            {d && (
              <p className="text-[11px] text-gray-400 mt-0.5">
                {d.city} · {d.state} · {d.oem} · handled by <b className="text-gray-600">{d.salesperson ?? "—"}</b>
              </p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-700 p-1">
            <X size={18} />
          </button>
        </div>

        {loading && <div className="p-10 text-center text-sm text-gray-400">Loading…</div>}

        {data && (
          <div className="p-5 flex flex-col gap-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Their cars" value={n0(data.totals.car_sales)} icon={<CarFront size={16} />}
                color="#6b7280" bg="#f3f4f6" />
              <StatCard label="Our units" value={n0(data.totals.our_sales)} icon={<Package size={16} />}
                color={VISIT_COLOR} bg="#fff4ed" />
              <StatCard label="Penetration" value={pct(data.totals.penetration)} icon={<Target size={16} />}
                color="#16a34a" bg="#f0fdf4" />
              <StatCard label="Contacts" value={data.totals.visits + data.totals.calls}
                sub={`${data.totals.visits} visits · ${data.totals.calls} calls`}
                icon={<Footprints size={16} />} color={CALL_COLOR} bg="#eff6ff" />
            </div>

            {data.last_field_note && (
              <div className="bg-white border border-orange-200 rounded-2xl p-4">
                <p className="text-[10px] font-bold uppercase tracking-wider text-orange-500 mb-1">
                  Last field visit remark · {shortDate(data.last_field_note.visit_date)} ·{" "}
                  {data.last_field_note.salesperson}
                </p>
                {data.last_field_note.notes.map((nt, i) => (
                  <p key={i} className="text-sm text-gray-700 leading-relaxed">
                    <span className="text-[10px] font-bold uppercase text-gray-400 mr-1.5">{nt.label}</span>
                    {nt.text}
                  </p>
                ))}
              </div>
            )}

            <DealerTrend rows={data.by_month} benchmark={benchmark}
              title="This dealership, month by month" subject="this dealership" />

            {data.targets.length > 0 && (
              <div className="bg-white border border-orange-100 rounded-2xl p-4">
                <h3 className="text-sm font-bold text-gray-800 mb-2">Target vs achievement</h3>
                <div className="flex flex-col gap-2">
                  {data.targets.map((t) => {
                    const hit = t.target ? Math.round(((t.achievement ?? 0) / t.target) * 100) : null;
                    return (
                      <div key={t.label} className="flex items-center gap-3 text-xs">
                        <span className="w-16 font-bold text-gray-700">{t.label}</span>
                        <div className="flex-1 h-4 rounded bg-gray-100 relative">
                          <div className="h-full rounded" style={{
                            width: `${Math.min(hit ?? 0, 100)}%`,
                            background: hit !== null && hit >= ON_TRACK_PCT ? OVER_COLOR : VISIT_COLOR,
                          }} />
                        </div>
                        <span className="w-32 text-right tabular-nums text-gray-500">
                          {n0(t.achievement)} / {n0(t.target)}
                          {hit !== null && <b className="ml-1 text-gray-700">{hit}%</b>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="bg-white border border-orange-100 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-gray-800 mb-1">
                Contact history <span className="text-gray-400 font-medium">({data.history.length})</span>
              </h3>
              {data.history.length === 0 && (
                <p className="text-sm text-gray-400 py-4 text-center">
                  No contact logged with this dealership yet.
                </p>
              )}
              <div className="flex flex-col divide-y divide-gray-50">
                {data.history.map((h) => (
                  <div key={h.id} className="py-3 flex gap-3">
                    <div className="w-14 shrink-0">
                      <p className="text-[11px] font-bold text-gray-600">{shortDate(h.visit_date)}</p>
                      <ModeBadge mode={h.contact_mode} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-gray-400">
                        {h.salesperson}
                        {h.contact_person && ` · met ${h.contact_person}`}
                        {h.designation && ` (${h.designation})`}
                        {h.channel && ` · ${h.channel}`}
                      </p>
                      {h.notes.length === 0 && <p className="text-xs text-gray-300 italic">no remark</p>}
                      {h.notes.map((nt, i) => (
                        <p key={i} className="text-xs text-gray-700 mt-0.5 leading-relaxed">
                          <span className="text-[9px] font-bold uppercase text-gray-400 mr-1">{nt.label}</span>
                          {nt.text}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function DealersTab({ headers }: { headers: Record<string, string> }) {
  const [options, setOptions] = useState<{ oems: string[]; states: string[] } | null>(null);
  const [oem, setOem] = useState("MSIL");
  const [salesperson, setSalesperson] = useState("");
  const [state, setState] = useState("");
  // Defaults to all time: dealer sales start in January while the log book only
  // starts in July, so landing on "this month" would open the tab on a month
  // with no sales in it at all.
  const [periodMode, setPeriodMode] = useState<PeriodChoice>("all");
  const [selected, setSelected] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [data, setData] = useState<DealerPerf | null>(null);
  const [loading, setLoading] = useState(true);
  const [openDealer, setOpenDealer] = useState<string | null>(null);
  // Captured from the first unfiltered response and then left alone — the
  // period list must keep offering every month, not shrink to whatever the
  // current filter returned.
  const [allMonths, setAllMonths] = useState<Period[]>([]);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/filter-options?scope=logs`, { headers });
      if (res.ok) setOptions(await res.json());
    })();
  }, [headers]);

  useEffect(() => {
    const pp = periodParams(periodMode, selected, range);
    if (!pp) return;
    const params = new URLSearchParams(pp);
    if (oem) params.set("oem", oem);
    if (salesperson) params.set("salesperson", salesperson);
    if (state) params.set("state", state);
    setLoading(true);
    (async () => {
      const res = await fetch(`${API_URL}/oe-network/dealer-performance?${params}`, { headers });
      if (res.ok) {
        const j: DealerPerf = await res.json();
        setData(j);
        setAllMonths((prev) => prev.length ? prev : j.by_month.map((m) => ({
          year: Number(m.month.slice(0, 4)), month: Number(m.month.slice(5, 7)),
        })));
      }
      setLoading(false);
    })();
  }, [periodMode, selected, range, oem, salesperson, state, headers]);

  const optionsByMode = useMemo<Record<PeriodMode, { value: string; label: string }[]>>(
    () => buildPeriodOptions(allMonths), [allMonths]);
  const periodOptions =
    periodMode === "custom" || periodMode === "all" ? [] : optionsByMode[periodMode];
  const switchMode = (m: PeriodChoice) => {
    setPeriodMode(m);
    if (m === "custom" || m === "all") return;
    const first = optionsByMode[m][0];
    if (first) setSelected(first.value);
  };

  const toOpts = (arr: string[] | undefined, all: string) =>
    [{ value: "", label: all }, ...(arr ?? []).map((v) => ({ value: v, label: v }))];

  // Reps come from the dealer file's own assignment, not from who logged a
  // visit — the point is to include the dealers a rep never touched.
  const reps = useMemo(
    () => [...new Set((data?.by_salesperson ?? [])
      .map((r) => r.salesperson).filter((s) => s !== "Unassigned"))].sort(),
    [data],
  );

  const k = data?.kpis;
  // The benchmark, NOT this view's own penetration. Filtering to a rep must not
  // change the yardstick their dealers are measured against, or a weak
  // territory reads as having the least to gain.
  const avgPene = k?.benchmark ?? k?.penetration ?? 0;
  const noSales = !!data && data.dealers.every((d) => !d.has_sales);

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={periodMode} onMode={switchMode}
          token={selected} onToken={setSelected} options={periodOptions}
          range={range} onRange={setRange}
        />
        <Select value={oem} onChange={setOem} options={toOpts(options?.oems, "All OEMs")} placeholder="OEM" />
        <Select value={salesperson} onChange={setSalesperson}
          options={toOpts(reps, "All reps")} placeholder="Rep" />
        <Select value={state} onChange={setState} options={toOpts(options?.states, "All states")} placeholder="State" />
        {(salesperson || state) && (
          <button onClick={() => { setSalesperson(""); setState(""); }}
            className="text-[11px] font-semibold text-orange-500 hover:text-orange-600 px-2">
            Clear
          </button>
        )}
      </FilterBar>

      {/* Sales are monthly figures, so a day range can only cut them to whole
          months. Saying so beats letting the numbers imply otherwise. */}
      {periodMode === "custom" && data?.period.date_from && (
        <p className="text-[11px] text-gray-400 -mt-2">
          Visits and calls counted {shortDate(data.period.date_from)}–{shortDate(data.period.date_to)}.
          Dealer sales are reported monthly, so those cover whole months
          ({MONTH_SHORT[Number(data.period.month_from!.slice(5, 7)) - 1]}–
          {MONTH_SHORT[Number(data.period.month_to!.slice(5, 7)) - 1]}).
        </p>
      )}

      {loading && !data && (
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
          Loading dealer performance…
        </div>
      )}

      {k && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard label="Coverage" value={pct(k.coverage)}
            sub={`${n0(k.contacted)} of ${n0(k.dealers)} dealerships`}
            icon={<Store size={18} />} color={VISIT_COLOR} bg="#fff4ed" />
          <StatCard label="Penetration" value={pct(k.penetration)}
            sub={`${n0(k.our_sales)} ours ÷ ${n0(k.car_sales)} cars`}
            icon={<Target size={18} />} color="#16a34a" bg="#f0fdf4" />
          <StatCard label="Their car sales" value={n0(k.car_sales)}
            icon={<CarFront size={18} />} color="#6b7280" bg="#f3f4f6" />
          <StatCard label="Our units" value={n0(k.our_sales)}
            sub={k.target ? `target ${n0(k.target)}` : undefined}
            icon={<Package size={18} />} color={CALL_COLOR} bg="#eff6ff" />
          <StatCard label="Contacts" value={n0(k.visits + k.calls)}
            sub={`${n0(k.visits)} visits · ${n0(k.calls)} calls`}
            icon={<Footprints size={18} />} color="#8b5cf6" bg="#f5f3ff" />
        </div>
      )}

      {noSales && data && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800">
          <b>No dealer sales data for {oem} yet.</b> The OE team's dealer file currently
          covers MSIL only, so coverage and contact counts are real here but car sales,
          penetration and targets will stay empty until their {oem} tab arrives.
        </div>
      )}

      {data && !noSales && (
        <>
          <DealerMap dealers={data.dealers} avgPene={avgPene}
            onPick={(d) => setOpenDealer(d.id)} />
          <DealerRankTable dealers={data.dealers} avgPene={avgPene}
            onPick={(d) => setOpenDealer(d.id)} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CoveragePanel rows={data.by_salesperson} />
            <QuarterPanel rows={data.by_quarter} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DealerTrend rows={data.by_month} benchmark={avgPene} />
            <ContactEffectPanel data={data.contact_effect} />
          </div>
        </>
      )}

      {data && noSales && <CoveragePanel rows={data.by_salesperson} />}

      <AnimatePresence>
        {openDealer && (
          <DealerDrawer dealerId={openDealer} headers={headers} benchmark={avgPene}
            onClose={() => setOpenDealer(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Plan vs Actual" },
  { id: "dealers", label: "Dealers" },
  { id: "activity", label: "Field Activity" },
  { id: "targets", label: "Targets" },
  { id: "sheets", label: "Sheets" },
];

const TAB_SUBTITLES: Record<TabId, string> = {
  overview: "Plan coverage and field activity",
  indepth: "Dealer network health, plan adherence and attach rates",
  dealers: "Where the opportunity is — coverage, penetration and each dealership's own story",
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
      {activeTab === "dealers" && <DealersTab headers={headers} />}
      {activeTab === "indepth" && <InDepthTab headers={headers} />}
      {activeTab === "activity" && <FieldActivityTab headers={headers} />}
      {activeTab === "targets" && <TargetsTab headers={headers} />}
      {activeTab === "sheets" && <SheetsTab headers={headers} />}
    </div>
  );
}
