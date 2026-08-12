import { VISIT_COLOR, NEUTRAL_BAR, OVER_COLOR, ON_TRACK_PCT, firstName, coverageColor } from "../shared";
import { type DealerSpRow, type DealerQuarter, type DealerPerf, n0, pct } from "./model";
import Explain from "./Explain";

/** Coverage per rep: how much of the patch they actually touched. */
export function CoveragePanel({ rows }: { rows: DealerSpRow[] }) {
  const real = rows.filter((r) => r.salesperson !== "Unassigned");
  const max = Math.max(...real.map((r) => r.assigned), 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Coverage</h3>
      <Explain>
        How much of a rep's patch they actually reached in this period: dealerships
        contacted at least once, out of every dealership assigned to them in the OEM's
        own dealer list. Bar length is the size of the patch, fill is the share
        covered — so a short full bar is a small patch worked thoroughly, and a long
        empty one is a big patch going untouched. A visit and a phone call both count.
      </Explain>
      <div className="flex flex-col gap-2.5">
        {[...real].sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0)).map((r) => (
          <div key={r.salesperson} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs font-semibold text-gray-700 truncate">
              {firstName(r.salesperson)}
            </span>
            <div className="flex-1 h-6 rounded-lg bg-gray-100 relative overflow-hidden"
              style={{ maxWidth: `${(r.assigned / max) * 100}%` }}>
              <div className="h-full rounded-lg transition-all"
                style={{ width: `${r.coverage ?? 0}%`, background: VISIT_COLOR, opacity: 0.85 }} />
              {/* White only works while the orange fill reaches the label; on a
                  near-empty bar the label sits on the pale track and has to go
                  dark instead. */}
              <span className={`absolute inset-y-0 left-2 flex items-center text-[10px] font-bold ${
                (r.coverage ?? 0) >= 20 ? "text-white" : "text-gray-500"}`}>
                {r.contacted}
              </span>
            </div>
            <span className={`w-28 shrink-0 text-[11px] font-bold tabular-nums ${coverageColor(r.coverage)}`}>
              {pct(r.coverage)} <span className="text-gray-400 font-medium">of {r.assigned}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Quarter vs quarter: target, achievement, and what actually sold. */
export function QuarterPanel({ rows }: { rows: DealerQuarter[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.flatMap((r) => [r.target ?? 0, r.achievement ?? 0, r.ys_sale ?? 0]), 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Quarter vs quarter</h3>
      <Explain>
        Units targeted against units achieved, per quarter, for the dealerships in
        view. A quarter appears whenever the period touches it at all and its target
        is always shown <b className="text-gray-600">whole</b> — targets are agreed per
        quarter, so cutting one into part-months would invent a number nobody set.
        A quarter still in progress shows its target with no achievement yet.
      </Explain>
      <div className="flex flex-col gap-4">
        {rows.map((r) => {
          const ach = r.achievement ?? 0;
          const tgt = r.target ?? 0;
          const hitPct = tgt ? Math.round((ach / tgt) * 100) : null;
          return (
            <div key={`${r.fy_year}${r.quarter}`}>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-xs font-bold text-gray-700">{r.label}</span>
                <span className="text-[11px] text-gray-400">
                  {r.ysasc == null ? n0(r.oem_total) + " sold" : `${n0(r.ysasc)} YSASC`}
                  {" · "}{pct(r.penetration)} penetration
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Target</span>
                <div className="flex-1 h-4 rounded bg-gray-100">
                  <div className="h-full rounded" style={{ width: `${(tgt / max) * 100}%`, background: NEUTRAL_BAR }} />
                </div>
                <span className="w-16 text-right text-[11px] font-semibold tabular-nums text-gray-500">{n0(tgt)}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="w-16 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Achieved</span>
                <div className="flex-1 h-4 rounded bg-gray-100">
                  <div className="h-full rounded transition-all" style={{
                    width: `${(ach / max) * 100}%`,
                    background: hitPct !== null && hitPct >= ON_TRACK_PCT ? OVER_COLOR : VISIT_COLOR,
                  }} />
                </div>
                <span className="w-16 text-right text-[11px] font-bold tabular-nums text-gray-700">
                  {ach ? n0(ach) : "—"}
                </span>
              </div>
              {hitPct !== null && (
                // Same spacer as the bar rows above, so the footnote aligns with
                // the tracks without a hand-tuned padding value.
                <div className="flex gap-2 mt-1">
                  <span className="w-16 shrink-0" />
                  <p className="text-[10px] text-gray-400">
                    {ach ? `${hitPct}% of target` : "quarter still open"}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Does contacting a dealer more actually move what we sell there? */
export function ContactEffectPanel({ data }: { data: DealerPerf["contact_effect"] }) {
  if (!data.buckets.length) return null;
  const max = Math.max(...data.buckets.map((b) => b.penetration ?? 0), 1);
  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">Does contacting them help?</h3>
      <Explain>
        Dealerships grouped by how many times they were contacted in a month, and what
        our penetration was at them <b className="text-gray-600">in that same month</b>.
        Each bar is a group, not a dealer — "3-4" means every dealer-month with three
        or four contacts in it. If contact moved the needle, the bars would climb left
        to right.
      </Explain>
      <div className="flex items-end gap-3 h-40">
        {data.buckets.map((b) => (
          <div key={b.bucket} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
            <span className="text-[11px] font-bold text-gray-700">{pct(b.penetration)}</span>
            <div className="w-full rounded-t-lg transition-all" style={{
              height: `${((b.penetration ?? 0) / max) * 100}%`,
              background: VISIT_COLOR,
              opacity: 0.35 + 0.65 * ((b.penetration ?? 0) / max),
            }} />
            <span className="text-[10px] font-semibold text-gray-500">{b.bucket}</span>
            <span className="text-[9px] text-gray-400">{b.dealer_months} mo</span>
          </div>
        ))}
      </div>
    </div>
  );
}
