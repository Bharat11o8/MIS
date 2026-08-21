import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Store, Target, CarFront, Percent, Package, Footprints } from "lucide-react";
import Select from "@/components/ui/Select";
import {
  API_URL, MONTH_SHORT, FilterBar, FilterActions, ClearFilters, FilterSpinner,
  RefreshButton, PdfButton, PeriodControls, StatCard,
  periodParams, usePeriod, useFilterOptions, filterOpts, FILTER_LABELS,
  shortDate, useOEScope, ScopeNote, type Period,
} from "../shared";
import { type DealerPerf, KPI, n0, nOr, pct, hitPct, categoryLabel } from "./model";
import DealerMap from "./DealerMap";
import DealerRankTable from "./DealerRankTable";
import DealerDirectory from "./DealerDirectory";
import DealerTrend from "./DealerTrend";
import DealerDrawer from "./DealerDrawer";
import { CoveragePanel, QuarterPanel, ContactEffectPanel } from "./panels";

export default function DealersTab({ headers }: { headers: Record<string, string> }) {
  const { scoped, salesperson: scopeName } = useOEScope();
  // dealer_sales, not logs: this tab can only show OEMs we hold a dealer
  // sales file for, so the filter offers exactly those and grows by itself.
  const options = useFilterOptions<{
    oems: string[]; states: string[]; salespersons: string[]; products: string[];
  }>("dealer_sales", headers);
  const [oem, setOem] = useState("MSIL");
  const [salesperson, setSalesperson] = useState("");
  const [state, setState] = useState("");
  // Product exists because the OEMs disagree: MSIL's file is seat covers only,
  // TATA's sets a separate target for seat covers and for mats. Unfiltered means
  // every product summed, which is the whole picture for either.
  const [product, setProduct] = useState("");
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
  //
  // Re-fetched whenever the OEM changes, because the OEMs cover different
  // months and the union is wrong for each of them: MSIL's file runs Jan-Jul
  // 2026, TATA's starts in July. Unscoped, the TATA view offered six months
  // that could only ever draw an empty screen. A month in this picker is a
  // promise that there is something behind it.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (oem) qs.set("oem", oem);
        if (product) qs.set("product", product);
        const res = await fetch(`${API_URL}/oe-network/periods?${qs}`, { headers, signal: ctrl.signal });
        if (!res.ok) return;
        const j: { dealer_months?: Period[] } = await res.json();
        const months = j.dealer_months ?? [];
        period.setMonths(months);
        // Newest month that actually holds dealer sales.
        const newest = [...months].sort((a, b) => b.year - a.year || b.month - a.month)[0];
        if (!newest) { setLoading(false); return; }   // nothing registered yet
        // Keep the chosen month across an OEM switch when the new OEM also
        // covers it — switching MSIL→TATA in July should stay in July rather
        // than jumping, which reads as the filter having lost its place.
        // Otherwise fall to the newest month the new OEM does cover.
        const stillThere = months.some((m) => `${m.year}-${m.month}` === period.token);
        if (!stillThere) period.setToken(`${newest.year}-${newest.month}`);
      } catch { /* aborted or offline — the picker simply stays empty */ }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headers, refreshKey, oem, product]);

  useEffect(() => {
    const pp = periodParams(period.mode, period.token, period.range);
    if (!pp) return;
    const params = new URLSearchParams(pp);
    if (oem) params.set("oem", oem);
    if (salesperson) params.set("salesperson", salesperson);
    if (state) params.set("state", state);
    if (product) params.set("product", product);
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
  }, [period.mode, period.token, period.range, oem, salesperson, state, product,
      headers, refreshKey]);

  // Reps come from filter-options (the dealer file's own assignment), NOT from
  // this view's by_salesperson rows — those are computed AFTER the rep/state
  // filters apply, so a dropdown built on them collapses to the one rep you
  // just picked and there is no way to switch to another without clearing.
  const reps = options?.salespersons ?? [];

  const k = data?.kpis;
  // What the OEMs in view actually publish. TATA reports a target and what we
  // achieved against it and never how much the dealer sold, so penetration,
  // addressable % and everything read off them are unavailable rather than
  // zero — the panels built on them are not drawn at all, instead of drawing a
  // screen of dashes that looks like a failed load. Defaults true so the tab
  // renders its familiar shape while the first response is in flight.
  const funnel = data?.capabilities.funnel ?? true;
  const tgtPct = hitPct(k?.sold, k?.target);
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
        {!scoped && (
          <Select value={salesperson} onChange={setSalesperson}
            options={filterOpts(reps, "salesperson")}
            placeholder={FILTER_LABELS.salesperson.placeholder} />
        )}
        <Select value={oem} onChange={setOem} options={filterOpts(options?.oems, "oem")}
          placeholder={FILTER_LABELS.oem.placeholder} />
        <Select value={state} onChange={setState} options={filterOpts(options?.states, "state")}
          placeholder={FILTER_LABELS.state.placeholder} />
        {/* Type slot, after geography — the canonical order. Hand-built options
            because the labels differ from the values: the file says "MAT", the
            product is "Mats". Offered only where more than one product exists
            at all, so the OEMs that sell one thing get no dead control. */}
        {(options?.products?.length ?? 0) > 1 && (
          <Select value={product} onChange={setProduct}
            options={[{ value: "", label: FILTER_LABELS.product.all },
              ...(options?.products ?? []).map((c) => ({ value: c, label: categoryLabel(c) }))]}
            placeholder={FILTER_LABELS.product.placeholder} />
        )}
        <ClearFilters show={!!(salesperson || state || product)}
          onClear={() => { setSalesperson(""); setState(""); setProduct(""); }} />
        {/* A refetch after the first load used to be invisible — old numbers sat
            on screen with nothing saying a newer answer was on its way. */}
        <FilterSpinner show={loading} />
        <FilterActions>
          <RefreshButton onClick={() => setRefreshKey((n) => n + 1)} disabled={loading} />
          <PdfButton />
        </FilterActions>
      </FilterBar>

      {scoped && scopeName && (
        <ScopeNote salesperson={scopeName}>
          These are the dealers assigned to you in the OE dealer file, including
          any you have not contacted yet — that gap is the point of this tab. A
          dealer the file leaves unassigned is not shown to anyone.
        </ScopeNote>
      )}

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

      {/* One colour identity per idea, matching the drawer (see KPI in
          model.ts): activity blue, conversion green, ours orange, target
          purple, context grey. Two tile sets, because the two file shapes
          answer different questions — not the same tiles with blanks in them. */}
      {k && funnel && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Coverage" value={pct(k.coverage)}
            sub={`${n0(k.contacted)} of ${n0(k.dealers)} dealerships`}
            icon={<Store size={18} />} {...KPI.activity} />
          <StatCard label="Penetration" value={pct(k.penetration)}
            sub={k.ysasc == null
              ? "needs YSASC from the dealer file"
              : `${n0(k.ys_sale)} ours ÷ ${n0(k.ysasc)} YSASC`}
            icon={<Target size={18} />} {...KPI.conversion} />
          <StatCard label="Total sold" value={nOr(k.oem_total)}
            sub="every cover, ours or not"
            icon={<CarFront size={18} />} {...KPI.neutral} />
          {/* The product side of the funnel. Kept next to penetration because
              the two answer different questions and get confused constantly:
              this one is what we make a part for, not what we sold. */}
          <StatCard label="Addressable %" value={pct(k.addressable_pct)}
            sub={k.ysasc == null ? "not supplied" : `${n0(k.ysasc)} YSASC of ${nOr(k.oem_total)}`}
            icon={<Percent size={18} />} {...KPI.neutral} />
          <StatCard label="YS Sale" value={n0(k.ys_sale)}
            sub={k.target ? `target ${n0(k.target)}` : undefined}
            icon={<Package size={18} />} {...KPI.ours} />
          <StatCard label="Contacts" value={n0(k.visits + k.calls)}
            sub={`${n0(k.visits)} visits · ${n0(k.calls)} calls`}
            icon={<Footprints size={18} />} {...KPI.activity} />
        </div>
      )}

      {k && !funnel && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard label="Coverage" value={pct(k.coverage)}
            sub={`${n0(k.contacted)} of ${n0(k.dealers)} dealerships`}
            icon={<Store size={18} />} {...KPI.activity} />
          {/* Purple is `target` and never lands on a person — see KPI. */}
          <StatCard label="Target" value={n0(k.target)}
            sub="whole quarter, never pro-rated"
            icon={<Target size={18} />} {...KPI.target} />
          <StatCard label="Achieved" value={n0(k.sold)}
            sub="our units inside that quarter"
            icon={<Package size={18} />} {...KPI.ours} />
          <StatCard label="vs Target" value={pct(tgtPct)}
            sub={`${n0(k.sold)} of ${n0(k.target)} units`}
            icon={<Percent size={18} />} {...KPI.conversion} />
          <StatCard label="Contacts" value={n0(k.visits + k.calls)}
            sub={`${n0(k.visits)} visits · ${n0(k.calls)} calls`}
            icon={<Footprints size={18} />} {...KPI.activity} />
        </div>
      )}

      {/* Says what this OEM's file can and cannot answer, next to the numbers
          rather than in a tooltip — the alternative is a reader assuming the
          missing panels failed to load. */}
      {k && !funnel && (
        <p className="text-[11px] text-gray-500 -mt-2">
          {data && data.capabilities.oems > 1 ? (
            <>The OEMs in view do not all report how much their dealers sold in total, so
              penetration and addressable % are not shown for this selection. Pick a single
              OEM to see them where they exist.</>
          ) : (
            <>This OEM's dealer file reports a <b className="text-gray-600">target and what
              we achieved</b> against it, and never how many covers the dealer sold in
              total — so there is no penetration or addressable % to show. Achieved is our
              units inside the quarter the target covers.</>
          )}
        </p>
      )}

      {noSales && data && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800">
          <b>No dealer sales for {oem || "this selection"} in this period.</b> Coverage and
          contact counts are real here, but volumes and targets stay empty until the OE
          team's dealer file carries a tab for it — or until this period is one the tab
          covers.
        </div>
      )}

      {data && !noSales && (
        <>
          {/* Both axes of the map, both bands of the trend and the whole of the
              contact-effect panel are penetration — without a total to divide
              by there is nothing for them to plot, so they are left out rather
              than drawn empty. */}
          {funnel && (
            <DealerMap dealers={data.dealers} avgPene={avgPene}
              onPick={(d) => setOpenDealer(d.id)} />
          )}
          <DealerRankTable dealers={data.dealers} avgPene={avgPene} funnel={funnel}
            onPick={(d) => setOpenDealer(d.id)} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CoveragePanel rows={data.by_salesperson} />
            <QuarterPanel rows={data.by_quarter} funnel={funnel} />
          </div>
          {funnel && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <DealerTrend rows={data.by_month} benchmark={avgPene} />
              <ContactEffectPanel data={data.contact_effect} />
            </div>
          )}
        </>
      )}

      {data && noSales && <CoveragePanel rows={data.by_salesperson} />}

      {/* The complete searchable list — kept even when there are no sales for
          this OEM yet, because the dealers and their contact history are real. */}
      {data && data.dealers.length > 0 && (
        <DealerDirectory dealers={data.dealers} avgPene={avgPene} funnel={funnel}
          onPick={(d) => setOpenDealer(d.id)} />
      )}

      <AnimatePresence>
        {openDealer && (
          // The tab's period goes in with it: the drawer's headline figures are
          // scoped to the same window as the row that was clicked, so the two
          // reconcile instead of appearing to disagree.
          <DealerDrawer dealerId={openDealer} headers={headers} benchmark={avgPene}
            periodQuery={{
              ...(periodParams(period.mode, period.token, period.range) ?? {}),
              ...(product ? { product } : {}),
            }}
            onClose={() => setOpenDealer(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
