import { IndianRupee, Coins, PiggyBank, TrendingUp, TrendingDown } from "lucide-react";
import { formatINR, formatPct, deltaColor, REVENUE_COLOR, GROSS_PROFIT_COLOR, NETT_PROFIT_COLOR } from "../format";
import type { PlAnalytics } from "./types";

const NEUTRAL_CARD_BG = "#F5F0E8"; // sand wash — direction is carried by icon/text color instead
const REVENUE_BG = "#EDF1F2";
const GROSS_BG = "#EFF2E9";
const NETT_BG = "#F5EFE7";

function DeltaIcon({ v }: { v: number | null }) {
  if (v !== null && v < 0) return <TrendingDown size={18} />;
  return <TrendingUp size={18} />;
}

function marginLine(name: string, total: number, sales: number): string | undefined {
  if (sales <= 0) return undefined;
  return `${name} margin ${((total / sales) * 100).toFixed(1)}%`;
}

export default function PlHeroKpiRow({ kpis }: { kpis: PlAnalytics["kpis"] }) {
  const sales = kpis.sales_accounts_total;

  const cards = [
    {
      id: "pl-sales", label: "Total Sales", value: formatINR(sales),
      icon: <IndianRupee size={18} />, color: REVENUE_COLOR, bg: REVENUE_BG,
      sub: "All synced months", big: false,
    },
    {
      id: "pl-gross", label: "Gross Profit", value: formatINR(kpis.gross_profit_total),
      icon: <Coins size={18} />, color: GROSS_PROFIT_COLOR, bg: GROSS_BG,
      sub: marginLine("GP", kpis.gross_profit_total, sales), big: false,
    },
    {
      id: "pl-nett", label: "Nett Profit", value: formatINR(kpis.nett_profit_total),
      icon: <PiggyBank size={18} />, color: NETT_PROFIT_COLOR, bg: NETT_BG,
      sub: marginLine("NP", kpis.nett_profit_total, sales), big: false,
    },
    {
      id: "pl-mom", label: "MoM Sales Growth", value: formatPct(kpis.mom_growth),
      icon: <DeltaIcon v={kpis.mom_growth} />, color: deltaColor(kpis.mom_growth), bg: NEUTRAL_CARD_BG,
      sub: kpis.mom_period, big: true,
    },
    {
      id: "pl-qoq", label: "QoQ Sales Growth", value: formatPct(kpis.qoq_growth),
      icon: <DeltaIcon v={kpis.qoq_growth} />, color: deltaColor(kpis.qoq_growth), bg: NEUTRAL_CARD_BG,
      sub: kpis.qoq_period, big: true,
    },
    {
      id: "pl-yoy-fy", label: "YoY Sales Growth (FY)", value: formatPct(kpis.yoy_fy_growth),
      icon: <DeltaIcon v={kpis.yoy_fy_growth} />, color: deltaColor(kpis.yoy_fy_growth), bg: NEUTRAL_CARD_BG,
      sub: kpis.yoy_fy_period, big: true,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-4">
      {cards.map((kpi) => (
        <div key={kpi.id} className="kpi-card relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: kpi.color }} />
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: kpi.bg, color: kpi.color }}>{kpi.icon}</div>
          <div className="mt-3 min-w-0">
            <p className={`font-black text-gray-900 tabular-nums ${kpi.big ? "text-2xl" : "text-xl"}`}>{kpi.value}</p>
            <p className="text-xs font-bold text-gray-500 mt-0.5">{kpi.label}</p>
            {kpi.sub && <p className="text-[10px] text-gray-400 mt-0.5 truncate" title={kpi.sub}>{kpi.sub}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
