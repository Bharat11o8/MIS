/**
 * ASM self-service — "My Visits" (public, OTP-only, read-only).
 *
 * A field rep's own view of their OE log-book entries: email -> OTP -> a
 * filterable table of just their rows, with CSV/XLSX export. No dashboard,
 * no login beyond the OTP, no way to see or edit anyone else's data — the
 * backend (routers/asm_portal.py) resolves the caller's salesperson identity
 * once at OTP verification and hard-filters every query to it server-side.
 *
 * Styled to match the authenticated dashboard (OENetworkPage's card/table/
 * filter conventions) rather than the public visit-log form — this is a
 * read-only data view the ASM will use repeatedly, and it will grow more
 * sections over time, so it should feel like the same product as the rest
 * of the MIS, just reached through a lighter gate.
 */
import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertCircle,
  Building2,
  Download,
  Footprints,
  LogOut,
  Mail,
  Phone,
  Search,
  ShieldCheck,
} from "lucide-react";
import Select from "@/components/ui/Select";
import DateRangePicker, { dayPresets } from "@/components/ui/DateRangePicker";

const logoSrc = "/amato-logo.png";
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const TOKEN_KEY = "asm_portal_token";
const SALESPERSON_KEY = "asm_portal_salesperson";

const VISIT_COLOR = "#f46617";
const CALL_COLOR = "#3b82f6";

const OEM_OPTS = [
  { value: "", label: "All OEMs" },
  { value: "KIA", label: "KIA" },
  { value: "MSIL", label: "MSIL" },
  { value: "HYUNDAI", label: "HYUNDAI" },
  { value: "TATA", label: "TATA" },
  { value: "MAHINDRA", label: "MAHINDRA" },
];
const MODE_OPTS = [
  { value: "", label: "Visits + Calls" },
  { value: "Visit", label: "Visit" },
  { value: "Calling", label: "Calling" },
];

interface VisitRow {
  visit_date: string | null;
  dealership: string;
  address: string | null;
  contact_person: string | null;
  contact_number: string | null;
  designation: string | null;
  car_sales: number | null;
  seat_cover_sales: number | null;
  mats_sales: number | null;
  remarks: string | null;
  remark_product_feedback: string | null;
  remark_replacement: string | null;
  remark_sales: string | null;
  remark_others: string | null;
  photo_link: string | null;
  email: string | null;
  oem: string | null;
  channel: string | null;
  contact_mode: string | null;
  city: string | null;
  state: string | null;
}

const inputClass =
  "h-9 px-3 rounded-xl border border-gray-200 text-xs text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all";
const fieldBase =
  "w-full h-11 px-4 rounded-xl text-sm text-gray-900 bg-white outline-none transition-colors duration-200 border border-gray-200 focus:border-orange-400 focus:ring-4 focus:ring-orange-100";

function shortDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function ModeBadge({ mode }: { mode: string | null }) {
  if (!mode) return <span className="text-gray-300">—</span>;
  const isVisit = mode === "Visit";
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full"
      style={isVisit ? { color: VISIT_COLOR, background: "#fff4ed" } : { color: CALL_COLOR, background: "#eff6ff" }}
    >
      {isVisit ? <Footprints size={10} /> : <Phone size={10} />}
      {mode}
    </span>
  );
}

// ─── Login: email -> OTP ─────────────────────────────────────────────────────
function LoginStep({ onLoggedIn }: { onLoggedIn: (token: string, salesperson: string) => void }) {
  const [step, setStep] = useState<"email" | "otp">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const requestOtp = async () => {
    if (!email.trim()) { setError("Enter your email."); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/asm-portal/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail || "Could not send OTP.");
      setNotice(data?.message || "OTP sent — check your inbox.");
      setStep("otp");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send OTP.");
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async () => {
    if (!otp.trim()) { setError("Enter the OTP."); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_URL}/asm-portal/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.detail || "Invalid or expired OTP.");
      onLoggedIn(data.access_token, data.salesperson);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid or expired OTP.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center p-4" style={{ background: "#fff2e6" }}>
      <div
        className="fixed top-[-50px] left-20 w-[400px] h-[400px] rounded-full pointer-events-none z-0"
        style={{ background: "radial-gradient(circle, rgba(244,102,23,0.07) 0%, transparent 70%)", filter: "blur(80px)" }}
      />
      <motion.div
        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        className="relative z-10 w-full max-w-[400px] bg-white border border-orange-100 rounded-2xl shadow-sm p-7 flex flex-col gap-5"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <img src={logoSrc} alt="Amato Automotive" className="h-7 w-auto mb-1" />
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: "#fff4ed", color: VISIT_COLOR }}>
            <ShieldCheck size={20} />
          </div>
          <h1 className="text-base font-bold text-gray-900">My Visits</h1>
          <p className="text-xs text-gray-500">
            {step === "email"
              ? "Enter your email to receive a login OTP."
              : `We sent a 6-digit code to ${email}.`}
          </p>
        </div>

        {step === "email" ? (
          <>
            <div className="relative">
              <Mail size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className={`${fieldBase} pl-11`}
                type="email"
                placeholder="you@autoformindia.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && requestOtp()}
                autoFocus
              />
            </div>
            {error && <p className="text-xs text-red-600 flex items-center gap-1.5"><AlertCircle size={13} />{error}</p>}
            <button
              type="button"
              onClick={requestOtp}
              disabled={loading}
              className="h-11 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 transition-all"
            >
              {loading && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {loading ? "Sending…" : "Send OTP"}
            </button>
          </>
        ) : (
          <>
            {notice && <p className="text-[11px] text-gray-400 -mt-2 text-center">{notice}</p>}
            <input
              className={`${fieldBase} text-center tracking-[0.4em] font-semibold`}
              inputMode="numeric"
              maxLength={6}
              placeholder="••••••"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && verifyOtp()}
              autoFocus
            />
            {error && <p className="text-xs text-red-600 flex items-center gap-1.5"><AlertCircle size={13} />{error}</p>}
            <button
              type="button"
              onClick={verifyOtp}
              disabled={loading}
              className="h-11 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 transition-all"
            >
              {loading && <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {loading ? "Verifying…" : "Verify & Continue"}
            </button>
            <button
              type="button"
              onClick={() => { setStep("email"); setOtp(""); setError(""); }}
              className="text-xs text-gray-400 hover:text-gray-600 underline"
            >
              Use a different email
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
}

// ─── Logged-in: filters + table ──────────────────────────────────────────────
function VisitsView({ token, salesperson, onLogout }: { token: string; salesperson: string; onLogout: () => void }) {
  const [rows, setRows] = useState<VisitRow[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ visits: 0, calls: 0, dealerships: 0 });
  const [page, setPage] = useState(1);
  const perPage = 30;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState<"csv" | "xlsx" | null>(null);

  const [oem, setOem] = useState("");
  const [contactMode, setContactMode] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [q, setQ] = useState("");

  const hasFilters = !!(oem || contactMode || fromDate || toDate || q);
  const clearFilters = () => { setOem(""); setContactMode(""); setFromDate(""); setToDate(""); setQ(""); };

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (oem) p.set("oem", oem);
    if (contactMode) p.set("contact_mode", contactMode);
    if (fromDate) p.set("from_date", fromDate);
    if (toDate) p.set("to_date", toDate);
    if (q.trim()) p.set("q", q.trim());
    return p;
  }, [oem, contactMode, fromDate, toDate, q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const p = new URLSearchParams(params);
    p.set("page", String(page));
    p.set("per_page", String(perPage));
    fetch(`${API_URL}/asm-portal/my-logs?${p.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.detail || "Session expired. Please log in again.");
        return data;
      })
      .then((data) => {
        if (!alive) return;
        setRows(data.data ?? []);
        setTotal(data.total ?? 0);
        setSummary(data.summary ?? { visits: 0, calls: 0, dealerships: 0 });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Could not load your visits.");
        if (String(e).toLowerCase().includes("session")) onLogout();
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, page, params]);

  useEffect(() => { setPage(1); }, [oem, contactMode, fromDate, toDate, q]);

  const doExport = async (fmt: "csv" | "xlsx") => {
    setExporting(fmt);
    try {
      const res = await fetch(`${API_URL}/asm-portal/my-logs/export.${fmt}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `visit-log_${salesperson.replace(/\s+/g, "_")}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Export failed. Please try again.");
    } finally {
      setExporting(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-lg font-bold text-gray-900">My Visits</h1>
          <p className="text-xs text-gray-400">{salesperson} · {total.toLocaleString("en-IN")} log entries</p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-red-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-red-200 transition-all"
        >
          <LogOut size={12} /> Log out
        </button>
      </div>

      {/* KPI row — reflects the current filter across ALL matching rows, not just this page */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white border border-orange-100 rounded-2xl p-4 flex items-center gap-3 shadow-sm min-w-0">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#fff4ed", color: VISIT_COLOR }}>
            <Footprints size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 truncate">Visits</p>
            <p className="text-xl font-black text-gray-800 leading-tight">{summary.visits}</p>
          </div>
        </div>
        <div className="bg-white border border-orange-100 rounded-2xl p-4 flex items-center gap-3 shadow-sm min-w-0">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#eff6ff", color: CALL_COLOR }}>
            <Phone size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 truncate">Calls</p>
            <p className="text-xl font-black text-gray-800 leading-tight">{summary.calls}</p>
          </div>
        </div>
        <div className="bg-white border border-orange-100 rounded-2xl p-4 flex items-center gap-3 shadow-sm min-w-0">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: "#f0f9ff", color: "#0ea5e9" }}>
            <Building2 size={18} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 truncate">Dealerships</p>
            <p className="text-xl font-black text-gray-800 leading-tight">{summary.dealerships}</p>
          </div>
        </div>
      </div>

      {/* Filters + table */}
      <div className="bg-white border border-orange-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-orange-50 flex items-center gap-2 flex-wrap">
          <DateRangePicker
            value={{ from: fromDate, to: toDate }}
            onChange={(r) => { setFromDate(r.from); setToDate(r.to); }}
            presets={dayPresets()} placeholder="All dates" />
          <Select value={oem} onChange={setOem} options={OEM_OPTS} placeholder="All OEMs" />
          <Select value={contactMode} onChange={setContactMode} options={MODE_OPTS} placeholder="Visits + Calls" />
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Dealership, city, state…"
              className={`${inputClass} pl-8 w-48`} />
          </div>
          {hasFilters && (
            <button onClick={clearFilters}
              className="text-[11px] font-semibold text-gray-400 hover:text-red-500">
              Clear
            </button>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <button onClick={() => doExport("csv")} disabled={exporting !== null || total === 0}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 disabled:opacity-50 transition-all">
              <Download size={12} /> CSV
            </button>
            <button onClick={() => doExport("xlsx")} disabled={exporting !== null || total === 0}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-50 transition-all">
              <Download size={12} /> Excel
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs px-4 py-2.5 flex items-center gap-2">
            <AlertCircle size={13} /> {error}
          </div>
        )}

        <div className="overflow-x-auto p-5 pt-3">
          <table className="w-full text-xs border-separate" style={{ borderSpacing: 0 }}>
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 whitespace-nowrap">
                <th className="py-2 pr-3 border-b border-gray-100">Visit Date / Calling Date</th>
                <th className="py-2 pr-3 border-b border-gray-100">Dealership Name</th>
                <th className="py-2 pr-3 border-b border-gray-100">Visit / Calling</th>
                <th className="py-2 pr-3 border-b border-gray-100">OEM</th>
                <th className="py-2 pr-3 border-b border-gray-100">Channel</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-gray-300">Contact Person</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-gray-300">Contact No.</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-gray-300">Designation</th>
                <th className="py-2 pr-3 border-b border-gray-100">City</th>
                <th className="py-2 pr-3 border-b border-gray-100">State</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-gray-300">Dealership Address</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-right">Total Car Sales</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-right">Total Seat Covers Sales</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-right">Mats Sales</th>
                <th className="py-2 pr-3 border-b border-gray-100 min-w-[200px]">Remarks</th>
                <th className="py-2 pr-3 border-b border-gray-100 min-w-[180px]">Product Feedback</th>
                <th className="py-2 pr-3 border-b border-gray-100 min-w-[180px]">Replacement</th>
                <th className="py-2 pr-3 border-b border-gray-100 min-w-[180px]">Sales</th>
                <th className="py-2 pr-3 border-b border-gray-100 min-w-[180px]">Others</th>
                <th className="py-2 pr-3 border-b border-gray-100 text-gray-300">Photo</th>
                <th className="py-2 border-b border-gray-100 text-gray-300">Email address</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={21} className="py-10 text-center">
                  <div className="w-5 h-5 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin inline-block" />
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={21} className="py-10 text-center text-gray-400">No visits match these filters.</td></tr>
              ) : rows.map((r, i) => (
                <tr key={i} className="hover:bg-orange-50/40 align-top">
                  <td className="py-2.5 pr-3 border-b border-gray-50 whitespace-nowrap text-gray-500">{shortDate(r.visit_date)}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 min-w-[160px] font-semibold text-gray-800 whitespace-nowrap">{r.dealership}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 whitespace-nowrap"><ModeBadge mode={r.contact_mode} /></td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-600 whitespace-nowrap">{r.oem || "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-600 whitespace-nowrap">{r.channel || "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-400 whitespace-nowrap">{r.contact_person || "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-400 whitespace-nowrap">{r.contact_number || "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-400 whitespace-nowrap">{r.designation || "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-500 whitespace-nowrap">{r.city || "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-500 whitespace-nowrap">{r.state || "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-400 max-w-[200px]">
                    <span className="line-clamp-1">{r.address || "—"}</span>
                  </td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-right text-gray-600">{r.car_sales ?? "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-right text-gray-600">{r.seat_cover_sales ?? "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-right text-gray-600">{r.mats_sales ?? "—"}</td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-600 max-w-[220px]">
                    <span className="line-clamp-2" title={r.remarks ?? undefined}>{r.remarks || "—"}</span>
                  </td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-600 max-w-[200px]">
                    <span className="line-clamp-2" title={r.remark_product_feedback ?? undefined}>{r.remark_product_feedback || "—"}</span>
                  </td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-600 max-w-[200px]">
                    <span className="line-clamp-2" title={r.remark_replacement ?? undefined}>{r.remark_replacement || "—"}</span>
                  </td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-600 max-w-[200px]">
                    <span className="line-clamp-2" title={r.remark_sales ?? undefined}>{r.remark_sales || "—"}</span>
                  </td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 text-gray-600 max-w-[200px]">
                    <span className="line-clamp-2" title={r.remark_others ?? undefined}>{r.remark_others || "—"}</span>
                  </td>
                  <td className="py-2.5 pr-3 border-b border-gray-50 whitespace-nowrap">
                    {r.photo_link ? (
                      <a href={r.photo_link} target="_blank" rel="noreferrer" className="text-orange-600 font-semibold hover:underline">
                        View
                      </a>
                    ) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="py-2.5 border-b border-gray-50 text-gray-400 whitespace-nowrap">{r.email || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 pb-4">
            <p className="text-[11px] text-gray-400">
              Page {page} of {totalPages} · {total.toLocaleString("en-IN")} rows
            </p>
            <div className="flex gap-2">
              <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-orange-200 disabled:opacity-40">
                Previous
              </button>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="text-xs font-semibold px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-orange-200 disabled:opacity-40">
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MyVisitsPage() {
  const [token, setToken] = useState<string | null>(null);
  const [salesperson, setSalesperson] = useState<string | null>(null);

  useEffect(() => {
    const t = sessionStorage.getItem(TOKEN_KEY);
    const sp = sessionStorage.getItem(SALESPERSON_KEY);
    if (t && sp) { setToken(t); setSalesperson(sp); }
  }, []);

  const handleLoggedIn = (t: string, sp: string) => {
    sessionStorage.setItem(TOKEN_KEY, t);
    sessionStorage.setItem(SALESPERSON_KEY, sp);
    setToken(t);
    setSalesperson(sp);
  };

  const handleLogout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SALESPERSON_KEY);
    setToken(null);
    setSalesperson(null);
  };

  if (token && salesperson) {
    return (
      <div className="min-h-[100dvh] w-full" style={{ background: "#fff2e6" }}>
        <AnimatePresence mode="wait">
          <motion.div key="table" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <VisitsView token={token} salesperson={salesperson} onLogout={handleLogout} />
          </motion.div>
        </AnimatePresence>
      </div>
    );
  }

  return <LoginStep onLoggedIn={handleLoggedIn} />;
}
