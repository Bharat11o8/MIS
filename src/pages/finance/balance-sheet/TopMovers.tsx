import { useMemo, useState } from "react";
import { TrendingUp, TrendingDown, Landmark, Building2 } from "lucide-react";
import { itemDelta } from "../aggregate";
import { formatPct, deltaColor, SOURCES_COLOR, APPLICATION_COLOR, SUCCESS_COLOR, DANGER_COLOR } from "../format";
import type { LineItem } from "./types";
import Sparkline from "../shared/Sparkline";

type Mode = "mom" | "yoy";

interface Mover {
  line_key: string;
  line_label: string;
  section: "sources" | "application";
  pct: number;
  amounts: number[];
}

function buildMovers(items: LineItem[], section: "sources" | "application", mode: Mode): { movers: Mover[]; excluded: number } {
  const movers: Mover[] = [];
  let excluded = 0;
  for (const item of items) {
    if (item.entity_type !== "line_item") continue;
    const d = itemDelta(item.series, mode);
    if (d.reason === "non_positive_base") { excluded++; continue; }
    if (d.pct === null) continue;
    movers.push({ line_key: item.line_key, line_label: item.line_label, section, pct: d.pct, amounts: item.series.map((p) => p.amount) });
  }
  return { movers, excluded };
}

function MoverRow({ mover }: { mover: Mover }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-gray-50 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
          style={{
            background: mover.section === "sources" ? "#EDF1F2" : "#F5EFE7",
            color: mover.section === "sources" ? SOURCES_COLOR : APPLICATION_COLOR,
          }}
        >
          {mover.section === "sources" ? <Landmark size={12} /> : <Building2 size={12} />}
        </span>
        <span className="text-xs font-medium text-gray-700 truncate">{mover.line_label}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <Sparkline values={mover.amounts} width={48} height={18} color={deltaColor(mover.pct)} />
        <span className="text-xs font-bold w-14 text-right" style={{ color: deltaColor(mover.pct) }}>{formatPct(mover.pct)}</span>
      </div>
    </div>
  );
}

interface TopMoversProps {
  sourcesItems: LineItem[];
  applicationItems: LineItem[];
}

export default function TopMovers({ sourcesItems, applicationItems }: TopMoversProps) {
  const [mode, setMode] = useState<Mode>("mom");

  const { gainers, decliners, empty, excluded } = useMemo(() => {
    const sources = buildMovers(sourcesItems, "sources", mode);
    const application = buildMovers(applicationItems, "application", mode);
    const all = [...sources.movers, ...application.movers];
    const gainers = [...all].filter((m) => m.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 5);
    const decliners = [...all].filter((m) => m.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 5);
    return { gainers, decliners, empty: all.length === 0, excluded: sources.excluded + application.excluded };
  }, [sourcesItems, applicationItems, mode]);

  return (
    <div className="card-premium p-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800">Top Movers</h3>
          <p className="text-[11px] text-gray-400">Line items with the largest period-over-period change</p>
        </div>
        <div className="flex items-center bg-gray-100 rounded-xl p-1">
          {([["mom", "MoM"], ["yoy", "YoY"]] as [Mode, string][]).map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${mode === m ? "bg-white text-orange-500 shadow-sm" : "text-gray-500"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {empty ? (
        <div className="py-6 text-center text-sm text-gray-400">Not enough history yet to compute movers.</div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 mb-1" style={{ color: SUCCESS_COLOR }}><TrendingUp size={11} /> Top Gainers</p>
              {gainers.length === 0 ? <p className="text-xs text-gray-400 py-2">None this period.</p> : gainers.map((m) => <MoverRow key={`${m.section}-${m.line_key}`} mover={m} />)}
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 mb-1" style={{ color: DANGER_COLOR }}><TrendingDown size={11} /> Top Decliners</p>
              {decliners.length === 0 ? <p className="text-xs text-gray-400 py-2">None this period.</p> : decliners.map((m) => <MoverRow key={`${m.section}-${m.line_key}`} mover={m} />)}
            </div>
          </div>
          {excluded > 0 && (
            <p className="text-[10px] text-gray-400 mt-4 pt-3 border-t border-gray-50">
              {excluded} item{excluded > 1 ? "s" : ""} not ranked — their prior value was zero or negative, so % change isn't meaningful. See the table below for the rupee change.
            </p>
          )}
        </>
      )}
    </div>
  );
}
