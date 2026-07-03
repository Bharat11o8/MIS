export interface LegendEntry {
  key: string;
  label: string;
  color: string;
}

// Shared swatch-legend row — every chart that encodes meaning in color
// (stacked areas, treemap cells, composition bars) must carry one of these,
// since color alone isn't self-explanatory to someone reading a screenshot.
export default function ChartLegend({ items }: { items: LegendEntry[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 pt-3 border-t border-gray-50">
      {items.map((item) => (
        <span key={item.key} className="flex items-center gap-1.5 text-[11px] text-gray-500">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}
