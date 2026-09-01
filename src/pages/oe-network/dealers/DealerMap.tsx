import { useMemo, useState } from "react";
import { VISIT_COLOR, CALL_COLOR, CHART_LABEL } from "../shared";
import { type PerfDealer, n0, pct, oursLabels } from "./model";
import Explain from "./Explain";

// The third dot colour: a dealer below the network average that is too small to
// make the priority list. Amber rather than a softer orange so it cannot be
// misread as a faded member of the "work these" set.
const SMALL_BEHIND = "#f59e0b";

/** The three populations the chart separates, and what each one means. */
type Band = "priority" | "small" | "ahead";
const BANDS: { key: Band; color: string; label: string }[] = [
  { key: "priority", color: VISIT_COLOR,  label: "big & below average — work these" },
  { key: "small",    color: SMALL_BEHIND, label: "smaller & below average" },
  { key: "ahead",    color: CALL_COLOR,   label: "above average" },
];

/** A round number at or above v — 1/2/5 × 10ⁿ. Axis ticks read as quantities
 *  people recognise ("500") instead of artefacts of the data ("554"). */
function niceNum(v: number): number {
  if (v <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

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
 *
 * With a few hundred dealers the plot overlaps heavily, so three things keep it
 * readable: every dot carries a thin white outline (so a clump reads as
 * separate circles rather than one blob), the legend swatches toggle a whole
 * band off, and hovering fades everything else right back.
 */
export default function DealerMap({ dealers, avgPene, fullCoverage = false, onPick }: {
  dealers: PerfDealer[]; avgPene: number;
  /** Whether the addressable axis IS the dealer's whole volume — see below:
   *  the sentence explaining the x axis is the opposite of true when it is. */
  fullCoverage?: boolean;
  onPick: (d: PerfDealer) => void;
}) {
  // The OEM's own word for our units — YS on MSIL, Amato on TATA.
  const L = oursLabels([...new Set(dealers.map((d) => d.oem))]);
  const [hover, setHover] = useState<PerfDealer | null>(null);
  const [off, setOff] = useState<Set<Band>>(new Set());

  // Plotted against YSASC, not the dealer's whole volume: the y axis is
  // ys_sale ÷ ysasc, so the x axis has to be that same denominator or the two
  // halves of every dot would describe different populations. A dealer with no
  // addressable figure can't be placed on either axis and is left out.
  const all = useMemo(
    () => dealers.filter((d) => d.has_sales && (d.ysasc ?? 0) > 0),
    [dealers],
  );

  const W = 900, H = 400, PL = 54, PR = 20, PT = 22, PB = 44;
  const maxAvail = Math.max(...all.map((d) => d.ysasc ?? 0), 1);
  const bigFrom = maxAvail * 0.18;
  const bandOf = (d: PerfDealer): Band =>
    (d.penetration ?? 0) >= avgPene ? "ahead"
      : (d.ysasc ?? 0) >= bigFrom ? "priority" : "small";

  const counts = useMemo(() => {
    const c: Record<Band, number> = { priority: 0, small: 0, ahead: 0 };
    all.forEach((d) => { c[bandOf(d)] += 1; });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, avgPene, maxAvail]);

  const pts = all.filter((d) => !off.has(bandOf(d)));

  if (!all.length) {
    return (
      <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
        No addressable-volume dealer data for this selection — the OE dealer file only
        covers MSIL so far, and only from the three-series format onward.
      </div>
    );
  }

  // Cap the y axis at a sane ceiling so a single 90% dealer can't flatten
  // everyone else into the baseline.
  const peneCap = Math.min(100, Math.max(20, ...all.map((d) => d.penetration ?? 0)) * 1.05);
  const maxOurs = Math.max(...all.map((d) => d.ys_sale), 1);

  const x = (v: number) => PL + (Math.sqrt(v) / Math.sqrt(maxAvail)) * (W - PL - PR);
  // A 4px floor above the axis: a dealer at exactly 0% penetration is the most
  // interesting kind there is, and sitting ON the axis line hides it.
  const y = (v: number) => H - PB - 4 - (Math.min(v, peneCap) / peneCap) * (H - PT - PB - 4);
  const r = (v: number) => 2.5 + Math.sqrt(v / maxOurs) * 9;

  // Round tick values rather than fractions of the max, spaced for a sqrt axis.
  const xTicks = [...new Set([0, ...[0.05, 0.18, 0.45, 1].map((f) => niceNum(maxAvail * f))])];
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(peneCap * f));
  const midX = x(bigFrom);

  const toggle = (b: Band) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b); else next.add(b);
      return next;
    });

  // Tooltip sits next to the dot and flips before it runs off an edge, so it
  // never covers the point being read. Percentages of the viewBox, so it tracks
  // the SVG at any container width.
  const tip = hover
    ? {
        left: `${(x(hover.ysasc ?? 0) / W) * 100}%`,
        top: `${(y(hover.penetration ?? 0) / H) * 100}%`,
        flipX: x(hover.ysasc ?? 0) > W * 0.62,
        flipY: y(hover.penetration ?? 0) < H * 0.34,
      }
    : null;

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-gray-800">Where the opportunity is</h3>
          <p className="text-[11px] text-gray-500">
            Each dot is one dealership · size = units we sell there · click to open
          </p>
        </div>
        {/* Says "whole OEM" out loud: this line does NOT move when you filter to
            a rep or a state, by design — benchmarking a rep's dealers against
            that rep's own average makes a weak territory look like it has the
            least to gain. Unlabelled, it just looks like a filter that failed. */}
        <p className="text-[11px] text-gray-500 shrink-0 ml-auto">
          Whole-OEM average {L.share} <b className="text-gray-600">{avgPene.toFixed(1)}%</b>
          <span className="block text-[10px] text-gray-500 text-right">fixed yardstick — ignores rep/state</span>
        </p>
      </div>

      <Explain>
        Left-to-right is <b className="text-gray-600">how much this dealer sells that
        we make a part for</b> ({fullCoverage
          ? <>their whole volume, because we hold a part number across this OEM&rsquo;s
            entire range — everything they sold was winnable</>
          : <>{L.avail} — not their whole volume, so nobody is placed by business we
            could never have won</>}); bottom-to-top is{" "}
        <b className="text-gray-600">how much of that we actually win</b>. The dotted
        line is the {avgPene.toFixed(1)}% OEM average.
        So <span style={{ color: VISIT_COLOR }} className="font-semibold">orange dots
        on the right, below the line</span> are dealers with a lot of winnable
        business where we are under-performing — the most units available anywhere on
        this chart. With {n0(all.length)} dealerships plotted the left side is
        crowded; <b className="text-gray-600">click a colour below to hide that
        group</b> and the rest becomes readable.
      </Explain>

      <div className="relative">
        {/* h-auto, not a fixed height: the SVG keeps its viewBox aspect, so a
            fixed pixel box letter-boxes it on any container narrower than 900. */}
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px] h-auto overflow-visible">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="#f3f4f6" />
              <text x={PL - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill={CHART_LABEL}>{t}%</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={x(t)} y={H - PB + 15} textAnchor="middle" fontSize="10" fill={CHART_LABEL}>
              {t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t}
            </text>
          ))}

          {/* The volume threshold that splits "work these" from "too small". */}
          <line x1={midX} x2={midX} y1={PT} y2={H - PB}
            stroke="#d1d5db" strokeWidth={1} strokeDasharray="4 4" />
          <text x={midX + 5} y={PT - 6} fontSize="9" fill={CHART_LABEL}>bigger dealers →</text>

          {/* Drawn after the grid but before the dots, and labelled at the LEFT
              so the caption sits over empty space rather than over the dense
              right-hand tail. */}
          <line x1={PL} x2={W - PR} y1={y(avgPene)} y2={y(avgPene)}
            stroke={VISIT_COLOR} strokeWidth={1} strokeDasharray="4 4" opacity={0.55} />
          <text x={PL + 4} y={y(avgPene) - 5} fontSize="9" fill={VISIT_COLOR} fontWeight="600">
            network average {avgPene.toFixed(1)}%
          </text>

          {pts.map((d) => {
            const band = bandOf(d);
            const color = BANDS.find((b) => b.key === band)!.color;
            const dim = hover !== null && hover.id !== d.id;
            return (
              <circle
                key={d.id}
                cx={x(d.ysasc ?? 0)} cy={y(d.penetration ?? 0)} r={r(d.ys_sale)}
                fill={color}
                fillOpacity={dim ? 0.12 : band === "priority" ? 0.6 : 0.42}
                // A hairline of card-colour between neighbours is what turns a
                // clump of overlapping dots back into countable circles.
                stroke={hover?.id === d.id ? "#111827" : "#fff"}
                strokeWidth={hover?.id === d.id ? 1.5 : 0.7}
                strokeOpacity={dim ? 0.25 : 1}
                className="cursor-pointer transition-opacity focus:outline-none"
                tabIndex={0} role="button"
                aria-label={`${d.name}, ${d.city} — open details`}
                onMouseEnter={() => setHover(d)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(d)} onBlur={() => setHover(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(d); }
                }}
                onClick={() => onPick(d)}
              />
            );
          })}

          <text x={(W - PL) / 2 + PL} y={H - 6} textAnchor="middle" fontSize="10" fill={CHART_LABEL}>
            {L.avail} — covers they sell that we make a part for (square-root scale)
          </text>
          <text x={-(H / 2)} y={13} transform="rotate(-90)" textAnchor="middle" fontSize="10" fill={CHART_LABEL}>
            {L.share} of {L.avail}
          </text>
        </svg>

        {hover && tip && (
          // Inline background, not a Tailwind opacity class. `bg-gray-900/92`
          // was silently never generated (92 is not on the opacity scale), so
          // this box rendered transparent and its white text vanished into the
          // chart. A tooltip must not be able to fail that way.
          <div
            className="absolute z-10 rounded-xl px-3 py-2 pointer-events-none shadow-xl text-white w-max max-w-[240px]"
            style={{
              background: "rgba(17,24,39,0.95)",
              left: tip.left,
              top: tip.top,
              transform: `translate(${tip.flipX ? "calc(-100% - 14px)" : "14px"}, ${
                tip.flipY ? "8px" : "calc(-100% - 8px)"})`,
            }}
          >
            {/* Secondary lines are white-alpha, NOT text-gray-3xx. This box is
                the one dark surface in the module, so the grey scale runs the
                wrong way here — a "muted" grey that reads correctly on a white
                card is nearly black on this one. */}
            <p className="text-xs font-bold leading-snug">{hover.name}</p>
            <p className="text-[10px] text-white/70">
              {hover.city} · {hover.salesperson ?? "—"}
            </p>
            <p className="text-[11px] mt-1 font-semibold">
              {n0(hover.ys_sale)} ours of {n0(hover.ysasc)} {L.avail} ·{" "}
              <span style={{ color: (hover.penetration ?? 0) >= avgPene ? "#4ade80" : "#fdba74" }}>
                {pct(hover.penetration)}
              </span>
            </p>
            <p className="text-[10px] text-white/65">
              {n0(hover.oem_total)} total MSIL SC sales · {pct(hover.addressable_pct)} available part number
            </p>
            <p className="text-[10px] text-white/70">
              {hover.contacts} contact{hover.contacts === 1 ? "" : "s"} in period
            </p>
          </div>
        )}
      </div>

      {/* Legend doubles as the filter — the only practical way to read the
          crowded left-hand side is to switch a band off. */}
      <div className="flex items-center gap-2 flex-wrap pt-2 no-print">
        {BANDS.map((b) => {
          const hidden = off.has(b.key);
          return (
            <button key={b.key} onClick={() => toggle(b.key)}
              aria-pressed={!hidden}
              title={hidden ? "Show this group" : "Hide this group"}
              // Hidden is the one place a FAINTER grey is correct: it is a
              // switched-off state, and it carries a strikethrough and a faded
              // swatch as well, so the contrast drop is not the only signal.
              className={`flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-lg border transition-all ${
                hidden
                  ? "border-gray-100 text-gray-400 line-through"
                  : "border-gray-200 text-gray-700 hover:border-orange-200"
              }`}>
              <span className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: b.color, opacity: hidden ? 0.25 : 0.75 }} />
              {b.label}
              <b className={hidden ? "text-gray-400" : "text-gray-600"}>{counts[b.key]}</b>
            </button>
          );
        })}
        {off.size > 0 && (
          <button onClick={() => setOff(new Set())}
            className="text-[10px] font-semibold text-brand-orange hover:text-orange-600 px-2">
            Show all
          </button>
        )}
      </div>
    </div>
  );
}
