// Types, ranking metadata and formatting helpers for the Dealers tab — the
// dealer-centric half of the OE Network module. Every other tab is keyed on the
// rep; this one is keyed on the dealership, which is how the OE team's own file
// is keyed and how leadership asks its questions.
// KPI (the StatCard colour roles) lives in ../shared and is used module-wide;
// re-exported here so the dealer components keep one import.
export { KPI } from "../shared";

/**
 * The dealer file's funnel, in the OE team's own vocabulary:
 *
 *   oem_total  "Total MSIL" — every seat cover that dealer sold, ours or not
 *   ysasc      "YSASC" (YS Available Seat Covers) — of those, the ones on a
 *              vehicle we hold a part number for. NULL when the source file
 *              predates the three-series format and simply didn't say.
 *   ys_sale    "YS Sale" — what we actually sold them
 *
 * and the three ratios read off it. `penetration` is the headline and its
 * denominator is ysasc, so it is null whenever ysasc is.
 */
export interface Funnel {
  oem_total: number; ysasc: number | null; ys_sale: number;
  /** ys_sale ÷ ysasc — what we converted of what we could have won. */
  penetration: number | null;
  /** ys_sale ÷ oem_total — our slice of the dealer's whole seat-cover business. */
  share: number | null;
  /** ysasc ÷ oem_total — how much of it we make a part for at all. */
  addressable_pct: number | null;
}
export interface PerfDealer extends Funnel {
  id: string; oem: string; name: string; city: string; state: string;
  salesperson: string | null; codes: string | null;
  contacts: number; visits: number; calls: number; last_contact: string | null;
  target: number | null; achievement: number | null; has_sales: boolean;
}
export interface DealerSpRow extends Funnel {
  salesperson: string; assigned: number; contacted: number; coverage: number | null;
  visits: number; calls: number; target: number; achievement: number;
}
/** A month with no sales rows still appears for its contacts, so every figure
 *  is nullable here even though it isn't on the dealer rows. */
export type DealerMonth = Partial<Funnel> & {
  month: string; visits: number; calls: number;
};
export type DealerQuarter = Partial<Funnel> & {
  quarter: string; fy_year: number; label: string; period_start: string; period_end: string;
  target: number | null; achievement: number | null;
};
export interface ContactBucket extends Funnel {
  bucket: string; dealer_months: number;
}
export interface DealerPerf {
  period: { month_from: string | null; month_to: string | null; date_from: string | null; date_to: string | null };
  kpis: Funnel & {
    dealers: number; contacted: number; coverage: number | null;
    /** Whole-OEM penetration for the period — the yardstick Opportunity is
     *  measured against. Unaffected by the rep/state filters, unlike
     *  `penetration` above, which is this view's own figure. */
    benchmark: number | null;
    benchmark_share: number | null;
    visits: number; calls: number; target: number; achievement: number;
  };
  dealers: PerfDealer[];
  by_salesperson: DealerSpRow[];
  by_month: DealerMonth[];
  by_quarter: DealerQuarter[];
  contact_effect: { months: number; buckets: ContactBucket[] };
}
export interface DealerNote { category: string; label: string; text: string; themes: string[] }
export interface PerfContact {
  id: string; visit_date: string | null; salesperson: string; contact_mode: string;
  channel: string | null; contact_person: string | null; designation: string | null;
  car_sales: number | null; seat_cover_sales: number | null; mats_sales: number | null;
  notes: DealerNote[];
}
/** Funnel plus the activity counts and how many months it was summed over. */
export type DealerTotals = Funnel & { visits: number; calls: number; months: number };

export interface DealerDetail {
  dealer: PerfDealer & { source: string };
  /** Scoped to the period the tab is filtered to, so the drawer's headline
   *  figures reconcile with the row that was clicked. */
  totals: DealerTotals;
  /** Every month on record — context, shown underneath. */
  lifetime: DealerTotals;
  period: {
    month_from: string | null; month_to: string | null;
    date_from: string | null; date_to: string | null;
    /** The tab is on "all time", so both scopes are the same figures. */
    all_time: boolean;
  };
  by_month: DealerMonth[];
  targets: {
    quarter: string; fy_year: number; label: string;
    /** Inclusive quarter bounds, so the drawer can keep the quarters that
     *  overlap the selected period — never pro-rated, same rule as the tab. */
    period_start: string; period_end: string;
    target: number | null; achievement: number | null;
  }[];
  last_field_note: PerfContact | null;
  history: PerfContact[];
}

export const n0 = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-IN");
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);

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
export type RankMetric = "ys_sale" | "penetration" | "gap" | "oem_total" | "addressable_pct";
export const RANK_META: Record<RankMetric, {
  label: string; what: string; top: string; bottom: string; floor: boolean;
}> = {
  gap: {
    label: "Opportunity",
    what: "how many units this dealer is short of what the OEM average would predict — "
      + "their YSASC × the average penetration, minus what we actually sell them. "
      + "Measured on the addressable figure, so a dealer is never charged for cars "
      + "we make no part for",
    top: "the dealers furthest BEHIND the average. This is the list to work: "
      + "the units are there and we aren't getting them.",
    bottom: "the dealers furthest AHEAD of the average — where we're already "
      + "outperforming. Not a problem list: these are the ones to protect, and "
      + "to copy. Their Opp. figure is negative because they beat the benchmark.",
    floor: false,
  },
  ys_sale: {
    label: "YS Sale",
    what: "the number of our units the dealer bought in this period",
    top: "our biggest dealers by volume",
    bottom: "the dealers buying least from us",
    floor: true,
  },
  penetration: {
    label: "Penetration",
    what: "YS Sale ÷ YSASC — of the covers this dealer sold that we make a part for, "
      + "the share that was ours. This is a selling number: everything it divides by "
      + "was genuinely winnable",
    top: "where we convert the most of what we could have won",
    bottom: "where we convert the least — the covers were addressable and went elsewhere",
    floor: true,
  },
  oem_total: {
    label: "Total sold",
    what: "every seat cover the dealer sold, ours or anyone's — how big they are",
    top: "the biggest dealerships in the network",
    bottom: "the smallest dealerships",
    floor: false,
  },
  addressable_pct: {
    label: "Addressable %",
    what: "YSASC ÷ Total sold — how much of this dealer's seat-cover business we make a "
      + "part for at all. A LOW number here is a part-number gap, not a rep's "
      + "failure: no amount of selling reaches the rest",
    top: "where our range covers most of what the dealer sells",
    bottom: "where our range covers least — these are product decisions, not sales ones",
    floor: true,
  },
};

export const rankValue = (d: PerfDealer, m: RankMetric, avgPene: number): number => {
  // Opportunity is only meaningful against the addressable base; a dealer with
  // no YSASC has no predictable target and sorts as zero rather than as a
  // fabricated one.
  if (m === "gap") return (d.ysasc ?? 0) * (avgPene / 100) - d.ys_sale;
  if (m === "penetration") return d.penetration ?? 0;
  if (m === "addressable_pct") return d.addressable_pct ?? 0;
  return m === "ys_sale" ? d.ys_sale : d.oem_total;
};
