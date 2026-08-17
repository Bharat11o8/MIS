// Shared primitives for the OE Network page — the palette, the period-selection
// plumbing and the small building blocks every tab uses. Extracted from
// OENetworkPage.tsx so the dealer half of the module can live in its own files
// (see ./dealers) without duplicating any of this.
import { useState, useEffect, useMemo } from "react";
import { Footprints, Phone } from "lucide-react";
import Select from "@/components/ui/Select";
import DateRangePicker, { dayPresets } from "@/components/ui/DateRangePicker";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Series colors follow the entity everywhere on this page: field visits are
// orange, phone calls are blue (same palette as the rest of the app).
// VISIT_COLOR is the same hex as Tailwind's `brand-orange` token — text and
// borders should use the `brand-orange` classes, never `orange-500`, which is a
// visibly different orange (#f97316).
export const VISIT_COLOR = "#f46617";
export const CALL_COLOR = "#3b82f6";
// On the bullet charts the grey track is the goal (planned visits / the target).
export const TGT_TRACK = "#e5e7eb";
// A grey that is actually VISIBLE as a filled series. TGT_TRACK is a background
// track and is nearly invisible when used as a bar on a white card next to a
// #f3f4f6 grid, so anything carrying data uses this instead.
export const NEUTRAL_BAR = "#c2c8d0";
// The funnel bar stacks three bands directly on top of each other, so its two
// non-orange bands need to separate from EACH OTHER, not just from the card.
// NEUTRAL_BAR (#c2c8d0) over TGT_TRACK (#e5e7eb) is two steps on one ramp and
// reads as a single grey block. This is the darker "we could have won it" band;
// the pale TGT_TRACK stays on top for "no part number exists".
export const FUNNEL_MISSED = "#8b95a5";
// Chart labels must never inherit their series colour — recharts draws legend
// and tooltip text in the series colour by default, which makes any pale series
// unreadable. Text stays dark; the colour swatch does the identifying.
export const CHART_LABEL = "#4b5563";
export const OVER_COLOR = "#22c55e";
// Targets that belong to no salesperson (MSIL/TATA accessories) get a colour of
// their own on the bullet charts — they sit in the same total as the people bars
// but are not a person, and must never be read as one.
export const UNOWNED_COLOR = "#8b5cf6";
// A quarter from 90% of target up counts as on-track for the business, so the
// target bars turn green there rather than at a literal 100%.
export const ON_TRACK_PCT = 90;

export interface Period { year: number; month: number }
export type PeriodMode = "monthly" | "quarterly" | "yearly";

export function monthToken(p: Period) { return `${p.year}-${p.month}`; }
export function tokenLabel(t: string) {
  const [y, m] = t.split("-").map(Number);
  return `${MONTH_FULL[m - 1]} ${y}`;
}

// Indian FY (Apr–Mar), same convention as the Sales module: Q1 = Apr–Jun and
// "FY26-27" starts April 2026.
export function fyOf(year: number, month: number) { return month >= 4 ? year : year - 1; }
export function fqOf(month: number) { return month >= 4 ? Math.floor((month - 4) / 3) + 1 : 4; }
export function quarterToken(fy: number, q: number) { return `${fy}-Q${q}`; }
export function quarterLabel(t: string) {
  const [fyStr, qStr] = t.split("-Q");
  return `Q${qStr} FY${String(Number(fyStr) + 1).slice(2)}`;
}
export function fyLabel(fy: number) { return `FY${String(fy).slice(2)}-${String(fy + 1).slice(2)}`; }
export const pad2 = (n: number) => String(n).padStart(2, "0");

/** Expands a selected period token into the inclusive YYYY-MM range the API takes. */
export function periodRange(mode: PeriodMode, token: string): [string, string] {
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
export type PeriodChoice = PeriodMode | "custom" | "all";
export interface DateRange { from: string; to: string }

// Indian FY quarters, as the target sheets publish them.
export const QUARTER_MONTHS: Record<number, number[]> = {
  1: [4, 5, 6], 2: [7, 8, 9], 3: [10, 11, 12], 4: [1, 2, 3],
};

const PERIOD_CHOICES: PeriodChoice[] = ["monthly", "quarterly", "yearly", "custom", "all"];
const PERIOD_LABELS: Record<PeriodChoice, string> = {
  monthly: "monthly", quarterly: "quarterly", yearly: "yearly",
  custom: "custom", all: "all time",
};

export function PeriodControls({ mode, onMode, token, onToken, options, range, onRange }: {
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
              mode === m ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}>
            {PERIOD_LABELS[m]}
          </button>
        ))}
      </div>
      {mode === "all" ? null : mode === "custom" ? (
        <DateRangePicker value={range} onChange={onRange} presets={dayPresets()}
          placeholder="Pick dates" />
      ) : (
        <Select value={token} onChange={onToken} options={options} placeholder="Period…" />
      )}
    </>
  );
}

/** Query params for a period selection, or null when it isn't usable yet —
 *  a half-entered custom range must not fire a request for "everything". */
export function periodParams(mode: PeriodChoice, token: string, range: DateRange):
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

/**
 * The selected period as inclusive `YYYY-MM` bounds, or null when there is no
 * month window to apply — either "all time" or a custom range still being
 * typed. Both mean "don't filter", which is why they share a return value.
 *
 * Used to cut month-grain data client-side (a trend already fetched whole)
 * without a second request. A day range widens to the months it touches, the
 * same rule the backend applies.
 */
export function periodMonthBounds(mode: PeriodChoice, token: string, range: DateRange):
  [string, string] | null {
  const pp = periodParams(mode, token, range);
  if (!pp) return null;
  if (pp.from_ym && pp.to_ym) return [pp.from_ym, pp.to_ym];
  if (pp.from_date && pp.to_date) return [pp.from_date.slice(0, 7), pp.to_date.slice(0, 7)];
  return null;
}

/** Is `YYYY-M` (or a year/month pair) inside the bounds? Zero-pads first, so
 *  "2026-8" compares correctly against "2026-08". */
export function monthInBounds(year: number, month: number, bounds: [string, string] | null) {
  if (!bounds) return true;
  const ym = `${year}-${pad2(month)}`;
  return ym >= bounds[0] && ym <= bounds[1];
}

/** Period option lists derived from the months that actually hold data, so
 *  future months make new options appear on their own. */
export function buildPeriodOptions(months: Period[]): Record<PeriodMode, { value: string; label: string }[]> {
  // Deduped here rather than by each caller: a tab whose months come from two
  // sheets (the Overview unions plan months with log months) would otherwise
  // offer the same month twice in the picker.
  const uniq = new Map<string, Period>();
  months.forEach((p) => uniq.set(monthToken(p), p));
  const sorted = [...uniq.values()].sort((a, b) => b.year - a.year || b.month - a.month);
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

/**
 * The period state machine every tab was copy-pasting: mode, selected token,
 * custom range, and the option lists derived from whichever months hold data.
 * The MONTHS stay owned by the caller (via setMonths) because each tab has its
 * own rule for where they come from and when they may shrink.
 */
export function usePeriod(initialMode: PeriodChoice = "monthly") {
  const [mode, setMode] = useState<PeriodChoice>(initialMode);
  const [token, setToken] = useState("");
  const [range, setRange] = useState<DateRange>({ from: "", to: "" });
  const [months, setMonths] = useState<Period[]>([]);

  const optionsByMode = useMemo(() => buildPeriodOptions(months), [months]);
  const options = mode === "custom" || mode === "all" ? [] : optionsByMode[mode];
  // Switching views lands on the latest period of that view, never an empty selection.
  const switchMode = (m: PeriodChoice) => {
    setMode(m);
    if (m === "custom" || m === "all") return;   // neither needs a token
    const first = optionsByMode[m][0];
    if (first) setToken(first.value);
  };
  return { mode, token, setToken, range, setRange, months, setMonths, options, switchMode };
}

// The filter bar, its action buttons and the canonical filter vocabulary are
// app-wide (see CLAUDE.md § "Filters and selectors"), not OE-Network-specific.
// Re-exported here only so this module's tabs keep one import.
export {
  FilterBar, FilterActions, ClearFilters, FilterSpinner,
  RefreshButton, PdfButton, SyncButton,
  FILTER_LABELS, toOpts, filterOpts,
} from "@/components/ui/FilterBar";

/** Fetches /filter-options for a scope once, aborting if the caller unmounts. */
export function useFilterOptions<T>(scope: string, headers: Record<string, string>): T | null {
  const [options, setOptions] = useState<T | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/filter-options?scope=${scope}`,
          { headers, signal: ctrl.signal });
        if (res.ok) setOptions(await res.json());
      } catch { /* aborted, or network error — the options simply stay empty */ }
    })();
    return () => ctrl.abort();
  }, [scope, headers]);
  return options;
}

export function shortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

/** Axis-tick version of a salesperson name: first real name word, skipping initials. */
export function firstName(n: string) {
  return n.split(/\s+/).find((t) => t.length >= 3) ?? n;
}

export function coverageColor(pct: number | null) {
  if (pct === null) return "text-gray-500";
  if (pct >= 80) return "text-green-600";
  if (pct >= 50) return "text-amber-600";
  return "text-red-500";
}

export function ModeBadge({ mode }: { mode: string | null }) {
  if (!mode) return <span className="text-gray-400">—</span>;
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

/**
 * One colour identity per IDEA, for every StatCard in the module.
 *
 * Before this, each tab hard-coded its own hex and they disagreed: "dealerships
 * reached" was sky #0ea5e9 on three tabs and blue #3b82f6 on Dealers; green was
 * #22c55e on some cards and #16a34a on others; neutral grey came with two
 * different backgrounds. Spread these (`{...KPI.reach}`) instead of writing a
 * hex, and a concept can only ever have one colour.
 */
export const KPI = {
  /** Our own sales / what we achieved — the same orange as the funnel band. */
  ours:       { color: VISIT_COLOR, bg: "#fff4ed" },
  /** Field visits. */
  visits:     { color: VISIT_COLOR, bg: "#fff4ed" },
  /** Phone calls — the app-wide "call" blue. */
  calls:      { color: CALL_COLOR,  bg: "#eff6ff" },
  /** Contacts / coverage / anything counting activity. */
  activity:   { color: CALL_COLOR,  bg: "#eff6ff" },
  /** A ratio of winning: penetration, achievement, hit rate. */
  conversion: { color: "#16a34a",   bg: "#f0fdf4" },
  /** A goal someone set — target, plan. Never a person. */
  target:     { color: UNOWNED_COLOR, bg: "#f5f3ff" },
  /** Dealerships / outlets reached. */
  reach:      { color: "#0ea5e9",   bg: "#f0f9ff" },
  /** Context figures that are neither good nor bad. */
  neutral:    { color: "#6b7280",   bg: "#f3f4f6" },
  /** Needs attention but isn't yet a failure. */
  warning:    { color: "#d97706",   bg: "#fffbeb" },
  /** Missed, stale, overdue. */
  danger:     { color: "#dc2626",   bg: "#fef2f2" },
} as const;

export function StatCard({ label, value, sub, icon, color, bg }: {
  label: string; value: string | number; sub?: string;
  icon: React.ReactNode; color: string; bg: string;
}) {
  return (
    // p-4, not the p-5 panels use: a stat tile is a denser class of card, and
    // the two-tier spacing is deliberate. Panels p-5, tiles p-4.
    <div className="bg-white border border-orange-100 rounded-2xl p-4 flex items-center gap-3 shadow-sm min-w-0">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, color }}>
        {icon}
      </div>
      <div className="min-w-0">
        {/* Both lines truncate on narrow cards, and the sub line is often the
            explanation of the metric — the title keeps the full text reachable. */}
        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 truncate" title={label}>{label}</p>
        <p className="text-xl font-black text-gray-800 leading-tight">{value}</p>
        {sub && <p className="text-[10px] text-gray-500 truncate" title={sub}>{sub}</p>}
      </div>
    </div>
  );
}
