import { Landmark, Building2, TrendingUp, TrendingDown, Scale, CheckCircle2, AlertTriangle } from "lucide-react";
import { formatINR, formatPct, deltaColor, SOURCES_COLOR, APPLICATION_COLOR, SUCCESS_COLOR, DANGER_COLOR } from "../format";
import type { BsAnalytics, SeriesPoint } from "./types";
import BalanceGapSparkline from "./BalanceGapSparkline";
import { formatPeriodLabel } from "../shared/PeriodPicker";

const NEUTRAL_CARD_BG = "#F5F0E8"; // sand wash — shared by MoM/QoQ/YoY, direction is carried by icon/text color instead
const SUCCESS_BG = "#EDF4EE";
const DANGER_BG = "#F7EBE9";

interface HeroKpiRowProps {
  kpis: BsAnalytics["kpis"];
  sourcesSeries: SeriesPoint[];
  applicationSeries: SeriesPoint[];
}

function DeltaIcon({ v }: { v: number | null }) {
  if (v !== null && v < 0) return <TrendingDown size={18} />;
  return <TrendingUp size={18} />;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Backend period labels are either "YYYY-MM-DD → YYYY-MM-DD" (mom/yoy) or
// already-short "Q4 FY26 → Q1 FY27" (qoq). Shorten the ISO form so it never
// forces a narrow KPI card wider than its grid cell.
function shortenPeriod(s: string | null): string | null {
  if (!s) return s;
  const parts = s.split(" → ");
  if (parts.length !== 2 || !ISO_DATE.test(parts[0].trim()) || !ISO_DATE.test(parts[1].trim())) return s;
  return `${formatPeriodLabel(parts[0].trim())} → ${formatPeriodLabel(parts[1].trim())}`;
}

export default function HeroKpiRow({ kpis, sourcesSeries, applicationSeries }: HeroKpiRowProps) {
  const sources = kpis.sources_total_latest;
  const application = kpis.application_total_latest;

  let balanceLabel = "—";
  let balanced = true;
  let balancePctAbs = 0;
  if (sources !== null && application !== null && sources !== 0) {
    const diff = sources - application;
    balancePctAbs = Math.abs((diff / sources) * 100);
    balanced = balancePctAbs < 0.5;
    balanceLabel = balanced ? "Balanced" : `Off by ${formatINR(Math.abs(diff))} (${balancePctAbs.toFixed(1)}%)`;
  }

  // Trust sparkline: zip both totals by matching period_end_date, show the diff over time.
  const appByDate = new Map(applicationSeries.map((p) => [p.period_end_date, p.amount]));
  const diffSeries = sourcesSeries
    .filter((p) => appByDate.has(p.period_end_date))
    .map((p) => p.amount - (appByDate.get(p.period_end_date) as number));

  const cards = [
    {
      id: "bs-sources", label: "Total Sources of Funds",
      value: sources !== null ? formatINR(sources) : "—",
      icon: <Landmark size={18} />, color: SOURCES_COLOR, bg: "#EDF1F2", big: false,
    },
    {
      id: "bs-application", label: "Total Application of Funds",
      value: application !== null ? formatINR(application) : "—",
      icon: <Building2 size={18} />, color: APPLICATION_COLOR, bg: "#F5EFE7", big: false,
    },
    {
      id: "bs-mom", label: "MoM Change", value: formatPct(kpis.mom_delta_pct),
      icon: <DeltaIcon v={kpis.mom_delta_pct} />, color: deltaColor(kpis.mom_delta_pct), bg: NEUTRAL_CARD_BG,
      sub: shortenPeriod(kpis.mom_period), big: true,
    },
    {
      id: "bs-qoq", label: "QoQ Change", value: formatPct(kpis.qoq_delta_pct),
      icon: <DeltaIcon v={kpis.qoq_delta_pct} />, color: deltaColor(kpis.qoq_delta_pct), bg: NEUTRAL_CARD_BG,
      sub: shortenPeriod(kpis.qoq_period), big: true,
    },
    {
      id: "bs-yoy", label: "YoY Change", value: formatPct(kpis.yoy_delta_pct),
      icon: <DeltaIcon v={kpis.yoy_delta_pct} />, color: deltaColor(kpis.yoy_delta_pct), bg: NEUTRAL_CARD_BG,
      sub: shortenPeriod(kpis.yoy_period), big: true,
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

      <div className="kpi-card relative overflow-hidden">
        <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: balanced ? SUCCESS_COLOR : DANGER_COLOR }} />
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: balanced ? SUCCESS_BG : DANGER_BG, color: balanced ? SUCCESS_COLOR : DANGER_COLOR }}>
          {balanced ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
        </div>
        <div className="mt-3 flex items-start justify-between gap-2 min-w-0">
          <div className="min-w-0">
            <p className="text-sm font-black tabular-nums" style={{ color: balanced ? SUCCESS_COLOR : DANGER_COLOR }}>{balanceLabel}</p>
            <p className="text-xs font-bold text-gray-500 mt-0.5 flex items-center gap-1"><Scale size={11} /> Balance Check</p>
          </div>
          {diffSeries.length >= 2 && (
            <div className="flex flex-col items-end gap-0.5 shrink-0">
              <BalanceGapSparkline values={diffSeries} width={56} height={24} />
              <p className="text-[9px] text-gray-300 whitespace-nowrap">Sources − Application</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
