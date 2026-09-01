import { useEffect, useMemo, useState } from "react";
import Select from "@/components/ui/Select";
import {
  type PerfDealer, type RankMetric, RANK_META, RANK_METRICS, rankMeta, rankValue, rankLabel, oursOf, totalLabel, oursLabels,
  n0, nOr, pct, hitPct,
} from "./model";
import Explain from "./Explain";

/** Top / bottom N by a chosen metric.
 *
 *  The bottom list applies a VOLUME FLOOR. Ranked purely by penetration the
 *  worst dealers are simply the smallest ones, which is true and useless —
 *  the floor makes it read "big dealers we are failing at" instead. */
/** How many rows the list can show. The whole dealer set is already on the
 *  client, so this is a slice — no refetch, no server round trip. */
const COUNTS = [10, 20, 30, 50] as const;

export default function DealerRankTable({ dealers, avgPene, funnel, fullCoverage = false, products, onPick }: {
  dealers: PerfDealer[]; avgPene: number;
  /** Whether the OEMs in view publish the funnel. Without it the rankings that
   *  divide by a total nobody supplies are not offered at all — a metric picker
   *  that can only produce a column of dashes reads as broken. */
  funnel: boolean;
  /** Whether we hold a part number for the whole range of every OEM in view.
   *  When we do, the addressable column IS the total column and is not drawn —
   *  see oursLabels / RANK_METRICS. */
  fullCoverage?: boolean;
  /** Products the rows are summed over, so the units column is not captioned
   *  "SC" when it also holds mats. */
  products?: string[];
  onPick: (d: PerfDealer) => void;
}) {
  const metrics = RANK_METRICS(funnel, fullCoverage);
  // Named from the rows on screen: TATA publishes a total of its own now, so
  // the column can no longer be captioned with MSIL's name for it.
  const oems = [...new Set(dealers.map((d) => d.oem))];
  // Our units go by the OEM's own name for them — YS on MSIL, Amato on TATA.
  const L = oursLabels(oems, products);
  const [metric, setMetric] = useState<RankMetric>(metrics[0]);
  // Which end is the useful one depends on the metric, so the default follows
  // it. On a signed metric (+ = ahead) the dealers worth working are the most
  // NEGATIVE, so the table opens on the bottom — the same rows it opened on
  // when + still meant "behind". On a volume or share ranking the top is the
  // interesting end as usual. Only the default moves; the toggle is untouched
  // once the reader has used it.
  const [end, setEnd] = useState<"top" | "bottom">(
    RANK_META[metrics[0]].signed ? "bottom" : "top");
  const [count, setCount] = useState<number>(20);
  // Switching OEM can take the selected ranking away with it; without this the
  // table would keep sorting by a metric the new scope cannot compute.
  useEffect(() => {
    if (!metrics.includes(metric)) setMetric(metrics[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnel, fullCoverage]);
  // A signed metric's useful end is its bottom and a ranking's is its top, so
  // carrying the old end across a metric switch lands the reader on the least
  // interesting half of the new list — "top 20 vs Average" is the dealers who
  // need nothing done about them.
  useEffect(() => {
    setEnd(RANK_META[metric].signed ? "bottom" : "top");
  }, [metric]);

  const withSales = dealers.filter((d) => d.has_sales || d.target != null);
  // The floor is on ADDRESSABLE volume, matching what the ranked metrics divide
  // by — a dealer who sells a lot but of models we don't cover isn't a big
  // dealer for this purpose.
  const floor = useMemo(() => {
    const vols = withSales.map((d) => d.ysasc ?? 0).sort((a, b) => a - b);
    return vols.length ? vols[Math.floor(vols.length / 2)] : 0;
  }, [withSales]);

  const meta = rankMeta(metric, oems, products);
  const flooring = end === "bottom" && meta.floor;
  const pool = flooring ? withSales.filter((d) => (d.ysasc ?? 0) >= floor) : withSales;
  const sorted = [...pool].sort((a, b) =>
    rankValue(b, metric, avgPene, funnel) - rankValue(a, metric, avgPene, funnel));
  const rows = (end === "top" ? sorted : [...sorted].reverse()).slice(0, count);
  // Asking for 50 out of a pool of 31 is not an error, but the heading must not
  // claim 50 — otherwise a short list reads as data missing.
  const short = rows.length < count;

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      {/* The title block must be allowed to shrink (min-w-0 flex-1), or a long
          `what` line pushes the controls onto their own row and they land on
          the left — the metric picker appeared to move depending on which
          metric was selected. */}
      <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-gray-800">
            {end === "top" ? "Top" : "Bottom"} {rows.length} · {rankLabel(metric, funnel, oems, products)}
          </h3>
          <p className="text-[11px] text-gray-500">{meta.what}</p>
        </div>
        <div className="flex items-center gap-2 no-print shrink-0 ml-auto">
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-xl p-0.5">
            {(["top", "bottom"] as const).map((e) => (
              <button key={e} onClick={() => setEnd(e)}
                className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg capitalize transition-all ${
                  end === e ? "bg-white text-brand-orange shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}>{e}</button>
            ))}
          </div>
          <Select value={String(count)} onChange={(v) => setCount(Number(v))}
            className="min-w-[92px]"
            options={COUNTS.map((n) => ({ value: String(n), label: `${n} rows` }))} />
          <Select value={metric} onChange={(v) => setMetric(v as RankMetric)}
            options={metrics.map((k) => ({ value: k, label: rankLabel(k, funnel, oems, products) }))} />
        </div>
      </div>

      <Explain>
        <b className="text-gray-600">
          Showing the {end === "top" ? "top" : "bottom"} {rows.length}:
        </b>{" "}
        {end === "top" ? meta.top : meta.bottom}
        {short && (
          // Says why the list is shorter than asked for, so it can't be read as
          // rows failing to load.
          <> Only <b>{rows.length}</b> dealership{rows.length === 1 ? "" : "s"} qualif
            {rows.length === 1 ? "ies" : "y"} here, fewer than the {count} requested.</>
        )}
        {flooring && (
          <> Only dealers with <b>{n0(floor)}+</b> {L.avail} covers are included, otherwise
            the bottom of a share-based list is just the smallest dealerships.</>
        )}
        {funnel ? (
          <> The <b className="text-gray-600">vs Avg</b> column reads the same way
            everywhere in this module —{" "}
            <span className="text-green-600 font-semibold">+n</span> is good:
            n units <i>more</i> than the <b>{avgPene.toFixed(1)}%</b> OEM average
            predicts for this dealer.{" "}
            <span className="text-red-500 font-semibold">−n</span> means we are n
            units <i>short</i> of it — units that are there and we aren't getting.</>
        ) : (
          <> The <b className="text-gray-600">Remaining Target</b> column reads the
            same way as every signed figure in this module —{" "}
            <span className="text-green-600 font-semibold">+n</span> is good:
            n units <i>past</i> the quarter target.{" "}
            <span className="text-red-500 font-semibold">−n</span> means n units
            still <i>to go</i>. The target is the whole quarter's and is never cut to
            the period, so part-way through a quarter a negative figure is expected.</>
        )}
      </Explain>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
              <th className="text-left font-bold py-2 pl-1">#</th>
              <th className="text-left font-bold py-2">Dealership</th>
              <th className="text-left font-bold py-2">Rep</th>
              {funnel ? (
                <>
                  <th className="text-right font-bold py-2" title="Every seat cover this dealer sold, ours or not">
                    {totalLabel(oems)}
                  </th>
                  {/* Not drawn at full coverage: it is the total column again.
                      Two columns of identical numbers read as a rendering fault. */}
                  {!fullCoverage && (
                    <th className="text-right font-bold py-2"
                      title="Of that total, the covers on a vehicle we hold a part number for">
                      {L.avail}
                    </th>
                  )}
                  <th className="text-right font-bold py-2">{L.sale}</th>
                  <th className="text-right font-bold py-2" title={`${L.sale} ÷ ${L.avail}`}>{L.share}</th>
                  <th className="text-right font-bold py-2"
                    title={`Units vs what the network-average ${L.share} would predict: + = ahead of the average, − = short of it`}>
                    vs Avg
                  </th>
                </>
              ) : (
                <>
                  <th className="text-right font-bold py-2" title="The whole quarter's target, never pro-rated">
                    Target
                  </th>
                  {/* One column, not two. "Achieved" and "Amato SC Sale" were
                      the same figure under two names — see oursOf in model.ts. */}
                  <th className="text-right font-bold py-2" title="Our units inside the quarter the target covers">
                    {L.sale}
                  </th>
                  <th className="text-right font-bold py-2" title={`${L.sale} ÷ target`}>Achieved %</th>
                  <th className="text-right font-bold py-2"
                    title="Units against the quarter target. + = already PAST it, − = still to go — the sign says which, not the name">
                    Remaining Target
                  </th>
                </>
              )}
              <th className="text-right font-bold py-2 pr-1">Contacts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const gap = Math.round(rankValue(d, funnel ? "gap" : "tgt_gap", avgPene));
              return (
                <tr key={d.id} onClick={() => onPick(d)}
                  tabIndex={0} role="button"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(d); }
                  }}
                  className="border-b border-gray-50 hover:bg-orange-50/40 focus:bg-orange-50/40 focus:outline-none cursor-pointer">
                  <td className="py-2 pl-1 text-gray-500 font-semibold">{i + 1}</td>
                  <td className="py-2">
                    <span className="font-semibold text-gray-800">{d.name}</span>
                    <span className="text-gray-500"> · {d.city}</span>
                  </td>
                  <td className="py-2 text-gray-500">{d.salesperson ?? "—"}</td>
                  {funnel ? (
                    <>
                      <td className="py-2 text-right tabular-nums text-gray-500">{nOr(d.oem_total)}</td>
                      {/* Header is hidden at full coverage, so the cell must be too
                          or every column after it shifts one place left. */}
                      {!fullCoverage && (
                        <td className="py-2 text-right tabular-nums text-gray-600">{nOr(d.ysasc)}</td>
                      )}
                      <td className="py-2 text-right tabular-nums font-semibold text-gray-800">{n0(d.ys_sale)}</td>
                      {/* No penetration is "no data", not "bad" — the dash must stay
                          grey, never inherit the below-average red. */}
                      <td className={`py-2 text-right tabular-nums font-semibold ${
                        d.penetration == null ? "text-gray-500"
                          : d.penetration >= avgPene ? "text-green-600" : "text-red-500"}`}>
                        {pct(d.penetration)}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-2 text-right tabular-nums text-gray-600">{nOr(d.target)}</td>
                      <td className="py-2 text-right tabular-nums font-semibold text-gray-800">
                        {nOr(oursOf(d, funnel))}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${
                        hitPct(d.sold, d.target) == null ? "text-gray-500"
                          : hitPct(d.sold, d.target)! >= 100 ? "text-green-600" : "text-gray-700"}`}>
                        {pct(hitPct(d.sold, d.target))}
                      </td>
                    </>
                  )}
                  {/* Signed, both ways, and + is ALWAYS the good direction: this
                      dealer sold more than expected. A negative figure is not
                      "no data" — it is a real shortfall, which is worth seeing.
                      Zero is a dash rather than a green 0 because landing exactly
                      on the prediction is neither. */}
                  <td className={`py-2 text-right tabular-nums font-semibold ${
                    gap > 0 ? "text-green-600" : gap < 0 ? "text-red-500" : "text-gray-500"}`}>
                    {gap > 0 ? `+${n0(gap)}` : gap < 0 ? `−${n0(-gap)}` : "—"}
                  </td>
                  <td className="py-2 pr-1 text-right tabular-nums">
                    {d.contacts === 0
                      ? <span className="text-red-400 font-semibold">none</span>
                      : <span className="text-gray-600">{d.contacts}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
