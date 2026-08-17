import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatPeriodLabel(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

interface PeriodPickerProps {
  periods: string[]; // ISO date strings, ascending
  value: string;
  onChange: (v: string) => void;
  label?: string;
}

export default function PeriodPicker({ periods, value, onChange, label }: PeriodPickerProps) {
  const idx = periods.indexOf(value);

  const step = (delta: number) => {
    const next = idx + delta;
    if (next >= 0 && next < periods.length) onChange(periods[next]);
  };

  if (periods.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1"><CalendarDays size={12} /> {label}</span>}
      <div className="flex items-center bg-gray-100 rounded-xl overflow-hidden">
        <button
          onClick={() => step(-1)}
          disabled={idx <= 0}
          className="p-1.5 text-gray-500 hover:text-orange-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={14} />
        </button>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="text-xs font-semibold text-gray-700 bg-transparent outline-none px-1 py-1.5 cursor-pointer"
        >
          {periods.map((p) => (
            <option key={p} value={p}>{formatPeriodLabel(p)}</option>
          ))}
        </select>
        <button
          onClick={() => step(1)}
          disabled={idx === -1 || idx >= periods.length - 1}
          className="p-1.5 text-gray-500 hover:text-orange-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}
