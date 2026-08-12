import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { X, Printer, Store, Target, CarFront, Percent, Package, Footprints } from "lucide-react";
import Select from "@/components/ui/Select";
import {
  API_URL, MONTH_SHORT, FilterBar, PeriodControls, StatCard,
  periodParams, usePeriod, useFilterOptions, toOpts, shortDate, type Period,
} from "../shared";
import { type DealerPerf, KPI, n0, pct } from "./model";
import DealerMap from "./DealerMap";
import DealerRankTable from "./DealerRankTable";
import DealerTrend from "./DealerTrend";
import DealerDrawer from "./DealerDrawer";
import { CoveragePanel, QuarterPanel, ContactEffectPanel } from "./panels";

export default function DealersTab({ headers }: { headers: Record<string, string> }) {
  // dealer_sales, not logs: this tab can only show OEMs we hold a dealer
  // sales file for, so the filter offers exactly those and grows by itself.
  const options = useFilterOptions<{
    oems: string[]; states: string[]; salespersons: string[];
  }>("dealer_sales", headers);
  const [oem, setOem] = useState("MSIL");
  const [salesperson, setSalesperson] = useState("");
  const [state, setState] = useState("");
  // Defaults to all time: dealer sales start in January while the log book only
  // starts in July, so landing on "this month" would open the tab on a month
  // with no sales in it at all.
  const period = usePeriod("all");
  const [data, setData] = useState<DealerPerf | null>(null);
  const [loading, setLoading] = useState(true);
  const [openDealer, setOpenDealer] = useState<string | null>(null);

  useEffect(() => {
    const pp = periodParams(period.mode, period.token, period.range);
    if (!pp) return;
    const params = new URLSearchParams(pp);
    if (oem) params.set("oem", oem);
    if (salesperson) params.set("salesperson", salesperson);
    if (state) params.set("state", state);
    // Aborting the stale request matters here: without it a slow older response
    // can land AFTER a newer one and quietly put yesterday's filter on screen.
    const ctrl = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/dealer-performance?${params}`,
          { headers, signal: ctrl.signal });
        if (res.ok) {
          const j: DealerPerf = await res.json();
          setData(j);
          // Captured from the first response and then left alone — the period
          // list must keep offering every month, not shrink to whatever the
          // current filter returned.
          period.setMonths((prev: Period[]) => prev.length ? prev : j.by_month.map((m) => ({
            year: Number(m.month.slice(0, 4)), month: Number(m.month.slice(5, 7)),
          })));
        }
        setLoading(false);
      } catch { /* aborted — the newer request owns the loading flag now */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.mode, period.token, period.range, oem, salesperson, state, headers]);

  // Reps come from filter-options (the dealer file's own assignment), NOT from
  // this view's by_salesperson rows — those are computed AFTER the rep/state
  // filters apply, so a dropdown built on them collapses to the one rep you
  // just picked and there is no way to switch to another without clearing.
  const reps = options?.salespersons ?? [];

  const k = data?.kpis;
  // The benchmark, NOT this view's own penetration. Filtering to a rep must not
  // change the yardstick their dealers are measured against, or a weak
  // territory reads as having the least to gain.
  const avgPene = k?.benchmark ?? k?.penetration ?? 0;
  const noSales = !!data && data.dealers.every((d) => !d.has_sales);

  return (
    <div className="flex flex-col gap-5">
      <FilterBar>
        <PeriodControls
          mode={period.mode} onMode={period.switchMode}
          token={period.token} onToken={period.setToken} options={period.options}
          range={period.range} onRange={period.setRange}
        />
        <Select value={oem} onChange={setOem} options={toOpts(options?.oems, "All OEMs")} placeholder="OEM" />
        <Select value={salesperson} onChange={setSalesperson}
          options={toOpts(reps, "All reps")} placeholder="Rep" />
        <Select value={state} onChange={setState} options={toOpts(options?.states, "All states")} placeholder="State" />
        {(salesperson || state) && (
          <button onClick={() => { setSalesperson(""); setState(""); }}
            className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-500">
            <X size={12} /> Clear
          </button>
        )}
        {/* A refetch after the first load used to be invisible — old numbers sat
            on screen with nothing saying a newer answer was on its way. */}
        {loading && <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />}
        <div className="flex items-center gap-2 ml-auto">
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 hover:text-brand-orange px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all"
            title="Print this view or save it as a PDF">
            <Printer size={12} /> PDF
          </button>
        </div>
      </FilterBar>

      {/* Sales are monthly figures, so a day range can only cut them to whole
          months. Saying so beats letting the numbers imply otherwise. */}
      {period.mode === "custom" && data?.period.date_from && (
        <p className="text-[11px] text-gray-400 -mt-2">
          Visits and calls counted {shortDate(data.period.date_from)}–{shortDate(data.period.date_to)}.
          Dealer sales are reported monthly, so those cover whole months
          ({MONTH_SHORT[Number(data.period.month_from!.slice(5, 7)) - 1]}–
          {MONTH_SHORT[Number(data.period.month_to!.slice(5, 7)) - 1]}).
        </p>
      )}

      {loading && !data && (
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-400">
          Loading dealer performance…
        </div>
      )}

      {k && (
        // One colour identity per idea, matching the drawer (see KPI in
        // model.ts): activity blue, conversion green, ours orange, context grey.
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Coverage" value={pct(k.coverage)}
            sub={`${n0(k.contacted)} of ${n0(k.dealers)} dealerships`}
            icon={<Store size={18} />} {...KPI.activity} />
          <StatCard label="Penetration" value={pct(k.penetration)}
            sub={k.ysasc == null
              ? "needs YSASC from the dealer file"
              : `${n0(k.ys_sale)} ours ÷ ${n0(k.ysasc)} YSASC`}
            icon={<Target size={18} />} {...KPI.conversion} />
          <StatCard label="Total sold" value={n0(k.oem_total)}
            sub="every cover, ours or not"
            icon={<CarFront size={18} />} {...KPI.neutral} />
          {/* The product side of the funnel. Kept next to penetration because
              the two answer different questions and get confused constantly:
              this one is what we make a part for, not what we sold. */}
          <StatCard label="Addressable %" value={pct(k.addressable_pct)}
            sub={k.ysasc == null ? "not supplied" : `${n0(k.ysasc)} YSASC of ${n0(k.oem_total)}`}
            icon={<Percent size={18} />} {...KPI.neutral} />
          <StatCard label="YS Sale" value={n0(k.ys_sale)}
            sub={k.target ? `target ${n0(k.target)}` : undefined}
            icon={<Package size={18} />} {...KPI.ours} />
          <StatCard label="Contacts" value={n0(k.visits + k.calls)}
            sub={`${n0(k.visits)} visits · ${n0(k.calls)} calls`}
            icon={<Footprints size={18} />} {...KPI.activity} />
        </div>
      )}

      {noSales && data && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800">
          <b>No dealer sales data for {oem} yet.</b> The OE team's dealer file currently
          covers MSIL only, so coverage and contact counts are real here but volumes,
          penetration and targets will stay empty until their {oem} tab arrives.
        </div>
      )}

      {data && !noSales && (
        <>
          <DealerMap dealers={data.dealers} avgPene={avgPene}
            onPick={(d) => setOpenDealer(d.id)} />
          <DealerRankTable dealers={data.dealers} avgPene={avgPene}
            onPick={(d) => setOpenDealer(d.id)} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CoveragePanel rows={data.by_salesperson} />
            <QuarterPanel rows={data.by_quarter} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <DealerTrend rows={data.by_month} benchmark={avgPene} />
            <ContactEffectPanel data={data.contact_effect} />
          </div>
        </>
      )}

      {data && noSales && <CoveragePanel rows={data.by_salesperson} />}

      <AnimatePresence>
        {openDealer && (
          <DealerDrawer dealerId={openDealer} headers={headers} benchmark={avgPene}
            onClose={() => setOpenDealer(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
