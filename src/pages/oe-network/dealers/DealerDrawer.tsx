import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, CarFront, Package, Target, Footprints } from "lucide-react";
import { API_URL, StatCard, ModeBadge, shortDate, ON_TRACK_PCT, OVER_COLOR, VISIT_COLOR } from "../shared";
import { type DealerDetail, KPI, n0, pct } from "./model";
import DealerTrend from "./DealerTrend";

/** Everything about one dealership, opened from any row or dot. */
export default function DealerDrawer({ dealerId, headers, benchmark, onClose }: {
  dealerId: string; headers: Record<string, string>;
  /** The OEM average, carried in from the tab so a single dealer's chart is
   *  read against the same yardstick as everything else on the page. */
  benchmark?: number | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<DealerDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/dealer-performance/${dealerId}`,
          { headers, signal: ctrl.signal });
        if (res.ok) setData(await res.json());
        setLoading(false);
      } catch { /* aborted — the drawer is gone or showing another dealer */ }
    })();
    return () => ctrl.abort();
  }, [dealerId, headers]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  // The page must not scroll behind the drawer.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  const d = data?.dealer;
  return (
    <div className="no-print fixed inset-0 z-50 flex justify-end">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="absolute inset-0 bg-gray-900/30 backdrop-blur-[2px]" onClick={onClose}
      />
      <motion.div
        initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.18 }}
        role="dialog" aria-modal="true" aria-label={d?.name ?? "Dealer details"}
        className="relative w-full max-w-2xl h-full bg-gray-50 overflow-y-auto shadow-2xl"
      >
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b border-orange-100 px-5 py-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-gray-900 truncate">{d?.name ?? "Loading…"}</h2>
            {d && (
              <p className="text-[11px] text-gray-400 mt-0.5">
                {d.city} · {d.state} · {d.oem} · handled by <b className="text-gray-600">{d.salesperson ?? "—"}</b>
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="shrink-0 text-gray-400 hover:text-gray-700 p-1">
            <X size={18} />
          </button>
        </div>

        {loading && <div className="p-10 text-center text-sm text-gray-400">Loading…</div>}

        {data && (
          <div className="p-5 flex flex-col gap-4">
            {/* Same colour identities as the tab's KPI row — see KPI in model.ts. */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <StatCard label="Total sold" value={n0(data.totals.oem_total)}
                sub="all seat covers, ours or not"
                icon={<CarFront size={16} />} {...KPI.neutral} />
              <StatCard label="YSASC" value={data.totals.ysasc == null ? "—" : n0(data.totals.ysasc)}
                sub={data.totals.ysasc == null ? "not supplied" : `${pct(data.totals.addressable_pct)} of total sold`}
                icon={<Package size={16} />} {...KPI.neutral} />
              <StatCard label="YS Sale" value={n0(data.totals.ys_sale)} icon={<Package size={16} />}
                {...KPI.ours} />
              <StatCard label="Penetration" value={pct(data.totals.penetration)}
                sub={data.totals.penetration == null ? "needs YSASC" : "of YSASC"}
                icon={<Target size={16} />} {...KPI.conversion} />
              <StatCard label="Contacts" value={data.totals.visits + data.totals.calls}
                sub={`${data.totals.visits} visits · ${data.totals.calls} calls`}
                icon={<Footprints size={16} />} {...KPI.activity} />
            </div>

            {data.last_field_note && (
              <div className="bg-white border border-orange-200 rounded-2xl p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-brand-orange mb-1">
                  Last field visit remark · {shortDate(data.last_field_note.visit_date)} ·{" "}
                  {data.last_field_note.salesperson}
                </p>
                {data.last_field_note.notes.map((nt, i) => (
                  <p key={i} className="text-sm text-gray-700 leading-relaxed">
                    <span className="text-[10px] font-bold uppercase text-gray-400 mr-1.5">{nt.label}</span>
                    {nt.text}
                  </p>
                ))}
              </div>
            )}

            <DealerTrend rows={data.by_month} benchmark={benchmark}
              title="This dealership, month by month" subject="this dealership" />

            {data.targets.length > 0 && (
              <div className="bg-white border border-orange-100 rounded-2xl p-5">
                <h3 className="text-sm font-bold text-gray-800 mb-2">Target vs achievement</h3>
                <div className="flex flex-col gap-2">
                  {data.targets.map((t) => {
                    const hit = t.target ? Math.round(((t.achievement ?? 0) / t.target) * 100) : null;
                    return (
                      <div key={t.label} className="flex items-center gap-3 text-xs">
                        <span className="w-16 font-bold text-gray-700">{t.label}</span>
                        <div className="flex-1 h-4 rounded bg-gray-100 relative">
                          <div className="h-full rounded" style={{
                            width: `${Math.min(hit ?? 0, 100)}%`,
                            background: hit !== null && hit >= ON_TRACK_PCT ? OVER_COLOR : VISIT_COLOR,
                          }} />
                        </div>
                        <span className="w-32 text-right tabular-nums text-gray-500">
                          {n0(t.achievement)} / {n0(t.target)}
                          {hit !== null && <b className="ml-1 text-gray-700">{hit}%</b>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="bg-white border border-orange-100 rounded-2xl p-5">
              <h3 className="text-sm font-bold text-gray-800 mb-1">
                Contact history <span className="text-gray-400 font-medium">({data.history.length})</span>
              </h3>
              {data.history.length === 0 && (
                <p className="text-sm text-gray-400 py-4 text-center">
                  No contact logged with this dealership yet.
                </p>
              )}
              <div className="flex flex-col divide-y divide-gray-50">
                {data.history.map((h) => (
                  <div key={h.id} className="py-3 flex gap-3">
                    <div className="w-14 shrink-0">
                      <p className="text-[11px] font-bold text-gray-600">{shortDate(h.visit_date)}</p>
                      <ModeBadge mode={h.contact_mode} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-gray-400">
                        {h.salesperson}
                        {h.contact_person && ` · met ${h.contact_person}`}
                        {h.designation && ` (${h.designation})`}
                        {h.channel && ` · ${h.channel}`}
                      </p>
                      {h.notes.length === 0 && <p className="text-xs text-gray-300 italic">no remark</p>}
                      {h.notes.map((nt, i) => (
                        <p key={i} className="text-xs text-gray-700 mt-0.5 leading-relaxed">
                          <span className="text-[9px] font-bold uppercase text-gray-400 mr-1">{nt.label}</span>
                          {nt.text}
                        </p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
