// Shared shape of GET /finance/analytics?statement=profit_loss

export interface SeriesPoint {
  period_start_date: string;
  period_end_date: string;
  amount: number;
  percent: number | null;
}

export interface LineItem {
  line_key: string;
  line_label: string;
  item_no: number | null;
  section: string; // "trading_account" | "income_statement"
  entity_type: string; // "line_item" | "detail" | "subtotal" | "total"
  parent_key: string | null;
  series: SeriesPoint[];
}

// Backend initializes headline entries as bare { series: [] } when a sheet has
// no Gross/Nett Profit row, so every field except series may be absent.
export interface HeadlineItem extends Partial<Omit<LineItem, "series">> {
  series: SeriesPoint[];
}

export interface Section {
  line_items: LineItem[];
  subtotals: LineItem[];
}

export interface FyRow {
  line_key: string;
  line_label: string;
  section: string;
  period_start_date: string;
  period_end_date: string;
  amount: number;
  percent: number | null;
}

export interface PlAnalytics {
  kpis: {
    sales_accounts_total: number;
    gross_profit_total: number;
    nett_profit_total: number;
    mom_growth: number | null; mom_period: string | null;
    qoq_growth: number | null; qoq_period: string | null;
    yoy_growth: number | null; yoy_period: string | null;
    yoy_fy_growth: number | null; yoy_fy_period: string | null;
  };
  sections: { trading_account: Section; income_statement: Section };
  headline: { gross_profit: HeadlineItem; nett_profit: HeadlineItem };
  fy_to_date: FyRow[];
}
