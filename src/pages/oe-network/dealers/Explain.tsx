/**
 * A plain-language note under a panel heading saying what the thing means.
 *
 * Not optional decoration: "Bottom 20 by Opportunity" reads like a list of bad
 * dealers when it is in fact a list of our best ones, and nobody should have to
 * reverse-engineer a sign convention from the numbers to find that out.
 */
export default function Explain({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 mb-3 rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
      <p className="text-[11px] leading-relaxed text-gray-500">{children}</p>
    </div>
  );
}
