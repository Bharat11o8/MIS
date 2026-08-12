import {
  Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Line, Legend, ComposedChart, ReferenceLine,
} from "recharts";
import { VISIT_COLOR, CALL_COLOR, TGT_TRACK, FUNNEL_MISSED, CHART_LABEL, MONTH_SHORT } from "../shared";
import { formatCompactNos } from "@/lib/format";
import { type DealerMonth, n0 } from "./model";
import Explain from "./Explain";

// Visits are orange on every other tab, but in THIS card orange already means
// "ours" — the funnel band and the penetration line sit directly above the
// activity strip, and two entities cannot share a colour inside one panel.
// So the strip's visits go teal here; calls keep their app-wide blue.
const ACT_VISIT = "#0d9488";

/**
 * The whole funnel, our share of it, and our activity — on one time axis.
 *
 * Replaces an earlier hand-rolled version that failed at the one job the panel
 * has. It drew penetration as a floating 1px mark per column with no line
 * joining them, so the trend had to be inferred by eye; it scaled the bars and
 * the marks to two different unlabelled maxima, so nothing could be read as a
 * value; and it showed activity as a single dot per mode, so one call and forty
 * looked identical. On the real data that hid the headline: penetration nearly
 * halved between March and June while their total volume barely moved.
 *
 * What it does now:
 *   • ONE stacked bar per month carrying all three levels of the funnel —
 *     ours, winnable-but-lost, and the part we hold no part number for. The
 *     orange against the first two bands IS penetration, drawn to scale, and
 *     against the whole bar it is our share of everything they sell. The eye
 *     gets both ratios without arithmetic.
 *   • A real connected line for penetration on its own right-hand axis, with a
 *     dashed reference at the OEM benchmark so "good" has a fixed position.
 *   • A separate aligned strip for visits and calls, to scale, so the question
 *     "did activity move it" can actually be looked at.
 *
 * Used for the whole network and for a single dealership unchanged; only the
 * magnitudes differ.
 */
export default function DealerTrend({ rows, benchmark, title = "Network trend", subject = "these dealerships" }: {
  rows: DealerMonth[]; benchmark?: number | null; title?: string; subject?: string;
}) {
  if (!rows.length) return null;

  const data = rows.map((r) => {
    const total = r.oem_total ?? null;
    const avail = r.ysasc ?? null;
    const ours = r.ys_sale ?? 0;
    // The bar IS the funnel, bottom to top: what we sold, the rest of what we
    // could have sold, and the part we make nothing for. Read the orange
    // against the first two bands and you have penetration; against the whole
    // bar and you have share.
    return {
      name: `${MONTH_SHORT[Number(r.month.slice(5, 7)) - 1]} '${r.month.slice(2, 4)}`,
      ours: total === null ? undefined : ours,
      missed: total === null ? undefined : Math.max(0, (avail ?? ours) - ours),
      unmade: total === null || avail === null ? undefined : Math.max(0, total - avail),
      pene: r.penetration ?? undefined,
      visits: r.visits,
      calls: r.calls,
    };
  });
  const anyUnmade = data.some((d) => (d.unmade ?? 0) > 0);
  const anyActivity = data.some((d) => d.visits > 0 || d.calls > 0);
  // Same margins on both charts so the two x axes line up column for column.
  // (The strip also carries an invisible right-hand spacer axis — see below —
  // because margins alone are not enough when the axes differ.)
  const margin = { top: 8, right: 8, bottom: 0, left: 0 };

  return (
    <div className="bg-white border border-orange-100 rounded-2xl p-5 print-avoid-break">
      <h3 className="text-sm font-bold text-gray-800">{title}</h3>
      <Explain>
        Each bar is one month of every seat cover {subject} sold, split into the whole
        funnel. The{" "}
        <span style={{ color: VISIT_COLOR }} className="font-semibold">orange part</span>{" "}
        is ours; the{" "}
        <span style={{ color: FUNNEL_MISSED }} className="font-semibold">dark grey</span>{" "}
        is what we could have won and didn&apos;t
        {anyUnmade && <>; the <span className="font-semibold text-gray-400">pale grey</span>{" "}
        on top is business we make no part for, which no amount of selling reaches</>}.
        So the orange measured against{" "}
        {anyUnmade ? <b className="text-gray-600">orange + dark grey</b> : "the bar"}{" "}
        <i>is</i> penetration, drawn to scale. The{" "}
        <span style={{ color: VISIT_COLOR }} className="font-semibold">orange line</span>{" "}
        reads it as a percentage against the right-hand axis
        {benchmark ? <>, and the dashed line is the {benchmark.toFixed(1)}% OEM average</> : null}.
        {anyActivity && <>{" "}The strip underneath is how many{" "}
          <span style={{ color: ACT_VISIT }} className="font-semibold">visits</span> and{" "}
          <span style={{ color: CALL_COLOR }} className="font-semibold">calls</span>{" "}
          were logged that month.</>}
      </Explain>

      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={data} margin={margin}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
          <YAxis yAxisId="units" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false}
            width={44} tickFormatter={(v: number) => formatCompactNos(v)} />
          <YAxis yAxisId="pct" orientation="right" tick={{ fontSize: 10, fill: VISIT_COLOR }}
            axisLine={false} tickLine={false} width={38} unit="%" />
          <Tooltip
            contentStyle={{ borderRadius: 12, border: "1px solid #ffe4d3", fontSize: 12 }}
            itemStyle={{ color: CHART_LABEL }}
            // Recharts hands the formatter the series NAME, not the dataKey —
            // the dataKey is on the third argument. Switching on the second
            // argument silently never matches, which is how the activity strip
            // below ended up labelling both its bars "Calls".
            formatter={(v: number, name: string, item: { dataKey?: string | number }) =>
              (item?.dataKey === "pene" ? [`${v}%`, name] : [n0(v), name])}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={7}
            formatter={(value: string) => <span style={{ color: CHART_LABEL }}>{value}</span>} />
          <Bar yAxisId="units" dataKey="ours" stackId="funnel" name="YS Sale — ours"
            fill={VISIT_COLOR} radius={[0, 0, 0, 0]} />
          <Bar yAxisId="units" dataKey="missed" stackId="funnel" name="YSASC — not won"
            fill={FUNNEL_MISSED} radius={anyUnmade ? [0, 0, 0, 0] : [4, 4, 0, 0]} />
          {anyUnmade ? (
            <Bar yAxisId="units" dataKey="unmade" stackId="funnel" name="No part number"
              fill={TGT_TRACK} radius={[4, 4, 0, 0]} />
          ) : null}
          {benchmark ? (
            <ReferenceLine yAxisId="pct" y={benchmark} stroke={VISIT_COLOR} strokeDasharray="4 4"
              strokeOpacity={0.5} />
          ) : null}
          <Line yAxisId="pct" type="monotone" dataKey="pene" name="Penetration"
            stroke={VISIT_COLOR} strokeWidth={2}
            dot={{ r: 3, fill: "#fff", stroke: VISIT_COLOR, strokeWidth: 2 }} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>

      {anyActivity && (
        <ResponsiveContainer width="100%" height={78}>
          <ComposedChart data={data} margin={margin}>
            <XAxis dataKey="name" hide />
            <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false}
              width={44} allowDecimals={false} />
            {/* Invisible spacer standing in for the funnel chart's 38px right-hand
                % axis. Without it this plot area is 38px wider than the one above
                and the month columns visibly shift out of line. */}
            <YAxis yAxisId="spacer" orientation="right" width={38}
              tick={false} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ borderRadius: 12, border: "1px solid #ffe4d3", fontSize: 12 }}
              itemStyle={{ color: CHART_LABEL }}
              formatter={(v: number, name: string) => [n0(v), name]}
            />
            <Bar dataKey="visits" stackId="act" name="Visits" fill={ACT_VISIT} />
            <Bar dataKey="calls" stackId="act" name="Calls" fill={CALL_COLOR} radius={[4, 4, 0, 0]} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
