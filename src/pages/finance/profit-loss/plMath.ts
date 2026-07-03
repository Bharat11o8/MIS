// P&L-specific derivations. Everything here does arithmetic only on the
// sheet's own verbatim rows (Sales Accounts, the synthesized subtotals,
// Gross Profit, Nett Profit) — line items are never summed into a figure the
// sheet doesn't itself state, because they aren't reliably additive (e.g. the
// dummy sheet's "Cost of Sales" already contains "Direct Expenses").

import { bucketFlowSeries, TrendView } from "../aggregate";
import type { LineItem, HeadlineItem, PlAnalytics, Section, SeriesPoint } from "./types";

// Same normalization the backend applies before label-matching.
export function normLabel(s: string): string {
  return s.trim().toUpperCase().replace(/:+$/, "").trim();
}

export function findSalesItem(trading: Section): LineItem | null {
  return trading.line_items.find((i) => normLabel(i.line_label) === "SALES ACCOUNTS") ?? null;
}

// A P&L amount is a flow for one specific month — exact match only, never
// "latest on or before" (that would silently substitute a different month).
export function amountAt(series: SeriesPoint[], periodEnd: string): number | null {
  const point = series.find((p) => p.period_end_date === periodEnd);
  return point ? point.amount : null;
}

// ── Margins ──────────────────────────────────────────────────────────────────

export interface MarginBucket {
  period: string;
  pct: number | null; // null when the denominator bucket is missing or <= 0
}

// Per-bucket margin = sum(numerator within bucket) / sum(denominator within
// bucket) — never an average of monthly margins, which would be wrong math.
export function marginSeries(numer: SeriesPoint[], denom: SeriesPoint[], view: TrendView): MarginBucket[] {
  const numBuckets = bucketFlowSeries(numer, view);
  const denBuckets = bucketFlowSeries(denom, view);
  const numByPeriod = new Map(numBuckets.map((b) => [b.period, b.amount]));
  return denBuckets.map((d) => {
    const n = numByPeriod.get(d.period);
    return {
      period: d.period,
      pct: n !== undefined && d.amount > 0 ? (n / d.amount) * 100 : null,
    };
  });
}

// ── Anchor discovery ─────────────────────────────────────────────────────────

const SUBTOTAL_MARKER = "_subtotal_after_";

export function subtotalAnchorKey(subtotal: LineItem): string | null {
  const idx = subtotal.line_key.indexOf(SUBTOTAL_MARKER);
  return idx === -1 ? null : subtotal.line_key.slice(idx + SUBTOTAL_MARKER.length);
}

// The section's "revenue subtotal": the synthesized subtotal that closes the
// income block at the top of the section — mechanically, the one whose
// after_{key} anchor is a top-level numbered line item (the stock-movement
// subtotal inside Cost of Sales is anchored to a detail row instead). If
// several qualify, the one with the earliest anchor wins.
export function revenueSubtotal(section: Section): LineItem | null {
  let best: LineItem | null = null;
  let bestItemNo = Infinity;
  for (const sub of section.subtotals) {
    const anchorKey = subtotalAnchorKey(sub);
    if (!anchorKey) continue;
    const anchor = section.line_items.find(
      (i) => i.line_key === anchorKey && i.entity_type === "line_item" && i.item_no !== null,
    );
    if (anchor && (anchor.item_no as number) < bestItemNo) {
      best = sub;
      bestItemNo = anchor.item_no as number;
    }
  }
  return best;
}

// ── Profit bridge (anchor-based waterfall) ──────────────────────────────────

export interface BridgeStep {
  key: string;
  label: string;
  kind: "anchor" | "up" | "down";
  anchorId?: "sales" | "gross_profit" | "nett_profit";
  base: number;   // invisible stacked base so the visible bar floats
  value: number;  // visible bar height (always >= 0)
  signed: number; // the actual signed figure this bar represents
}

export interface ProfitBridge {
  steps: BridgeStep[];
  // true when a section had to collapse to a single net step because its
  // revenue subtotal was missing or didn't reconcile with the anchors
  degradedTrading: boolean;
  degradedIncome: boolean;
}

function relTolerance(sales: number): number {
  return 0.005 * Math.max(Math.abs(sales), 1);
}

export function buildProfitBridge(data: PlAnalytics, periodEnd: string): ProfitBridge | null {
  const salesItem = findSalesItem(data.sections.trading_account);
  const sales = salesItem ? amountAt(salesItem.series, periodEnd) : null;
  const gp = amountAt(data.headline.gross_profit.series, periodEnd);
  const np = amountAt(data.headline.nett_profit.series, periodEnd);
  if (sales === null || gp === null || np === null) return null;

  const tol = relTolerance(sales);

  const sub1Item = revenueSubtotal(data.sections.trading_account);
  const sub1 = sub1Item ? amountAt(sub1Item.series, periodEnd) : null;
  // Valid split: other trading income (sub1 − sales) and direct costs
  // (sub1 − gp) must both be genuine non-negative magnitudes.
  const splitTrading = sub1 !== null && sub1 - sales >= -tol && sub1 - gp >= -tol;

  const sub2Item = revenueSubtotal(data.sections.income_statement);
  const sub2 = sub2Item ? amountAt(sub2Item.series, periodEnd) : null;
  const splitIncome = sub2 !== null && sub2 - gp >= -tol && sub2 - np >= -tol;

  const steps: BridgeStep[] = [];
  let running = 0;

  const anchor = (key: BridgeStep["anchorId"], label: string, v: number) => {
    steps.push({
      key: `anchor-${key}`, label, kind: "anchor", anchorId: key,
      base: Math.min(0, v), value: Math.abs(v), signed: v,
    });
    running = v;
  };
  const step = (key: string, label: string, delta: number) => {
    const next = running + delta;
    steps.push({
      key, label,
      kind: delta >= 0 ? "up" : "down",
      base: Math.min(running, next),
      value: Math.abs(delta),
      signed: delta,
    });
    running = next;
  };

  anchor("sales", "Sales", sales);
  if (splitTrading) {
    step("other-trading-income", "Other trading income", (sub1 as number) - sales);
    step("direct-costs", "Direct costs", gp - (sub1 as number));
  } else {
    step("direct-costs-net", "Direct costs (net)", gp - sales);
  }
  anchor("gross_profit", "Gross Profit", gp);
  if (splitIncome) {
    step("indirect-income", "Indirect income", (sub2 as number) - gp);
    step("indirect-costs", "Indirect costs", np - (sub2 as number));
  } else {
    step("indirect-net", "Indirect items (net)", np - gp);
  }
  anchor("nett_profit", "Nett Profit", np);

  return { steps, degradedTrading: !splitTrading, degradedIncome: !splitIncome };
}

// ── Indirect expense breakdown ───────────────────────────────────────────────

export interface ExpenseSlice {
  line_key: string;
  line_label: string;
  amount: number;
  percent: number | null;
}

// The income-statement deduction items for one month: numbered line items
// sitting between the section's revenue subtotal anchor and the Nett Profit
// row. Only trustworthy when they reconcile with the sheet's own anchors
// (sum ≈ subtotal − Nett Profit) — callers must hide the chart otherwise.
export function indirectExpenseBreakdown(data: PlAnalytics, periodEnd: string): { slices: ExpenseSlice[]; reconciles: boolean } | null {
  const section = data.sections.income_statement;
  const subItem = revenueSubtotal(section);
  const np = data.headline.nett_profit;
  if (!subItem || np.item_no === null || np.item_no === undefined) return null;

  const anchorKey = subtotalAnchorKey(subItem);
  const anchor = section.line_items.find((i) => i.line_key === anchorKey);
  if (!anchor || anchor.item_no === null) return null;

  const sub = amountAt(subItem.series, periodEnd);
  const npAmount = amountAt(np.series, periodEnd);
  if (sub === null || npAmount === null) return null;

  const slices: ExpenseSlice[] = [];
  for (const item of section.line_items) {
    if (item.entity_type !== "line_item" || item.item_no === null) continue;
    if (item.item_no <= anchor.item_no || item.item_no >= np.item_no) continue;
    const point = item.series.find((p) => p.period_end_date === periodEnd);
    if (!point) continue;
    slices.push({ line_key: item.line_key, line_label: item.line_label, amount: point.amount, percent: point.percent });
  }
  if (slices.length === 0) return null;

  const expected = sub - npAmount;
  const total = slices.reduce((s, i) => s + i.amount, 0);
  const reconciles = Math.abs(total - expected) <= relTolerance(expected);
  return { slices, reconciles };
}

// ── Sheet-order row layout for the detail table ──────────────────────────────

export interface OrderedRow {
  item: LineItem | HeadlineItem;
  depth: 0 | 1;
  kind: "line_item" | "detail" | "subtotal" | "headline";
}

// Reconstructs the sheet's true interleaved row order: numbered items (and the
// section's Gross/Nett Profit headline at its own item_no position), each
// subtotal re-inserted right after its after_{key} anchor row, detail rows
// nested under their parent.
export function buildSheetOrderedRows(section: Section, headline: HeadlineItem | null): OrderedRow[] {
  const topLevel: (LineItem | HeadlineItem)[] = section.line_items.filter(
    (i) => i.entity_type === "line_item" && i.item_no !== null,
  );
  if (headline && headline.item_no !== null && headline.item_no !== undefined) topLevel.push(headline);
  topLevel.sort((a, b) => (a.item_no ?? 0) - (b.item_no ?? 0));

  const detailsByParent = new Map<string, LineItem[]>();
  for (const item of section.line_items) {
    if (item.entity_type !== "detail") continue;
    const key = item.parent_key ?? "__orphan__";
    if (!detailsByParent.has(key)) detailsByParent.set(key, []);
    detailsByParent.get(key)!.push(item);
  }

  const subtotalsByAnchor = new Map<string, LineItem[]>();
  for (const sub of section.subtotals) {
    const anchorKey = subtotalAnchorKey(sub) ?? "__unanchored__";
    if (!subtotalsByAnchor.has(anchorKey)) subtotalsByAnchor.set(anchorKey, []);
    subtotalsByAnchor.get(anchorKey)!.push(sub);
  }

  const rows: OrderedRow[] = [];
  const usedSubtotals = new Set<string>();
  const usedDetails = new Set<string>();

  const pushSubtotalsFor = (anchorKey: string | undefined) => {
    if (!anchorKey) return;
    for (const sub of subtotalsByAnchor.get(anchorKey) ?? []) {
      rows.push({ item: sub, depth: 0, kind: "subtotal" });
      usedSubtotals.add(sub.line_key);
    }
  };

  for (const item of topLevel) {
    rows.push({ item, depth: 0, kind: item === headline ? "headline" : "line_item" });
    for (const child of detailsByParent.get(item.line_key ?? "") ?? []) {
      rows.push({ item: child, depth: 1, kind: "detail" });
      usedDetails.add(child.line_key);
      pushSubtotalsFor(child.line_key);
    }
    pushSubtotalsFor(item.line_key);
  }

  // Anything the walk didn't place (orphaned details, unanchored subtotals)
  // still has to appear rather than silently vanish.
  for (const item of section.line_items) {
    if (item.entity_type === "detail" && !usedDetails.has(item.line_key)) {
      rows.push({ item, depth: 1, kind: "detail" });
    }
  }
  for (const sub of section.subtotals) {
    if (!usedSubtotals.has(sub.line_key)) rows.push({ item: sub, depth: 0, kind: "subtotal" });
  }
  return rows;
}
