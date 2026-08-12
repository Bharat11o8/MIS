import { useState } from "react";
import { VISIT_COLOR, CALL_COLOR } from "../shared";
import { type PerfDealer, n0, pct } from "./model";
import Explain from "./Explain";

// The third dot colour: a dealer below the network average that is too small to
// make the priority list. Amber rather than a softer orange so it cannot be
// misread as a faded member of the "work these" set.
const SMALL_BEHIND = "#fbbf24";

/**
 * Volume vs penetration, one dot per dealer.
 *
 * The single view that says WHERE the money is: bottom-right is a dealer who
 * sells a lot of cars and almost none of ours. A ranked list can only answer
 * one question at a time; this answers "big or small" and "in or out" at once,
 * and the eye finds the outliers without reading a single number.
 *
 * The x axis is square-rooted because dealer volume is very long-tailed — a
 * linear axis buries three quarters of the network in the left tenth of the
 * chart. Ticks are drawn at real car-sales values so the compression is
 * visible rather than silently distorting the picture.
 */
export default function DealerMap({ dealers, avgPene, onPick }: {
  dealers: PerfDealer[]; avgPene: number; onPick: (d: PerfDealer) => void;
}) {
  const [hover, setHover] = useState<PerfDealer | null>(null);
  // Plotted against YSASC, not the dealer's whole volume: the y axis is
  // ys_sale ÷ ysasc, so the x axis has to be that same denominator or the two
  // halves of every dot would describe different populations. A dealer with no
  // addressable figure can't be placed on either axis and is left out.
  const pts = dealers.filter((d) => d.has_sales && (d.ysasc ?? 0) > 0);
  if (!pts.length) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
        No addressable (YSASC) dealer data for this selection — the OE dealer file only
        covers MSIL so far, and only from the three-series format onward.
      </div>
    );
  }

  const W = 900, H = 380, PL = 52, PR = 18, PT = 16, PB = 40;
  const maxAvail = Math.max(...pts.map((d) => d.ysasc ?? 0));
  // Cap the y axis at a sane ceiling so a single 90% dealer can't flatten
  // everyone else into the baseline.
  const peneCap = Math.min(100, Math.max(20, ...pts.map((d) => d.penetration ?? 0)) * 1.05);
  const maxOurs = Math.max(...pts.map((d) => d.ys_sale), 1);

  const x = (v: number) => PL + (Math.sqrt(v) / Math.sqrt(maxAvail)) * (W - PL - PR);
  const y = (v: number) => H - PB - (Math.min(v, peneCap) / peneCap) * (H - PT - PB);
  const r = (v: number) => 3 + Math.sqrt(v / maxOurs) * 11;

  const xTicks = [0, 0.05, 0.2, 0.45, 1].map((f) => Math.round(maxAvail * f));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => +(peneCap * f).toFixed(0));
  const midX = x(maxAvail * 0.18);

  const pickKeys = (e: React.KeyboardEvent, d: PerfDealer) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(d); }
  };

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-gray-800">Where the opportunity is</h3>
          <p className="text-[11px] text-gray-400">
            Each dot is one dealership · size = units we sell there · click to open
          </p>
        </div>
        <p className="text-[11px] text-gray-400 shrink-0 ml-auto">
          OEM average penetration <b className="text-gray-600">{avgPene.toFixed(1)}%</b>
        </p>
      </div>

      <Explain>
        Left-to-right is <b className="text-gray-600">how much this dealer sells that
        we make a part for</b> (YSASC — not their whole volume, so nobody is placed
        by business we could never have won); bottom-to-top is{" "}
        <b className="text-gray-600">how much of that we actually win</b>. The dotted
        line is the {avgPene.toFixed(1)}% OEM average.
        So <span style={{ color: VISIT_COLOR }} className="font-semibold">orange dots
        on the right, below the line</span> are dealers with a lot of winnable
        business where we are under-performing — the most units available anywhere on
        this chart. <span style={{ color: "#b45309" }} className="font-semibold">Amber</span>{" "}
        is the same underperformance at smaller dealers, and{" "}
        <span style={{ color: CALL_COLOR }} className="font-semibold">blue</span> above
        the line is where we are already ahead.
      </Explain>

      <div className="relative overflow-x-auto">
        {/* h-auto, not a fixed height: the SVG keeps its viewBox aspect, so a
            fixed 380px box letter-boxes it with dead bands on any container
            narrower than 900px. */}
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] h-auto">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="#f3f4f6" />
              <text x={PL - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#9ca3af">{t}%</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - PB + 15} textAnchor="middle" fontSize="10" fill="#9ca3af">
              {t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t}
            </text>
          ))}
          {/* The two lines that make the quadrants readable. */}
          <line x1={PL} x2={W - PR} y1={y(avgPene)} y2={y(avgPene)}
            stroke={VISIT_COLOR} strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
          <line x1={midX} x2={midX} y1={PT} y2={H - PB}
            stroke="#d1d5db" strokeWidth={1} strokeDasharray="4 4" />
          <text x={W - PR - 6} y={y(avgPene) - 5} textAnchor="end" fontSize="9"
            fill={VISIT_COLOR} fontWeight="600">network average</text>
          {/* The volume threshold was the one line on the chart with no caption —
              the horizontal average got one, this didn't. */}
          <text x={midX + 5} y={PT + 9} fontSize="9" fill="#9ca3af">bigger dealers →</text>
          <text x={W - PR - 6} y={H - PB - 8} textAnchor="end" fontSize="11"
            fill="#9ca3af" fontWeight="700" opacity={0.65}>
            high YSASC, low penetration
          </text>

          {pts.map((d) => {
            const below = (d.penetration ?? 0) < avgPene;
            const big = (d.ysasc ?? 0) >= maxAvail * 0.18;
            const isTarget = below && big;
            return (
              <circle
                key={d.id}
                cx={x(d.ysasc ?? 0)} cy={y(d.penetration ?? 0)} r={r(d.ys_sale)}
                fill={isTarget ? VISIT_COLOR : below ? SMALL_BEHIND : CALL_COLOR}
                fillOpacity={hover && hover.id !== d.id ? 0.18 : isTarget ? 0.62 : 0.4}
                stroke={isTarget ? VISIT_COLOR : "transparent"} strokeWidth={1}
                className="cursor-pointer transition-opacity focus:outline-none"
                tabIndex={0} role="button"
                aria-label={`${d.name}, ${d.city} — open details`}
                onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(d)} onBlur={() => setHover(null)}
                onKeyDown={(e) => pickKeys(e, d)}
                onClick={() => onPick(d)}
              />
            );
          })}
          <text x={(W - PL) / 2 + PL} y={H - 4} textAnchor="middle" fontSize="10" fill="#9ca3af">
            YSASC — covers they sell that we make a part for (square-root scale)
          </text>
          <text x={-(H / 2)} y={13} transform="rotate(-90)" textAnchor="middle" fontSize="10" fill="#9ca3af">
            Penetration of YSASC
          </text>
        </svg>

        {hover && (
          <div className="absolute top-2 left-14 bg-gray-900/92 text-white rounded-xl px-3 py-2 pointer-events-none shadow-lg">
            <p className="text-xs font-bold">{hover.name}</p>
            <p className="text-[10px] text-gray-300">
              {hover.city} · {hover.salesperson ?? "—"}
            </p>
            <p className="text-[10px] mt-1">
              {n0(hover.ys_sale)} ours of {n0(hover.ysasc)} YSASC · {pct(hover.penetration)}
            </p>
            <p className="text-[10px] text-gray-400">
              {n0(hover.oem_total)} sold in total · {pct(hover.addressable_pct)} addressable
            </p>
            <p className="text-[10px] text-gray-300">
              {hover.contacts} contact{hover.contacts === 1 ? "" : "s"} in period
            </p>
          </div>
        )}
      </div>

      {/* Three dot colours were in play but only two were ever explained. */}
      <div className="flex items-center gap-4 flex-wrap pt-2">
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: VISIT_COLOR, opacity: 0.62 }} />
          big &amp; below average — work these
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: SMALL_BEHIND, opacity: 0.4 }} />
          smaller &amp; below average
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: CALL_COLOR, opacity: 0.4 }} />
          above average
        </span>
      </div>
    </div>
  );
}
