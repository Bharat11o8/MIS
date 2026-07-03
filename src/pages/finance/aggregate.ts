// Shared monthly/quarterly/yearly bucketing for Finance trend views.
// Balance Sheet is a stock figure (point-in-time) — bucketing must keep the
// latest value within a period, never sum it. P&L is a flow figure — bucketing
// sums the monthly amounts within a period. Same Indian-FY-quarter grouping
// as Sales' existing trend-view toggle, lifted out so it isn't triplicated.

export type TrendView = "monthly" | "quarterly" | "yearly";

interface SeriesPoint {
  period_end_date: string;
  amount: number;
}

export interface Bucket {
  period: string;
  amount: number;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fyStartOf(y: number, m: number) {
  return m >= 4 ? y : y - 1;
}
function fyQuarterOf(m: number) {
  return m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
}

function bucketKeyFor(dateStr: string, view: TrendView): { key: string; label: string } {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (view === "monthly") {
    return { key: dateStr.slice(0, 7), label: `${MONTH_NAMES[m - 1]} ${y}` };
  }
  const fy = fyStartOf(y, m);
  if (view === "quarterly") {
    const q = fyQuarterOf(m);
    return { key: `${fy}-Q${q}`, label: `Q${q} FY${String(fy + 1).slice(-2)}` };
  }
  return { key: `FY${fy}`, label: `FY ${fy}-${String(fy + 1).slice(-2)}` };
}

export function bucketStockSeries(series: SeriesPoint[], view: TrendView): Bucket[] {
  const buckets = new Map<string, { label: string; amount: number; sortDate: string }>();
  for (const p of series) {
    const { key, label } = bucketKeyFor(p.period_end_date, view);
    const existing = buckets.get(key);
    if (!existing || p.period_end_date > existing.sortDate) {
      buckets.set(key, { label, amount: p.amount, sortDate: p.period_end_date });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate))
    .map((v) => ({ period: v.label, amount: v.amount }));
}

export function bucketFlowSeries(series: SeriesPoint[], view: TrendView): Bucket[] {
  const buckets = new Map<string, { label: string; amount: number; sortDate: string }>();
  for (const p of series) {
    const { key, label } = bucketKeyFor(p.period_end_date, view);
    const existing = buckets.get(key);
    if (existing) {
      existing.amount += p.amount;
      if (p.period_end_date > existing.sortDate) existing.sortDate = p.period_end_date;
    } else {
      buckets.set(key, { label, amount: p.amount, sortDate: p.period_end_date });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate))
    .map((v) => ({ period: v.label, amount: v.amount }));
}

// ── Balance Sheet dashboard helpers ─────────────────────────────────────────

interface SeriesPointWithPercent {
  period_end_date: string;
  amount: number;
  percent: number | null;
}

export interface BucketWithPercent {
  period: string;
  amount: number;
  percent: number | null;
}

// Same "keep the latest point in the bucket" stock rule as bucketStockSeries,
// but also threads that winning point's own sheet-given percent through —
// quarterly/yearly % must never be invented by re-averaging.
export function bucketStockSeriesWithPercent(series: SeriesPointWithPercent[], view: TrendView): BucketWithPercent[] {
  const buckets = new Map<string, { label: string; amount: number; percent: number | null; sortDate: string }>();
  for (const p of series) {
    const { key, label } = bucketKeyFor(p.period_end_date, view);
    const existing = buckets.get(key);
    if (!existing || p.period_end_date > existing.sortDate) {
      buckets.set(key, { label, amount: p.amount, percent: p.percent, sortDate: p.period_end_date });
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate))
    .map((v) => ({ period: v.label, amount: v.amount, percent: v.percent }));
}

// Resolves an item's value as of an arbitrary picked date — the latest series
// point whose period_end_date is <= dateStr, or null if none exists yet.
export function latestOnOrBefore<T extends { period_end_date: string }>(series: T[], dateStr: string): T | null {
  let best: T | null = null;
  for (const p of series) {
    if (p.period_end_date <= dateStr && (!best || p.period_end_date > best.period_end_date)) {
      best = p;
    }
  }
  return best;
}

export interface DeltaCalc {
  pct: number | null;   // non-null only when prev > 0 — see computeDelta
  delta: number | null; // curr - prev; null only if curr or prev is missing
  reason: "ok" | "no_data" | "non_positive_base";
}

// The one place period-over-period % change is computed. Percent change is
// only meaningful when the base is strictly positive — (curr-prev)/prev is
// mathematically backwards whenever prev <= 0 (e.g. prev=-100 -> curr=-200,
// an algebraic decrease, naively computes as +100%). When prev <= 0 we
// suppress the percentage and let callers fall back to the plain delta.
// Color must always be keyed off `delta`'s sign, never `pct`'s — that
// divergence (only possible when prev < 0) was the source of a real bug.
export function computeDelta(curr: number | null | undefined, prev: number | null | undefined): DeltaCalc {
  if (curr === null || curr === undefined || prev === null || prev === undefined) {
    return { pct: null, delta: null, reason: "no_data" };
  }
  const delta = curr - prev;
  if (prev <= 0) return { pct: null, delta, reason: "non_positive_base" };
  return { pct: Math.round((delta / prev) * 1000) / 10, delta, reason: "ok" };
}

// Per-item delta, mirroring the backend's own MoM/YoY formula exactly:
// MoM = previous point vs latest; YoY = same calendar month one year earlier vs latest.
export function itemDelta(series: SeriesPointWithPercent[], mode: "mom" | "yoy"): DeltaCalc {
  if (series.length === 0) return { pct: null, delta: null, reason: "no_data" };
  const sorted = [...series].sort((a, b) => a.period_end_date.localeCompare(b.period_end_date));
  const latest = sorted[sorted.length - 1];
  if (mode === "mom") {
    if (sorted.length < 2) return { pct: null, delta: null, reason: "no_data" };
    const prev = sorted[sorted.length - 2];
    return computeDelta(latest.amount, prev.amount);
  }
  const latestDate = new Date(latest.period_end_date);
  const targetY = latestDate.getUTCFullYear() - 1;
  const targetM = latestDate.getUTCMonth();
  const priorYear = sorted.find((p) => {
    const d = new Date(p.period_end_date);
    return d.getUTCFullYear() === targetY && d.getUTCMonth() === targetM;
  });
  if (!priorYear) return { pct: null, delta: null, reason: "no_data" };
  return computeDelta(latest.amount, priorYear.amount);
}

// Warm, muted "material" categorical palette — leather/steel/bronze/olive/
// stone tones, each desaturated well below a typical SaaS-chart color, in
// place of bright blue/violet/teal/cyan primaries. Deliberately excludes red,
// green and amber: those hues are already semantic elsewhere in this
// dashboard (red/green = increase/decrease on every delta and heatmap cell,
// amber = sync warnings), so using them for arbitrary line-item categories
// would make a legend swatch look like a status signal.
//
// Ordered (not just curated) so that *adjacent* indices alternate hue family
// and lightness — index i and i+1 are always visually distinct. This matters
// because colors are assigned by an item's fixed position (see buildColorMap),
// not by hashing its key: a hash can and will place two items that appear
// together in the same chart on two near-identical shades by chance, which is
// what actually made an earlier pass look muddy rather than sleek.
const ORDERED_PALETTE = [
  "#B65A3A", // terracotta
  "#4E6575", // steel blue
  "#8B6A45", // bronze
  "#738A5A", // olive
  "#8F8A83", // stone
  "#3A4E5C", // steel blue, darker
  "#96492E", // terracotta, darker
  "#5C7047", // olive, darker
  "#6E5537", // bronze, darker
  "#726E68", // stone, darker
];

// Assigns colors by each key's position in a caller-supplied, stable order
// (e.g. a section's line items sorted by their fixed item_no) rather than by
// hashing the key. This guarantees items shown together in one chart get
// maximally distinct adjacent colors, while every chart that's handed the
// same canonical order still colors the same item identically.
export function buildColorMap(orderedKeys: string[]): Map<string, string> {
  const map = new Map<string, string>();
  orderedKeys.forEach((key, i) => {
    if (!map.has(key)) map.set(key, ORDERED_PALETTE[i % ORDERED_PALETTE.length]);
  });
  return map;
}

interface NamedAmount {
  line_key: string;
  line_label: string;
  amount: number;
  percent: number | null;
}

// Buckets long tails into an "Other" slice — for donuts/treemaps/mirrored-bars
// only, never for the table or stacked-area, which must show everything.
export function topNWithOthers<T extends NamedAmount>(items: T[], n = 7): NamedAmount[] {
  const sorted = [...items].sort((a, b) => b.amount - a.amount);
  if (sorted.length <= n) return sorted;
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n);
  const otherAmount = rest.reduce((sum, i) => sum + i.amount, 0);
  const otherPercent = rest.every((i) => i.percent !== null)
    ? rest.reduce((sum, i) => sum + (i.percent ?? 0), 0)
    : null;
  return [...top, { line_key: "__other__", line_label: "Other", amount: otherAmount, percent: otherPercent }];
}
