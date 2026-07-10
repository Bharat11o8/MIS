// Shared number/date formatting for the Sales module (Plant-to-Depot +
// Depot-to-Distributor) — previously copy-pasted identically in both tab
// components, which let them drift out of sync during formatting changes.

export function formatINR(n: number): string {
  return "₹" + Math.round(n).toLocaleString("en-IN");
}

export function formatCr(n: number): string {
  return `₹${(n / 1e7).toFixed(1)}Cr`;
}

// Headline values are compact (₹22.5Cr) — the exact rupee figure lives in a
// hover title. Scales down to L/K so small figures don't render as "₹0.0Cr".
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
