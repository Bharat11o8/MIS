import { useMemo, useState } from "react";
import Select from "@/components/ui/Select";
import { type PerfDealer, type RankMetric, RANK_META, rankValue, n0, pct } from "./model";
import Explain from "./Explain";

/** Top / bottom N by a chosen metric.
 *
 *  The bottom list applies a VOLUME FLOOR. Ranked purely by penetration the
 *  worst dealers are simply the smallest ones, which is true and useless —
 *  the floor makes it read "big dealers we are failing at" instead. */
/** How many rows the list can show. The whole dealer set is already on the
 *  client, so this is a slice — no refetch, no server round trip. */
const COUNTS = [10, 20, 30, 50] as const;

export default function DealerRankTable({ dealers, avgPene, onPick }: {
  dealers: PerfDealer[]; avgPene: number; onPick: (d: PerfDealer) => void;
}) {
  const [metric, setMetric] = useState<RankMetric>("gap");
  const [end, setEnd] = useState<"top" | "bottom">("top");
  const [count, setCount] = useState<number>(20);

  const withSales = dealers.filter((d) => d.has_sales);
  // The floor is on ADDRESSABLE volume, matching what the ranked metrics divide
  // by — a dealer who sells a lot but of models we don't cover isn't a big
  // dealer for this purpose.
  const floor = useMemo(() => {
    const vols = withSales.map((d) => d.ysasc ?? 0).sort((a, b) => a - b);
    return vols.length ? vols[Math.floor(vols.length / 2)] : 0;
  }, [withSales]);

  const meta = RANK_META[metric];
  const flooring = end === "bottom" && meta.floor;
  const pool = flooring ? withSales.filter((d) => (d.ysasc ?? 0) >= floor) : withSales;
  const sorted = [...pool].sort((a, b) =>
    rankValue(b, metric, avgPene) - rankValue(a, metric, avgPene));
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
            {end === "top" ? "Top" : "Bottom"} {rows.length} · {meta.label}
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
            options={(Object.keys(RANK_META) as RankMetric[]).map((k) => ({ value: k, label: RANK_META[k].label }))} />
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
          <> Only dealers with <b>{n0(floor)}+</b> YSASC covers are included, otherwise
            the bottom of a share-based list is just the smallest dealerships.</>
        )}
        {" "}The <b className="text-gray-600">Opp.</b> column is the same figure in
        every view: <span className="text-brand-orange font-semibold">+n</span> means
        we are n units <i>behind</i> the <b>{avgPene.toFixed(1)}%</b> OEM
        average and could gain them;{" "}
        <span className="text-green-600 font-semibold">−n</span> means we are n units{" "}
        <i>ahead</i> of it.
      </Explain>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
              <th className="text-left font-bold py-2 pl-1">#</th>
              <th className="text-left font-bold py-2">Dealership</th>
              <th className="text-left font-bold py-2">Rep</th>
              <th className="text-right font-bold py-2" title="Every seat cover this dealer sold, ours or not">
                Total
              </th>
              <th className="text-right font-bold py-2"
                title="YSASC — of that total, the covers on a vehicle we hold a part number for">
                YSASC
              </th>
              <th className="text-right font-bold py-2">YS Sale</th>
              <th className="text-right font-bold py-2" title="YS Sale ÷ YSASC">Pene</th>
              <th className="text-right font-bold py-2"
                title="Units vs what network-average penetration would predict: + = room to gain, − = already ahead">
                Opp.
              </th>
              <th className="text-right font-bold py-2 pr-1">Contacts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const gap = Math.round(rankValue(d, "gap", avgPene));
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
                  <td className="py-2 text-right tabular-nums text-gray-500">{n0(d.oem_total)}</td>
                  <td className="py-2 text-right tabular-nums text-gray-600">
                    {d.ysasc == null ? "—" : n0(d.ysasc)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold text-gray-800">{n0(d.ys_sale)}</td>
                  {/* No penetration is "no data", not "bad" — the dash must stay
                      grey, never inherit the below-average red. */}
                  <td className={`py-2 text-right tabular-nums font-semibold ${
                    d.penetration == null ? "text-gray-500"
                      : d.penetration >= avgPene ? "text-green-600" : "text-red-500"}`}>
                    {pct(d.penetration)}
                  </td>
                  {/* Signed, both ways. A negative gap is not "no data" — it is
                      a dealer already selling MORE than network average would
                      predict, which is worth seeing. */}
                  <td className={`py-2 text-right tabular-nums font-semibold ${
                    gap > 0 ? "text-brand-orange" : gap < 0 ? "text-green-600" : "text-gray-500"}`}>
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
