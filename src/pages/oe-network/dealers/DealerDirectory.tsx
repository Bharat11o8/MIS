import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { shortDate } from "../shared";
import { type PerfDealer, n0, pct } from "./model";
import Explain from "./Explain";

const PAGE = 30;

/**
 * Every dealer in the current view, searchable — the map and the Top/Bottom 20
 * answer "where should I look", this answers "show me a specific dealer" and
 * "let me just scroll the whole network". Search matches name, city, state,
 * rep and dealer codes, so typing a code off an invoice finds the outlet.
 */
export default function DealerDirectory({ dealers, avgPene, onPick }: {
  dealers: PerfDealer[]; avgPene: number; onPick: (d: PerfDealer) => void;
}) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);

  const filtered = useMemo(() => {
    // Biggest of OUR business first; dealers with no sales at all sink to the
    // bottom by their total volume so the list stays meaningful for them too.
    const base = [...dealers].sort((a, b) =>
      b.ys_sale - a.ys_sale || b.oem_total - a.oem_total || a.name.localeCompare(b.name));
    const t = q.trim().toLowerCase();
    if (!t) return base;
    return base.filter((d) =>
      [d.name, d.city, d.state, d.salesperson ?? "", d.codes ?? ""]
        .some((s) => s.toLowerCase().includes(t)));
  }, [dealers, q]);

  const rows = filtered.slice(0, shown);

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-gray-800">All dealers</h3>
          <p className="text-[11px] text-gray-500">
            Every dealership in the current selection · click a row for its full story
          </p>
        </div>
        <div className="relative no-print shrink-0 ml-auto">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={q}
            onChange={(e) => { setQ(e.target.value); setShown(PAGE); }}
            placeholder="Search name, city, rep, code…"
            className="h-9 pl-8 pr-3 w-56 rounded-xl border border-gray-200 text-xs text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
        </div>
      </div>

      <Explain>
        The complete list behind every chart on this tab, ranked by our own sales.
        {" "}<b className="text-gray-600">{n0(filtered.length)}</b>
        {q.trim() ? <> of {n0(dealers.length)} dealers match.</> : <> dealers in view.</>}
        {" "}Pene is green from the <b>{avgPene.toFixed(1)}%</b> OEM average up; a grey
        dash means the dealer file supplied no YSASC for this dealer, so penetration
        cannot be computed — not that it is zero.
      </Explain>

      {filtered.length === 0 ? (
        <p className="text-xs text-gray-500 py-6 text-center">
          No dealer matches “{q.trim()}” in this selection.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-100">
                <th className="text-left font-bold py-2 pl-1">#</th>
                <th className="text-left font-bold py-2">Dealership</th>
                <th className="text-left font-bold py-2">State</th>
                <th className="text-left font-bold py-2">Rep</th>
                <th className="text-right font-bold py-2" title="Every seat cover this dealer sold, ours or not">Total</th>
                <th className="text-right font-bold py-2"
                  title="YSASC — of that total, the covers on a vehicle we hold a part number for">
                  YSASC
                </th>
                <th className="text-right font-bold py-2">YS Sale</th>
                <th className="text-right font-bold py-2" title="YS Sale ÷ YSASC">Pene</th>
                <th className="text-right font-bold py-2">Contacts</th>
                <th className="text-right font-bold py-2 pr-1">Last contact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
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
                  <td className="py-2 text-gray-500">{d.state}</td>
                  <td className="py-2 text-gray-500">{d.salesperson ?? "—"}</td>
                  <td className="py-2 text-right tabular-nums text-gray-500">{n0(d.oem_total)}</td>
                  <td className="py-2 text-right tabular-nums text-gray-600">
                    {d.ysasc == null ? "—" : n0(d.ysasc)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold text-gray-800">{n0(d.ys_sale)}</td>
                  <td className={`py-2 text-right tabular-nums font-semibold ${
                    d.penetration == null ? "text-gray-500"
                      : d.penetration >= avgPene ? "text-green-600" : "text-red-500"}`}>
                    {pct(d.penetration)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {d.contacts === 0
                      ? <span className="text-red-400 font-semibold">none</span>
                      : <span className="text-gray-600">{d.contacts}</span>}
                  </td>
                  <td className="py-2 pr-1 text-right text-gray-500">{shortDate(d.last_contact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > shown && (
        <div className="pt-3 text-center no-print">
          <button onClick={() => setShown((s) => s + PAGE * 2)}
            className="text-xs font-semibold px-4 py-2 rounded-xl border border-gray-200 text-gray-600 hover:border-orange-200 hover:text-brand-orange transition-all">
            Show more ({n0(filtered.length - shown)} remaining)
          </button>
        </div>
      )}
    </div>
  );
}
