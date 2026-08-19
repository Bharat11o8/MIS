// Types, ranking metadata and formatting helpers for the Dealers tab — the
// dealer-centric half of the OE Network module. Every other tab is keyed on the
// rep; this one is keyed on the dealership, which is how the OE team's own file
// is keyed and how leadership asks its questions.
// KPI (the StatCard colour roles) lives in ../shared and is used module-wide;
// re-exported here so the dealer components keep one import.
export { KPI, categoryLabel } from "../shared";

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
 *
 * oem_total is nullable for a bigger reason than a missing cell: not every OEM
 * publishes one. TATA's tab gives a target and an achievement and never says
 * how much the dealer sold, so for TATA the whole funnel is unavailable rather
 * than zero — hence `Capabilities.funnel`, which decides whether a panel built
 * on these figures is drawn at all. Never render a null here as 0.
 */
export interface Funnel {
  oem_total: number | null; ysasc: number | null; ys_sale: number;
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
  /** The DEALERSHIP this outlet belongs to. On the OEMs whose file is keyed per
   *  dealer code, several rows share one: they are separate outlets with
   *  separate targets, but one physical dealership that was visited once. Every
   *  contact figure on those rows is the group's, so anything totalling
   *  activity must count each group_key once. */
  group_key: string;
  contacts: number; visits: number; calls: number; last_contact: string | null;
  target: number | null; achievement: number | null;
  /** What we sold inside the quarters this period touches — the progress figure
   *  for an OEM that publishes a quarter target but no achievement column. */
  sold: number | null;
  has_sales: boolean;
}

/** What the OEMs currently in scope actually publish, so the tab can draw the
 *  panels their data supports instead of a screenful of blanks.
 *
 *  `funnel` is an AND across the scope: with a funnel OEM and a non-funnel one
 *  both in view there is no honest network penetration to show, because half
 *  the denominator does not exist. */
export interface Capabilities { funnel: boolean; products: string[]; oems: number }
export interface DealerSpRow extends Funnel {
  salesperson: string; assigned: number; contacted: number; coverage: number | null;
  visits: number; calls: number; target: number; achievement: number; sold: number;
}
/** One product's line of a quarter: what was targeted, what the file reported,
 *  and what we actually sold in that quarter's months. */
export interface QuarterProduct {
  product: string; target: number | null;
  achievement: number | null; sold: number | null;
}
/** A month with no sales rows still appears for its contacts, so every figure
 *  is nullable here even though it isn't on the dealer rows. */
export type DealerMonth = Partial<Funnel> & {
  month: string; visits: number; calls: number;
};
export type DealerQuarter = Partial<Funnel> & {
  quarter: string; fy_year: number; label: string; period_start: string; period_end: string;
  target: number | null; achievement: number | null; sold: number;
  /** Always present, with one entry for an OEM that sets a single target — so
   *  the panel never has to know which kind of file it is looking at. */
  by_product: QuarterProduct[];
};
export interface ContactBucket extends Funnel {
  bucket: string; dealer_months: number;
}
export interface DealerPerf {
  period: { month_from: string | null; month_to: string | null; date_from: string | null; date_to: string | null };
  capabilities: Capabilities;
  kpis: Funnel & {
    /** Dealerships (groups), which is what coverage is a share of. `outlets` is
     *  the number of rows in `dealers` — larger wherever one dealership is
     *  listed under several codes. */
    dealers: number; outlets: number; contacted: number; coverage: number | null;
    /** Whole-OEM penetration for the period — the yardstick "vs Average" is
     *  measured against. Unaffected by the rep/state filters, unlike
     *  `penetration` above, which is this view's own figure. */
    benchmark: number | null;
    benchmark_share: number | null;
    visits: number; calls: number;
    target: number; achievement: number | null; sold: number;
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
  /** What this dealer's OEM publishes, judged across ALL its months. The drawer
   *  renders the tile set the source can fill, the same way the tab does — a
   *  TATA dealer has no Total sold, YSASC or Penetration in any month, so those
   *  tiles are absent rather than dashed. */
  capabilities: { funnel: boolean };
  dealer: PerfDealer & { source: string; dealer_code: string | null };
  /** Every product on record for this dealer, unfiltered by the tab's product
   *  filter — the drawer says what they buy from us, all of it. */
  by_product: { product: string; ys_sale: number; oem_total: number | null; ysasc: number | null }[];
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
    product: string;
    target: number | null; achievement: number | null; sold: number | null;
  }[];
  last_field_note: PerfContact | null;
  history: PerfContact[];
}

/** A whole unit count for display.
 *
 *  Rounds, because one figure behind this tab is NOT whole in the source: the
 *  dealer file's quarterly target is an OEM total split across dealers by
 *  share, so a dealer's own target is 32.76036 seat covers. The API sends it at
 *  full precision on purpose — totals are summed unrounded and rounded once, so
 *  the headline matches the sheet's own total row — and the rounding belongs
 *  here, at the last possible moment. Rounding earlier moved the MSIL JAS'26
 *  total 27 units off the sheet. Every other figure these format is already a
 *  whole count, so this is a no-op for them. */
export const n0 = (n: number | null | undefined) => Math.round(n ?? 0).toLocaleString("en-IN");
/** For a figure the source may genuinely not publish. `n0` reads a null as 0,
 *  which is right for our own sales and wrong for anything else — an em dash
 *  says "not supplied", a 0 says "sold none", and they are not the same claim. */
export const nOr = (n: number | null | undefined) =>
  (n == null ? "—" : Math.round(n).toLocaleString("en-IN"));
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);
/** Achievement as a share of target. Null when there is no target to divide by:
 *  a dealer with no target has not missed one. */
export const hitPct = (ach: number | null | undefined, tgt: number | null | undefined) =>
  tgt ? Math.round(((ach ?? 0) / tgt) * 100) : null;

/** Rankings a dealer list can be read by. `gap` is the one that matters most:
 *  how far this dealer sits from what the network average would predict — it
 *  puts a big dealer at 2% penetration below a small one at 0%.
 *
 *  ── The sign convention, which is the whole point ──
 *  On every signed metric here, and everywhere else in this module,
 *  **`+` means we are doing well and is green; `−` means we are behind and is
 *  red.** No exceptions, because a reader who learns the convention on one
 *  screen applies it to the next, and this module used to hold both readings at
 *  once: the Targets tab had a Gap where + meant ahead while this tab had an
 *  Opp. where + meant behind. Nothing looked broken — the number was simply
 *  inverted between two tabs of the same module.
 *
 *  That is also why these are named "vs Average" and "vs Target" rather than
 *  "Opportunity" and "Behind target". A name that states a DIRECTION pins the
 *  sign to it: "Opportunity +500" can only mean 500 units of upside, so once +
 *  means ahead the old name fights the number. "vs X" is neutral and lets the
 *  sign carry the meaning.
 *
 *  Each ranking still says what BOTH of its ends mean, because for a signed
 *  metric the bottom is not "the worst" in the way a reader assumes — it is the
 *  list to WORK, which is the more useful end and the one the table opens on.
 *
 *  `floor` marks the rankings whose bottom end is meaningless without a volume
 *  cut-off: sorted by a ratio, the worst dealers are simply the smallest ones.
 *  The signed metrics need no floor — they already scale with volume, so a
 *  small dealer cannot produce a big figure in either direction. */
export type RankMetric =
  | "ys_sale" | "penetration" | "gap" | "oem_total" | "addressable_pct" | "tgt_gap";

/** Which rankings a scope can actually answer. The funnel ones divide by
 *  figures a non-funnel OEM never publishes, so offering them there would put a
 *  column of dashes behind a picker that looks like it should work. */
export const RANK_METRICS = (funnel: boolean): RankMetric[] =>
  funnel
    ? ["gap", "ys_sale", "penetration", "oem_total", "addressable_pct"]
    : ["tgt_gap", "ys_sale"];
export const RANK_META: Record<RankMetric, {
  label: string; what: string; top: string; bottom: string; floor: boolean;
  /** Runs positive AND negative, with + meaning ahead. Drives the colour of the
   *  figure and which end of the list the table opens on — for these the useful
   *  default is the BOTTOM, because that is where the work is. */
  signed?: boolean;
}> = {
  gap: {
    label: "vs Average",
    what: "units above or below what the OEM average would predict for this dealer — "
      + "what we actually sell them, minus their YSASC × the average penetration. "
      + "Measured on the addressable figure, so a dealer is never charged for cars "
      + "we make no part for",
    top: "the dealers furthest AHEAD of the average — where we're already "
      + "outperforming. Not a problem list: these are the ones to protect, and "
      + "to copy.",
    bottom: "the dealers furthest BEHIND the average. This is the list to work: "
      + "the units are there and we aren't getting them. Their figure is negative "
      + "because they fall short of the benchmark.",
    floor: false,
    signed: true,
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
  tgt_gap: {
    label: "vs Target",
    what: "what we have actually sold this dealer inside the quarter so far, minus the "
      + "quarter target they were set. The target is the whole quarter's and is never "
      + "pro-rated, so part-way through a quarter a negative figure is expected — read "
      + "it against how much of the quarter has gone",
    top: "the dealers already PAST their target, furthest first. Not a problem list.",
    bottom: "the dealers furthest behind their own target in units. The biggest "
      + "shortfalls, which is where the quarter is won or lost.",
    floor: false,
    signed: true,
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
  // Both signed metrics are written ACTUAL minus EXPECTED, never the other way
  // round, so + always reads "we sold more than expected". Reversing either one
  // makes two tabs of one module disagree about what a plus sign means, which
  // is the exact confusion this ordering exists to prevent.
  //
  // Only meaningful against the addressable base; a dealer with no YSASC has no
  // predictable figure and sorts as zero rather than as a fabricated one.
  if (m === "gap") return d.ys_sale - (d.ysasc ?? 0) * (avgPene / 100);
  // Same shape for the OEMs with no funnel: measured against a number somebody
  // actually agreed to, rather than against a modelled average.
  if (m === "tgt_gap") return (d.sold ?? d.ys_sale) - (d.target ?? 0);
  if (m === "penetration") return d.penetration ?? 0;
  if (m === "addressable_pct") return d.addressable_pct ?? 0;
  return m === "ys_sale" ? d.ys_sale : d.oem_total ?? 0;
};
