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
