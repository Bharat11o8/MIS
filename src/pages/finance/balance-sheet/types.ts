// Shared shape of GET /finance/analytics?statement=balance_sheet

export interface SeriesPoint {
  period_end_date: string;
  amount: number;
  percent: number | null;
}

export interface LineItem {
  line_key: string;
  line_label: string;
  item_no: number | null;
  entity_type: string; // "line_item" | "detail"
  parent_key: string | null;
  series: SeriesPoint[];
}

export interface Section {
  line_items: LineItem[];
  total: { line_key: string | null; series: SeriesPoint[] };
}

export interface BsAnalytics {
  kpis: {
    sources_total_latest: number | null;
    application_total_latest: number | null;
    mom_delta_pct: number | null;
    mom_period: string | null;
    qoq_delta_pct: number | null;
    qoq_period: string | null;
    yoy_delta_pct: number | null;
    yoy_period: string | null;
  };
  sections: { sources_of_funds: Section; application_of_funds: Section };
}
