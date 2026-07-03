// Shared formatters and design tokens for the Finance dashboards (Balance Sheet + P&L).
//
// Color system: a warm, muted "material" palette (leather/paper/wood/steel/
// stone) in place of bright saturated SaaS colors — reserved semantic colors
// (success/danger) are used only for increase/decrease, never for arbitrary
// categories. Sources of Funds and Application of Funds each get one fixed
// identity color reused everywhere they appear (trend chart, KPI cards, mover
// icons) so the same concept always reads the same color across the page.

export const SUCCESS_COLOR = "#4E7D57";
export const DANGER_COLOR = "#B5483A";
export const NEUTRAL_COLOR = "#8F8A83"; // stone — no data / direction unknown
export const SOURCES_COLOR = "#4E6575"; // steel blue
export const APPLICATION_COLOR = "#8B6A45"; // bronze
// P&L identity colors — one fixed color per headline concept, reused on every
// chart and card where that concept appears (same rule as Sources/Application).
export const REVENUE_COLOR = "#4E6575"; // steel blue
export const GROSS_PROFIT_COLOR = "#738A5A"; // olive
export const NETT_PROFIT_COLOR = "#8B6A45"; // bronze
export const GRID_LINE_COLOR = "#EAE3D6"; // warm, paper-toned axis/grid line
export const AXIS_TEXT_COLOR = "#8F8A83"; // stone

export function formatINR(n: number) {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

export function formatCr(n: number) {
  return `₹${(n / 1e7).toFixed(1)}Cr`;
}

// Compact magnitude for tight chart labels — Cr above 1 crore, L above 1 lakh.
export function formatCompact(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(abs / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `₹${(abs / 1e5).toFixed(1)}L`;
  return `₹${Math.round(abs).toLocaleString("en-IN")}`;
}

export function formatPct(n: number | null | undefined, digits = 1) {
  if (n === null || n === undefined) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function formatSignedINR(n: number | null | undefined) {
  if (n === null || n === undefined) return "—";
  return `${n >= 0 ? "+" : "-"}${formatINR(Math.abs(n))}`;
}

// Contract: always pass a raw delta (curr - prev), never a percentage.
// A percentage's sign can diverge from the delta's sign whenever the base
// value is negative — see aggregate.ts's computeDelta.
export function deltaColor(v: number | null | undefined) {
  if (v === null || v === undefined) return NEUTRAL_COLOR;
  return v >= 0 ? SUCCESS_COLOR : DANGER_COLOR;
}
