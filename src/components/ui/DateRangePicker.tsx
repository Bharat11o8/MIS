import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One range picker for the whole app, in two granularities.
 *
 *   granularity="day"    two side-by-side month grids, pick a start and an end.
 *   granularity="month"  a financial-year grid of months, laid out a quarter to
 *                        a row. Picking Apr and Jun means "all of Apr, May and
 *                        June" — the range it emits is the 1st of the first
 *                        month to the LAST day of the last one.
 *
 * The month mode exists because some data is only ever a per-month figure — a
 * quarterly target is a number for April, and a third of one is not a real
 * quantity. A day picker there invites you to choose 17 Apr–23 May and then
 * silently answers for Apr–May instead. The month grid asks the question the
 * data can actually answer.
 *
 * `enabledMonths` dims what isn't there. Being unable to pick a period nothing
 * has been loaded for beats picking it and reading an empty screen.
 */

export interface DateRange { from: string; to: string }

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
  granularity?: "day" | "month";
  /** month mode: selectable months as "YYYY-MM". Omit to allow every month. */
  enabledMonths?: string[];
  /** Shortcut ranges shown down the side of the panel. */
  presets?: { label: string; range: DateRange }[];
  placeholder?: string;
  className?: string;
  /** Anchor the panel's right edge to the trigger — for triggers near the
   *  right of the screen, where a left-anchored panel would overflow. */
  align?: "left" | "right";
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
// Indian FY rows: each row of the month grid is one quarter.
const FY_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
const QUARTER_LABELS = ["Q1", "Q2", "Q3", "Q4"];

const pad = (n: number) => String(n).padStart(2, "0");
const isoOf = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const monthKey = (y: number, m: number) => `${y}-${pad(m)}`;
const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
/** Parsed as LOCAL parts — never `new Date(iso)`, which reads as UTC and can
 *  slide a date a day backwards for anyone east of Greenwich. */
const parts = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
};
/** A calendar month's index on one continuous line, for range comparisons. */
const mVal = (y: number, m: number) => y * 12 + m;
/** Monday-first column of the 1st of a month. */
const leadingBlanks = (y: number, m: number) => (new Date(y, m - 1, 1).getDay() + 6) % 7;

/** The FY a month belongs to: Apr-Dec are the FY's start year, Jan-Mar the next. */
const fyOf = (y: number, m: number) => (m >= 4 ? y : y - 1);
const fyLabel = (fy: number) => `FY${pad(fy % 100)}-${pad((fy + 1) % 100)}`;

function formatDay(iso: string) {
  const { y, m, d } = parts(iso);
  return `${d} ${MONTHS_SHORT[m - 1]} ${String(y).slice(2)}`;
}
function formatMonth(iso: string) {
  const { y, m } = parts(iso);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

const isoDay = (d: Date) => isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());

/**
 * Shortcut ranges for day pickers — the periods people actually ask for.
 * A function, not a constant: a tab left open across midnight would otherwise
 * keep offering yesterday's "last 30 days".
 */
export function dayPresets(): { label: string; range: DateRange }[] {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth();
  const back = (n: number) => {
    const d = new Date(today); d.setDate(d.getDate() - n); return isoDay(d);
  };
  // Month index 3 is April, so April onwards is the current Indian FY.
  const fyStart = m >= 3 ? y : y - 1;
  return [
    { label: "Last 7 days", range: { from: back(6), to: isoDay(today) } },
    { label: "Last 30 days", range: { from: back(29), to: isoDay(today) } },
    { label: "This month", range: { from: isoDay(new Date(y, m, 1)), to: isoDay(today) } },
    // new Date(y, -1, …) rolls back into last December on its own.
    { label: "Last month", range: { from: isoDay(new Date(y, m - 1, 1)), to: isoDay(new Date(y, m, 0)) } },
    { label: "This FY", range: { from: isoDay(new Date(fyStart, 3, 1)), to: isoDay(today) } },
  ];
}

export default function DateRangePicker({
  value, onChange, granularity = "day", enabledMonths, presets,
  placeholder = "Pick a period", className, align = "left",
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  // The first click of a new range. While it's set the panel is mid-question,
  // and hovering paints the range that click would produce.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const complete = Boolean(value.from && value.to);
  const enabled = useMemo(
    () => (enabledMonths ? new Set(enabledMonths) : null),
    [enabledMonths],
  );

  // Open on what's already chosen, else on what's available, else on today.
  const initial = useMemo(() => {
    if (value.from) return parts(value.from);
    const first = enabledMonths?.slice().sort()[0];
    if (first) return { ...parts(`${first}-01`) };
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: 1 };
  }, [value.from, enabledMonths]);

  const [viewY, setViewY] = useState(initial.y);
  const [viewM, setViewM] = useState(initial.m);
  const [viewFY, setViewFY] = useState(fyOf(initial.y, initial.m));

  // Re-centre each time it opens, so it never reopens somewhere stale.
  useEffect(() => {
    if (!open) return;
    setViewY(initial.y);
    setViewM(initial.m);
    setViewFY(fyOf(initial.y, initial.m));
    setAnchor(null);
    setHover(null);
  }, [open, initial.y, initial.m]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = !complete
    ? placeholder
    : granularity === "month"
      ? (formatMonth(value.from) === formatMonth(value.to)
          ? formatMonth(value.from)
          : `${formatMonth(value.from)} – ${formatMonth(value.to)}`)
      : `${formatDay(value.from)} – ${formatDay(value.to)}`;

  /** Commit a range, normalising whichever end was clicked first. */
  const commit = (a: string, b: string) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (granularity === "month") {
      const s = parts(lo), e = parts(hi);
      onChange({ from: isoOf(s.y, s.m, 1), to: isoOf(e.y, e.m, daysInMonth(e.y, e.m)) });
    } else {
      onChange({ from: lo, to: hi });
    }
    setAnchor(null);
    setHover(null);
    setOpen(false);
  };

  const pick = (key: string) => {
    if (!anchor) { setAnchor(key); setHover(key); return; }
    commit(anchor, key);
  };

  // While mid-question the highlight follows the cursor; otherwise it shows
  // what's committed.
  const band = useMemo(() => {
    if (anchor) {
      const other = hover ?? anchor;
      return anchor <= other ? [anchor, other] : [other, anchor];
    }
    if (!complete) return null;
    return [value.from, value.to];
  }, [anchor, hover, complete, value.from, value.to]);

  return (
    <div className={cn("relative", className)} ref={wrap}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        className={cn(
          "h-9 flex items-center gap-2 text-xs font-medium border rounded-xl px-3 bg-white transition-all",
          "hover:border-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400",
          open ? "border-orange-400 ring-2 ring-orange-100" : "border-gray-200",
          complete ? "text-gray-800" : "text-gray-400",
        )}>
        <CalendarDays size={13} className={complete ? "text-orange-500" : "text-gray-400"} />
        {label}
        {complete && (
          <span role="button" tabIndex={-1} aria-label="Clear period"
            onClick={(e) => { e.stopPropagation(); onChange({ from: "", to: "" }); }}
            className="ml-0.5 text-gray-300 hover:text-red-500 transition-colors">
            <X size={12} />
          </span>
        )}
      </button>

      {open && (
        <div className={cn(
          "absolute z-50 mt-1.5 flex rounded-2xl border border-orange-100 bg-white shadow-xl p-3",
          align === "right" ? "right-0" : "left-0",
        )}>
          {presets && presets.length > 0 && (
            <div className="flex flex-col gap-0.5 pr-3 mr-3 border-r border-gray-100 min-w-[104px]">
              {presets.map((p) => (
                <button key={p.label} type="button"
                  onClick={() => { onChange(p.range); setAnchor(null); setOpen(false); }}
                  className="text-[11px] font-semibold text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded-lg px-2 py-1.5 text-left transition-colors">
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <div>
            {granularity === "month" ? (
              <MonthGrid
                fy={viewFY} onFy={setViewFY} enabled={enabled} band={band}
                onPick={pick} onHover={setHover} anchored={Boolean(anchor)}
              />
            ) : (
              <DayGrid
                y={viewY} m={viewM} band={band} onPick={pick} onHover={setHover}
                anchored={Boolean(anchor)}
                onShift={(step) => {
                  const next = viewM + step;
                  setViewY(viewY + Math.floor((next - 1) / 12));
                  setViewM(((next - 1 + 12) % 12) + 1);
                }}
              />
            )}
            <p className="text-[10px] text-gray-400 pt-2.5 mt-2.5 border-t border-gray-100 text-center">
              {anchor
                ? `Starts ${granularity === "month" ? formatMonth(anchor) : formatDay(anchor)} — now pick the other end`
                : complete ? label : "Pick the start of the period"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared cell styling for both grids, so a selected month and a selected day
 *  read as the same thing. */
function cellClass(inBand: boolean, isEnd: boolean, disabled: boolean) {
  return cn(
    "relative text-[11px] font-medium rounded-lg transition-colors",
    disabled && "text-gray-300 cursor-not-allowed",
    !disabled && !inBand && "text-gray-600 hover:bg-orange-50 hover:text-orange-600 cursor-pointer",
    !disabled && inBand && !isEnd && "bg-orange-50 text-orange-700 cursor-pointer",
    isEnd && "bg-orange-500 text-white font-bold cursor-pointer",
  );
}

function MonthGrid({ fy, onFy, enabled, band, onPick, onHover, anchored }: {
  fy: number; onFy: (n: number) => void;
  enabled: Set<string> | null;
  band: string[] | null;
  onPick: (key: string) => void;
  onHover: (key: string | null) => void;
  anchored: boolean;
}) {
  const lo = band ? mVal(parts(band[0]).y, parts(band[0]).m) : null;
  const hi = band ? mVal(parts(band[1]).y, parts(band[1]).m) : null;

  return (
    <div className="w-[236px]" onMouseLeave={() => !anchored && onHover(null)}>
      <div className="flex items-center justify-between px-1 pb-2">
        <NavButton onClick={() => onFy(fy - 1)} dir="prev" />
        <span className="text-xs font-bold text-gray-700">{fyLabel(fy)}</span>
        <NavButton onClick={() => onFy(fy + 1)} dir="next" />
      </div>
      <div className="flex flex-col gap-1">
        {[0, 1, 2, 3].map((q) => (
          <div key={q} className="flex items-center gap-1">
            <span className="w-5 text-[9px] font-bold text-gray-300 shrink-0">{QUARTER_LABELS[q]}</span>
            {FY_MONTHS.slice(q * 3, q * 3 + 3).map((m) => {
              const y = m >= 4 ? fy : fy + 1;
              const key = monthKey(y, m);
              const disabled = Boolean(enabled && !enabled.has(key));
              const v = mVal(y, m);
              const inBand = lo !== null && hi !== null && v >= lo && v <= hi;
              const isEnd = inBand && (v === lo || v === hi);
              return (
                <button key={key} type="button" disabled={disabled}
                  onClick={() => !disabled && onPick(`${key}-01`)}
                  onMouseEnter={() => !disabled && onHover(`${key}-01`)}
                  title={disabled ? "No data loaded for this month" : `${MONTHS_SHORT[m - 1]} ${y}`}
                  className={cn(cellClass(inBand, isEnd, disabled), "flex-1 h-8")}>
                  {MONTHS_SHORT[m - 1]}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {enabled && (
        <p className="text-[9px] text-gray-400 mt-2 text-center">Greyed months have no data loaded</p>
      )}
    </div>
  );
}

function DayGrid({ y, m, band, onPick, onHover, onShift, anchored }: {
  y: number; m: number;
  band: string[] | null;
  onPick: (key: string) => void;
  onHover: (key: string | null) => void;
  onShift: (step: number) => void;
  anchored: boolean;
}) {
  // Two months at once: a range that crosses a month boundary is the common
  // case, and paging mid-selection loses your place.
  const second = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return (
    <div className="flex gap-4" onMouseLeave={() => !anchored && onHover(null)}>
      {[{ y, m }, second].map((mo, i) => (
        <div key={i} className="w-[168px]">
          <div className="flex items-center justify-between px-1 pb-1.5">
            {i === 0 ? <NavButton onClick={() => onShift(-1)} dir="prev" /> : <span className="w-5" />}
            <span className="text-xs font-bold text-gray-700">
              {MONTHS_SHORT[mo.m - 1]} {mo.y}
            </span>
            {i === 1 ? <NavButton onClick={() => onShift(1)} dir="next" /> : <span className="w-5" />}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {WEEKDAYS.map((d, j) => (
              <span key={j} className="text-[9px] font-bold text-gray-300 text-center h-5 leading-5">{d}</span>
            ))}
            {Array.from({ length: leadingBlanks(mo.y, mo.m) }, (_, j) => <span key={`b${j}`} />)}
            {Array.from({ length: daysInMonth(mo.y, mo.m) }, (_, j) => {
              const d = j + 1;
              const key = isoOf(mo.y, mo.m, d);
              const inBand = Boolean(band && key >= band[0] && key <= band[1]);
              const isEnd = Boolean(band && (key === band[0] || key === band[1]));
              return (
                <button key={key} type="button"
                  onClick={() => onPick(key)}
                  onMouseEnter={() => onHover(key)}
                  className={cn(cellClass(inBand, isEnd, false), "h-6 w-6 mx-auto")}>
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function NavButton({ onClick, dir }: { onClick: () => void; dir: "prev" | "next" }) {
  return (
    <button type="button" onClick={onClick} aria-label={dir === "prev" ? "Previous" : "Next"}
      className="w-5 h-5 flex items-center justify-center rounded-md text-gray-400 hover:bg-orange-50 hover:text-orange-500 transition-colors">
      {dir === "prev" ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
    </button>
  );
}
