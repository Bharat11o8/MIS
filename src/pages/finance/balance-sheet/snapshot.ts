import { latestOnOrBefore, topNWithOthers } from "../aggregate";
import type { LineItem } from "./types";

export interface SnapshotItem {
  line_key: string;
  line_label: string;
  amount: number;
  percent: number | null;
}

// Resolves each top-level line item's value as of (on or before) the picked
// period — items that don't exist yet at that point in the sheet's history
// are simply omitted, never fabricated as zero.
export function sectionSnapshot(lineItems: LineItem[], pickedPeriod: string): SnapshotItem[] {
  const items: SnapshotItem[] = [];
  for (const item of lineItems) {
    if (item.entity_type !== "line_item") continue;
    const point = latestOnOrBefore(item.series, pickedPeriod);
    if (!point) continue;
    items.push({ line_key: item.line_key, line_label: item.line_label, amount: point.amount, percent: point.percent });
  }
  return items;
}

export interface NegativeSummary {
  count: number;
  total: number;
}

export interface CompositionSnapshot {
  items: SnapshotItem[];
  negative: NegativeSummary;
}

// A pie slice / treemap rectangle / percentage-width bar can't represent a
// negative value geometrically. Rather than silently flooring a negative
// item to zero (invisible, no explanation) or letting it corrupt the
// proportion denominator for everything else, we exclude negative items from
// the proportional set entirely and report them separately so callers can
// disclose exactly what's been left out.
export function sectionSnapshotTopN(lineItems: LineItem[], pickedPeriod: string, n = 7): CompositionSnapshot {
  const all = sectionSnapshot(lineItems, pickedPeriod);
  const positive = all.filter((i) => i.amount >= 0);
  const negativeItems = all.filter((i) => i.amount < 0);
  return {
    items: topNWithOthers(positive, n),
    negative: { count: negativeItems.length, total: negativeItems.reduce((s, i) => s + i.amount, 0) },
  };
}
