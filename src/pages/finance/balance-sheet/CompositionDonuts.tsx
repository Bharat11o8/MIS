import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { formatINR, NEUTRAL_COLOR, GRID_LINE_COLOR } from "../format";
import type { LineItem } from "./types";
import { sectionSnapshotTopN } from "./snapshot";

const OTHER_COLOR = "#D8C7B1"; // sand
const FALLBACK_COLOR = NEUTRAL_COLOR;

interface DonutCardProps {
  title: string;
  lineItems: LineItem[];
  pickedPeriod: string;
  colorMap: Map<string, string>;
}

function DonutCard({ title, lineItems, pickedPeriod, colorMap }: DonutCardProps) {
  const { items: data, negative } = sectionSnapshotTopN(lineItems, pickedPeriod, 7);

  return (
    <div className="card-premium p-6">
      <h4 className="text-sm font-bold text-gray-800 mb-3">{title}</h4>
      {data.length === 0 ? (
        <div className="h-[240px] flex items-center justify-center text-sm text-gray-400">No data at this period.</div>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <PieChart>
            <Pie data={data} dataKey="amount" nameKey="line_label" innerRadius={60} outerRadius={95} paddingAngle={1.5}>
              {data.map((d) => (
                <Cell key={d.line_key} fill={d.line_key === "__other__" ? OTHER_COLOR : colorMap.get(d.line_key) ?? FALLBACK_COLOR} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v: number, name: string, entry: any) => [
                `${formatINR(v)}${entry?.payload?.percent !== null && entry?.payload?.percent !== undefined ? ` (${entry.payload.percent.toFixed(1)}%)` : ""}`,
                name,
              ]}
              contentStyle={{ background: "#fff", border: `1px solid ${GRID_LINE_COLOR}`, borderRadius: 12, fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      )}
      {negative.count > 0 && (
        <p className="text-[10px] text-gray-400 mt-1">
          {negative.count} item{negative.count > 1 ? "s" : ""} with a negative balance ({formatINR(negative.total)} total) not shown here — see the table for exact figures.
        </p>
      )}
    </div>
  );
}

interface CompositionDonutsProps {
  sourcesItems: LineItem[];
  applicationItems: LineItem[];
  pickedPeriod: string;
  sourcesColorMap: Map<string, string>;
  applicationColorMap: Map<string, string>;
}

export default function CompositionDonuts({ sourcesItems, applicationItems, pickedPeriod, sourcesColorMap, applicationColorMap }: CompositionDonutsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <DonutCard title="Sources of Funds — Composition" lineItems={sourcesItems} pickedPeriod={pickedPeriod} colorMap={sourcesColorMap} />
      <DonutCard title="Application of Funds — Composition" lineItems={applicationItems} pickedPeriod={pickedPeriod} colorMap={applicationColorMap} />
    </div>
  );
}
