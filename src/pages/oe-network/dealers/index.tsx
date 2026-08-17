import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Store, Target, CarFront, Percent, Package, Footprints } from "lucide-react";
import Select from "@/components/ui/Select";
import {
  API_URL, MONTH_SHORT, FilterBar, FilterActions, ClearFilters, FilterSpinner,
  RefreshButton, PdfButton, PeriodControls, StatCard,
  periodParams, usePeriod, useFilterOptions, filterOpts, FILTER_LABELS,
  shortDate, type Period,
} from "../shared";
import { type DealerPerf, KPI, n0, pct } from "./model";
import DealerMap from "./DealerMap";
import DealerRankTable from "./DealerRankTable";
import DealerDirectory from "./DealerDirectory";
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
  // Monthly, like every other tab. It lands on the newest month the dealer
  // FILE actually covers, not the current calendar month — dealer sales run
  // ahead of or behind the log book, so "this month" could be a month with no
  // sales in it at all.
  const period = usePeriod("monthly");
  const [data, setData] = useState<DealerPerf | null>(null);
  const [loading, setLoading] = useState(true);
  const [openDealer, setOpenDealer] = useState<string | null>(null);
  // Bumped by Refresh — re-runs the fetch without changing any filter.
  const [refreshKey, setRefreshKey] = useState(0);

  // The months the dealer file covers, fetched up front. This cannot come from
  // the dealer-performance response the way it used to: the period picker now
  // defaults to a month, so with no month chosen no request fires at all, and
  // the list would never arrive to choose one from.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${API_URL}/oe-network/periods`, { headers, signal: ctrl.signal });
        if (!res.ok) return;
        const j: { dealer_months?: Period[] } = await res.json();
        const months = j.dealer_months ?? [];
        period.setMonths(months);
        // Newest month that actually holds dealer sales.
        const newest = [...months].sort((a, b) => b.year - a.year || b.month - a.month)[0];
        if (newest) period.setToken(`${newest.year}-${newest.month}`);
        else setLoading(false);   // nothing registered yet — stop the spinner
      } catch { /* aborted or offline — the picker simply stays empty */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers, refreshKey]);

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
        if (res.ok) setData(await res.json());
        setLoading(false);
      } catch { /* aborted — the newer request owns the loading flag now */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.mode, period.token, period.range, oem, salesperson, state, headers, refreshKey]);

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
        {/* Canonical order and vocabulary — person, then OEM, then geography.
            This dropdown said "Rep" while every other tab called the same field
            "Salesperson". */}
        <Select value={salesperson} onChange={setSalesperson}
          options={filterOpts(reps, "salesperson")}
          placeholder={FILTER_LABELS.salesperson.placeholder} />
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        <Select value={state} onChange={setState} options={filterOpts(options?.states, "state")}
          placeholder={FILTER_LABELS.state.placeholder} />
        <ClearFilters show={!!(salesperson || state)}
          onClear={() => { setSalesperson(""); setState(""); }} />
        {/* A refetch after the first load used to be invisible — old numbers sat
            on screen with nothing saying a newer answer was on its way. */}
        <FilterSpinner show={loading} />
        <FilterActions>
          <RefreshButton onClick={() => setRefreshKey((n) => n + 1)} disabled={loading} />
          <PdfButton />
        </FilterActions>
      </FilterBar>

      {/* Sales are monthly figures, so a day range can only cut them to whole
          months. Saying so beats letting the numbers imply otherwise. */}
      {period.mode === "custom" && data?.period.date_from && (
        <p className="text-[11px] text-gray-500 -mt-2">
          Visits and calls counted {shortDate(data.period.date_from)}–{shortDate(data.period.date_to)}.
          Dealer sales are reported monthly, so those cover whole months
          ({MONTH_SHORT[Number(data.period.month_from!.slice(5, 7)) - 1]}–
          {MONTH_SHORT[Number(data.period.month_to!.slice(5, 7)) - 1]}).
        </p>
      )}

      {loading && !data && (
        <div className="bg-white border border-orange-100 rounded-2xl p-10 text-center text-sm text-gray-500">
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

      {/* The complete searchable list — kept even when there are no sales for
          this OEM yet, because the dealers and their contact history are real. */}
      {data && data.dealers.length > 0 && (
        <DealerDirectory dealers={data.dealers} avgPene={avgPene}
          onPick={(d) => setOpenDealer(d.id)} />
      )}

      <AnimatePresence>
        {openDealer && (
          // The tab's period goes in with it: the drawer's headline figures are
          // scoped to the same window as the row that was clicked, so the two
          // reconcile instead of appearing to disagree.
          <DealerDrawer dealerId={openDealer} headers={headers} benchmark={avgPene}
            periodQuery={periodParams(period.mode, period.token, period.range) ?? {}}
            onClose={() => setOpenDealer(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
