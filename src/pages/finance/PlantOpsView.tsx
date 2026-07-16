import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import {
  Card, KpiCard, DashboardControls, EmptyState, SectionHeading, UnitCostPanel,
  buildTimeline, bucketValue, bucketLabelsOf,
  type FinAnalytics, type FinGroup, type FinLineItem, type FinPoint,
} from "./dashboardKit";
import { SOURCES_COLOR, APPLICATION_COLOR, GRID_LINE_COLOR, AXIS_TEXT_COLOR } from "./format";
import type { TrendView } from "./aggregate";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const fmtQty = (n: number) => Math.round(n).toLocaleString("en-IN");

// Sum a set of line items into one total series (aligned by period).
function sumItems(items: FinLineItem[]): FinPoint[] {
  const byPeriod = new Map<string, FinPoint>();
  for (const it of items) {
    for (const p of it.series) {
      if (p.amount == null) continue;
      const cur = byPeriod.get(p.period_end_date);
      if (cur) cur.amount = (cur.amount ?? 0) + p.amount;
      else byPeriod.set(p.period_end_date, { ...p, amount: p.amount });
    }
  }
  return [...byPeriod.values()];
}

const EMPTY_SECTIONS = [
  { title: "Production Cost Stages", desc: "₹/set by Cutting · Production · Process · OH" },
  { title: "Alteration Report (Online / Offline)", desc: "Orders, alterations & rework rate %" },
  { title: "Stock Audit & Variance", desc: "Book vs physical, variance % & tolerance sign-off" },
];

export default function PlantOpsView({ sheetSourceId, refreshNonce = 0 }: { sheetSourceId: string; refreshNonce?: number }) {
  const { token } = useAuth();
  const [data, setData] = useState<FinAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<TrendView>("monthly");
  const [bucket, setBucket] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/finance/analytics?sheet_source_id=${sheetSourceId}&statement=plant_ops`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Could not load Plant Operations");
        return r.json();
      })
      .then((d: FinAnalytics) => { if (alive) setData(d); })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [sheetSourceId, token, refreshNonce]);

  const units: FinGroup | null = useMemo(() => data?.groups.find((g) => g.section_key === "units") ?? null, [data]);
  const salesSub = units?.sub_sections.find((s) => s.key === "sales");
  const prodSub = units?.sub_sections.find((s) => s.key === "productions");

  const unitCostGroup: FinGroup | null = useMemo(() => data?.groups.find((g) => g.section_key === "average_unit_cost") ?? null, [data]);
  const unitCostItems = useMemo(() => unitCostGroup?.sub_sections.flatMap((s) => s.line_items) ?? [], [unitCostGroup]);
  const hasUnitCost = unitCostItems.some((it) => it.series.some((p) => p.amount != null && p.amount > 0));

  const salesTotalSeries = useMemo(() => (salesSub ? sumItems(salesSub.line_items) : []), [salesSub]);
  const prodTotalSeries = useMemo(() => (prodSub ? sumItems(prodSub.line_items) : []), [prodSub]);
  // One universal period control for the whole tab — labels come from Units when
  // present, else from Unit Cost (the period set is identical either way).
  const labelSource = salesTotalSeries.length ? salesTotalSeries : (unitCostItems[0]?.series ?? []);
  const bucketLabels = useMemo(() => bucketLabelsOf(labelSource, "flow", view), [labelSource, view]);
  const effBucket = bucketLabels.includes(bucket) ? bucket : (bucketLabels[bucketLabels.length - 1] ?? "");

  const barData = useMemo(() => {
    if (!salesSub) return [];
    const prodByLabel = new Map((prodSub?.line_items ?? []).map((it) => [it.line_label, it]));
    return salesSub.line_items.map((it) => ({
      name: it.line_label,
      Sales: bucketValue(it.series, "flow", view, effBucket) ?? 0,
      Production: bucketValue(prodByLabel.get(it.line_label)?.series ?? [], "flow", view, effBucket) ?? 0,
    }));
  }, [salesSub, prodSub, view, effBucket]);

  const trendData = useMemo(() => {
    if (!salesSub) return [];
    const s = buildTimeline(salesTotalSeries, "flow", view);
    const p = buildTimeline(prodTotalSeries, "flow", view);
    const pByLabel = new Map(p.map((x) => [x.label, x.value]));
    return s.map((x) => ({ label: x.label, Sales: x.value, Production: pByLabel.get(x.label) ?? 0 }));
  }, [salesSub, salesTotalSeries, prodTotalSeries, view]);

  const unitCols = useMemo(() => bucketLabelsOf(salesTotalSeries, "flow", view).slice(-8), [salesTotalSeries, view]);

  const hasUnits = !!salesSub && salesSub.line_items.length > 0 && (data?.periods.length ?? 0) > 0;
  const salesTotal = hasUnits ? bucketValue(salesTotalSeries, "flow", view, effBucket) : null;
  const prodTotal = hasUnits ? bucketValue(prodTotalSeries, "flow", view, effBucket) : null;

  return (
    <div className="flex flex-col gap-6">
      {loading && <div className="text-sm text-gray-400 py-10 text-center">Loading Plant Operations…</div>}
      {error && <EmptyState>{error}</EmptyState>}

      {!loading && !error && (hasUnits || hasUnitCost) && (
        <DashboardControls view={view} onView={setView} labels={bucketLabels} bucket={effBucket} onBucket={setBucket} />
      )}

      {!loading && !error && hasUnits && (
        <>
          <SectionHeading>Units — Sales vs Production</SectionHeading>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <KpiCard label={`Units Sold · ${effBucket}`} value={salesTotal != null ? fmtQty(salesTotal) : "—"} accent={SOURCES_COLOR} />
            <KpiCard label={`Units Produced · ${effBucket}`} value={prodTotal != null ? fmtQty(prodTotal) : "—"} accent={APPLICATION_COLOR} />
            <KpiCard label="Production vs Sales"
              value={salesTotal && prodTotal ? `${Math.round((prodTotal / salesTotal) * 100)}%` : "—"}
              deltaPeriod={prodTotal != null && salesTotal != null ? (prodTotal >= salesTotal ? "producing to/above demand" : "under-producing vs demand") : null}
              deltaPct={prodTotal != null && salesTotal != null ? (prodTotal >= salesTotal ? 0 : -1) : null} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Sales vs Production by Category" note={`Units per product category · ${effBucket}`}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={barData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
                  <YAxis tickFormatter={fmtQty} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={54} />
                  <Tooltip formatter={(v: any, n: any) => [fmtQty(Number(v)), n]} contentStyle={{ fontSize: 12, borderRadius: 10, border: `1px solid ${GRID_LINE_COLOR}` }} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Sales" fill={SOURCES_COLOR} radius={[3, 3, 0, 0]} maxBarSize={40} />
                  <Bar dataKey="Production" fill={APPLICATION_COLOR} radius={[3, 3, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Sales & Production Over Time" note="Total units at the current granularity.">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trendData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_LINE_COLOR} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={{ stroke: GRID_LINE_COLOR }} />
                  <YAxis tickFormatter={fmtQty} tick={{ fontSize: 11, fill: AXIS_TEXT_COLOR }} tickLine={false} axisLine={false} width={54} />
                  <Tooltip formatter={(v: any, n: any) => [fmtQty(Number(v)), n]} contentStyle={{ fontSize: 12, borderRadius: 10, border: `1px solid ${GRID_LINE_COLOR}` }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="Sales" stroke={SOURCES_COLOR} strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="Production" stroke={APPLICATION_COLOR} strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <Card title="Units — detail" note="Values at the current granularity; use the View control at the top to switch.">
            <div className="overflow-x-auto">
              <table className="w-full text-[12px] border-collapse">
                <thead>
                  <tr className="border-b-2 border-gray-200">
                    <th className="text-left py-2 pr-3 font-semibold text-gray-500 sticky left-0 bg-white">Category</th>
                    {unitCols.map((c) => (
                      <th key={c} className="text-right py-2 px-3 font-semibold text-gray-500 whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {([["sales", salesSub], ["productions", prodSub]] as const).map(([key, sub]) => (
                    <Fragment key={key}>
                      <tr className="border-b border-gray-100">
                        <td colSpan={unitCols.length + 1} className="py-1.5 pr-3 font-bold text-gray-800 sticky left-0 bg-white">{key === "sales" ? "Sales" : "Production"}</td>
                      </tr>
                      {sub?.line_items.map((it: FinLineItem) => {
                        const m = new Map(buildTimeline(it.series, "flow", view).map((x) => [x.label, x.value]));
                        return (
                          <tr key={key + it.line_key} className="border-b border-gray-100">
                            <td className="py-2 pr-3 pl-3 text-gray-600 sticky left-0 bg-white">{it.line_label}</td>
                            {unitCols.map((c) => {
                              const v = m.get(c);
                              return <td key={c} className="py-2 px-3 text-right text-gray-600 whitespace-nowrap">{v != null ? fmtQty(v) : "—"}</td>;
                            })}
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {!loading && !error && hasUnitCost && unitCostGroup && (
        <>
          <SectionHeading accent={APPLICATION_COLOR}>Average Unit Cost</SectionHeading>
          <UnitCostPanel group={unitCostGroup} view={view} bucket={effBucket} />
        </>
      )}

      {!loading && !error && !hasUnits && !hasUnitCost && (
        <EmptyState>
          <div className="font-semibold text-gray-500 mb-1">No Plant Operations data yet</div>
          The Units and Unit Cost sections are empty for this company. Click “Sync Now” once the sheet has data.
        </EmptyState>
      )}

      {/* Sections still awaiting data from finance — auto-populate on future sync */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Awaiting data from finance</SectionHeading>
        <div className="grid gap-3 sm:grid-cols-2">
          {EMPTY_SECTIONS.map((it) => (
            <div key={it.title} className="bg-white border border-[#EAE3D6] rounded-2xl p-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-gray-700">{it.title}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">{it.desc}</div>
              </div>
              <span className="text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap bg-[#F5F0E8] text-[#8F8A83]">Empty in sheet</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
