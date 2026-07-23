/**
 * OE Network — Visit / Calling Log form (public, mobile-first).
 *
 * Replaces the Google Form the OEM salespeople use. Opened via a shared link;
 * no login, no dashboard — just a splash and the form. Reps fill this on
 * phones, so the layout is single-column, touch targets are >=48px and every
 * input uses a >=16px font (anything smaller makes iOS Safari zoom on focus).
 *
 * Conditional behaviour (per spec):
 *   • Mats Sales  — only when OEM is MSIL
 *   • Photo       — only when the contact mode is "Visit" (gallery only)
 *   • Email       — derived from the chosen name, submitted silently
 *   • City        — filtered by the chosen State
 *   • Dealership  — searchable, filtered by State
 *   • Remarks     — pick 1+ categories, each opens its own note; combined into
 *                   the single Remarks cell the sheet already has.
 *
 * Field names mirror the headers the OE log-book sync reads
 * (services/oe_network_sync.py :: LOG_COLUMNS) so submissions stay compatible
 * with the existing sheet + sync.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertCircle,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ImagePlus,
  Loader2,
  MapPin,
  MessageSquare,
  Search,
  Send,
  TrendingUp,
  User,
  X,
} from "lucide-react";

const logoSrc = "/amato-logo.png";
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// Keyless public API for Indian states + their cities.
const GEO_STATES_URL =
  "https://countriesnow.space/api/v0.1/countries/states/q?country=India";
const GEO_CITIES_URL =
  "https://countriesnow.space/api/v0.1/countries/state/cities/q?country=India&state=";

// ─── Option data ─────────────────────────────────────────────────────────────
// Salesperson → email. The rep only picks a name; the address rides along with
// the submission (never shown, never typed) so the sheet's email column always
// matches the person. Per-person sheet access is keyed on this.
const SALESPERSON_EMAILS: Record<string, string> = {
  "UMESH KALE": "umeshkale@autoformindia.com",
  "DEBASIS BEHERA": "debasis@autoformindia.com",
  "ASHOKA": "ashoka@autoformindia.com",
  "D PRASHANTH KUMAR": "prashanth@autoformindia.com",
  "PANKAJ VIG": "pankaj@autoformindia.com",
  "DURGESH": "durgesh@autoformindia.com",
};
const SALESPEOPLE = Object.keys(SALESPERSON_EMAILS);

const OEMS = ["KIA", "MSIL", "HYUNDAI", "TOYOTA", "TATA", "MAHINDRA"];
const CONTACT_MODES = ["Visit", "Calling"];

/** MSIL is the odd one out: it has no Mats Sales figure, but does need the
 *  dealership's channel (Arena / Nexa). Every other OEM is the reverse. */
const MSIL = "MSIL";
const MSIL_CHANNELS = ["Arena", "Nexa"];

const REMARK_CATEGORIES = ["Product Feedback", "Replacement", "Sales", "Others"];

// TODO(data): dealership master list, keyed by state. Empty for now — the field
// falls back to free text until the real list is supplied.
const DEALERSHIPS_BY_STATE: Record<string, string[]> = {};

/** Fallback so the State field still works if the geo API is unreachable. */
const INDIAN_STATES_FALLBACK = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam",
  "Bihar", "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli", "Daman and Diu",
  "Delhi", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir",
  "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh",
  "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
  "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana",
  "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
];

// ─── Form shape ──────────────────────────────────────────────────────────────
interface FormState {
  email: string;
  salesperson: string;
  oem: string;
  contact_mode: string;
  visit_date: string;
  state: string;
  city: string;
  dealership: string;
  address: string;
  contact_person: string;
  designation: string;
  car_sales: string;
  seat_cover_sales: string;
  mats_sales: string;
  channel: string; // MSIL only — Arena / Nexa
}

/** Local calendar date as YYYY-MM-DD. toISOString() would shift to UTC and can
 *  land on the previous day for IST users late in the evening. */
const todayISO = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** "22 Jul 2026" — friendlier than the raw ISO value in a read-only field. */
const formatDisplayDate = (iso: string) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

const EMPTY: FormState = {
  email: "",
  salesperson: "",
  oem: "",
  contact_mode: "",
  visit_date: todayISO(),
  state: "",
  city: "",
  dealership: "",
  address: "",
  contact_person: "",
  designation: "",
  car_sales: "",
  seat_cover_sales: "",
  mats_sales: "",
  channel: "",
};

const FIELD_LABELS: Record<keyof FormState, string> = {
  email: "Email",
  salesperson: "Sales Person's Name",
  oem: "OEM",
  contact_mode: "Visit / Calling",
  visit_date: "Visit / Calling Date",
  state: "State",
  city: "City",
  dealership: "Dealership",
  address: "Address",
  contact_person: "Contact Person",
  designation: "Designation",
  car_sales: "Monthly Car Sales",
  seat_cover_sales: "Monthly Seat Cover Sales",
  mats_sales: "Monthly Mats Sales",
  channel: "Arena / Nexa",
};

const REQUIRED: (keyof FormState)[] = [
  "salesperson",
  "oem",
  "contact_mode",
  "visit_date",
  "state",
  "city",
  "dealership",
];

// ─── Field styling ───────────────────────────────────────────────────────────
// h-[52px] + text-base (16px) — below 16px iOS Safari zooms the viewport on focus.
const fieldBase =
  "w-full h-[52px] px-4 rounded-2xl text-base text-gray-900 bg-white outline-none transition-colors duration-200 border border-gray-200 focus:border-orange-400 focus:ring-4 focus:ring-orange-100";
const areaBase =
  "w-full px-4 py-3 rounded-2xl text-base text-gray-900 bg-white outline-none transition-colors duration-200 border border-gray-200 focus:border-orange-400 focus:ring-4 focus:ring-orange-100 resize-y";

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="text-xs font-bold uppercase tracking-wider text-gray-500">
      {children}
      {required && <span className="text-orange-500 ml-0.5">*</span>}
    </label>
  );
}

function Section({
  title, icon, children,
}: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-orange-500">{icon}</span>
        <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-gray-700">{title}</h2>
        <div className="flex-1 h-px bg-gray-100" />
      </div>
      {children}
    </div>
  );
}

/** Custom dropdown — a native <select> renders an unstyleable OS menu (blue
 *  highlight, system font), so the list is built by hand to match the form. */
function SelectField({
  label, required, options, value, onChange, disabled, hint, placeholder,
}: {
  label: string; required?: boolean; options: string[]; value: string;
  onChange: (v: string) => void; disabled?: boolean; hint?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className="flex flex-col gap-2" ref={boxRef}>
      <Label required={required}>{label}</Label>
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={`${fieldBase} flex items-center justify-between text-left ${
            disabled ? "bg-gray-50 cursor-not-allowed" : ""
          } ${open ? "border-orange-400 ring-4 ring-orange-100" : ""}`}
        >
          <span className={value ? "text-gray-900" : "text-gray-400"}>
            {value || (disabled ? hint ?? "Select…" : placeholder ?? "Select…")}
          </span>
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: 0.18 }}
            className="text-gray-400 shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.span>
        </button>

        <AnimatePresence>
          {open && !disabled && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute z-30 left-0 right-0 top-[58px] max-h-64 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-1.5"
              style={{ boxShadow: "0 12px 32px rgba(0,0,0,0.12)" }}
            >
              {options.map((o) => {
                const active = o === value;
                return (
                  <button
                    key={o}
                    type="button"
                    onClick={() => { onChange(o); setOpen(false); }}
                    className={`w-full text-left px-3.5 py-3 rounded-xl text-base transition-colors flex items-center justify-between gap-2 ${
                      active
                        ? "bg-orange-50 text-orange-700 font-semibold"
                        : "text-gray-700 hover:bg-gray-50 active:bg-orange-50"
                    }`}
                  >
                    <span>{o}</span>
                    {active && <Check size={16} className="shrink-0 text-orange-500" />}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Type-to-filter combobox. Falls back to plain free text when no options exist. */
function SearchableField({
  label, required, options, value, onChange, placeholder, disabled, hint, loading,
}: {
  label: string; required?: boolean; options: string[]; value: string;
  onChange: (v: string) => void; placeholder?: string; disabled?: boolean;
  hint?: string; loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Show the committed value until the user starts typing a new search.
  const shown = open ? query : value;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return list.slice(0, 50);
  }, [options, query]);

  return (
    <div className="flex flex-col gap-2" ref={boxRef}>
      <Label required={required}>{label}</Label>
      <div className="relative">
        <Search
          size={15}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
        />
        <input
          className={`${fieldBase} pl-10 ${disabled ? "bg-gray-50" : ""}`}
          value={shown}
          disabled={disabled}
          placeholder={disabled ? hint ?? placeholder : loading ? "Loading…" : placeholder}
          autoComplete="off"
          onFocus={() => { setOpen(true); setQuery(""); }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            // Free-text is allowed — keep the typed value even with no match.
            onChange(e.target.value);
          }}
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => { onChange(""); setQuery(""); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full flex items-center justify-center text-gray-400 active:bg-gray-100"
            aria-label={`Clear ${label}`}
          >
            <X size={14} />
          </button>
        )}
        <AnimatePresence>
          {open && !disabled && matches.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute z-30 left-0 right-0 top-[58px] max-h-64 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-1.5"
              style={{ boxShadow: "0 12px 32px rgba(0,0,0,0.12)" }}
            >
              {matches.map((o) => {
                const active = o === value;
                return (
                  <button
                    key={o}
                    type="button"
                    onClick={() => { onChange(o); setQuery(""); setOpen(false); }}
                    className={`w-full text-left px-3.5 py-3 rounded-xl text-base transition-colors flex items-center justify-between gap-2 ${
                      active
                        ? "bg-orange-50 text-orange-700 font-semibold"
                        : "text-gray-700 hover:bg-gray-50 active:bg-orange-50"
                    }`}
                  >
                    <span>{o}</span>
                    {active && <Check size={16} className="shrink-0 text-orange-500" />}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Splash ──────────────────────────────────────────────────────────────────
function Splash() {
  return (
    <motion.div
      key="splash"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center px-6"
      style={{ background: "linear-gradient(150deg, #1a1005 0%, #2b1608 55%, #3a1a08 100%)" }}
    >
      <motion.img
        src={logoSrc}
        alt="Amato Automotive"
        className="h-14 w-auto"
        style={{ filter: "brightness(0) invert(1)" }}
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.7, ease: [0.4, 0, 0.2, 1] }}
      />
      <motion.p
        className="text-[10px] font-bold uppercase tracking-[0.28em] text-white/70 mt-4 text-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35, duration: 0.5 }}
      >
        OE Network · Visit Log
      </motion.p>
      <motion.div
        className="mt-8 h-0.5 rounded-full bg-orange-500/80"
        initial={{ width: 0 }}
        animate={{ width: 110 }}
        transition={{ delay: 0.2, duration: 1.1, ease: "easeInOut" }}
      />
    </motion.div>
  );
}

export default function VisitLogFormPage() {
  const [showSplash, setShowSplash] = useState(true);
  const [form, setForm] = useState<FormState>(EMPTY);

  // Remark categories → note text. A category is "selected" when it has a key.
  const [remarks, setRemarks] = useState<Record<string, string>>({});

  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const [states, setStates] = useState<string[]>(INDIAN_STATES_FALLBACK);
  const [cities, setCities] = useState<string[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowSplash(false), 1600);
    return () => clearTimeout(t);
  }, []);

  // States from the geo API; the static fallback stays if it fails.
  useEffect(() => {
    let alive = true;
    fetch(GEO_STATES_URL)
      .then((r) => r.json())
      .then((j) => {
        const list: string[] = (j?.data?.states ?? []).map((s: { name: string }) => s.name);
        if (alive && list.length) setStates(list);
      })
      .catch(() => { /* keep fallback */ });
    return () => { alive = false; };
  }, []);

  // Cities for the chosen state.
  useEffect(() => {
    if (!form.state) {
      setCities([]);
      return;
    }
    let alive = true;
    setCitiesLoading(true);
    fetch(GEO_CITIES_URL + encodeURIComponent(form.state))
      .then((r) => r.json())
      .then((j) => {
        if (alive) setCities(Array.isArray(j?.data) ? j.data : []);
      })
      .catch(() => { if (alive) setCities([]); })
      .finally(() => { if (alive) setCitiesLoading(false); });
    return () => { alive = false; };
  }, [form.state]);

  useEffect(() => {
    if (!photo) { setPhotoPreview(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const set = (key: keyof FormState, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Email rides along with the name — never shown, never typed.
  const setSalesperson = (value: string) =>
    setForm((f) => ({ ...f, salesperson: value, email: SALESPERSON_EMAILS[value] ?? "" }));

  // A new State invalidates the City and Dealership picked under the old one.
  const setStateField = (value: string) =>
    setForm((f) => ({ ...f, state: value, city: "", dealership: "" }));

  // MSIL swaps Mats Sales for the Arena/Nexa channel — clear whichever no
  // longer applies so a stale value can't be submitted.
  const setOem = (value: string) =>
    setForm((f) => ({
      ...f,
      oem: value,
      mats_sales: value === MSIL ? "" : f.mats_sales,
      channel: value === MSIL ? f.channel : "",
    }));

  // Photo is Visit-only; drop it if they switch to Calling.
  const setContactMode = (value: string) => {
    setForm((f) => ({ ...f, contact_mode: value }));
    if (value !== "Visit") setPhoto(null);
  };

  const isMsil = form.oem === MSIL;
  const showMats = !!form.oem && !isMsil;   // every OEM except MSIL
  const showPhoto = form.contact_mode === "Visit";

  const dealershipOptions = form.state ? DEALERSHIPS_BY_STATE[form.state] ?? [] : [];

  const toggleRemark = (cat: string) =>
    setRemarks((r) => {
      if (cat in r) {
        const next = { ...r };
        delete next[cat];
        return next;
      }
      return { ...r, [cat]: "" };
    });

  /** "Product Feedback: xxx | Sales: yyy" — one cell, matching the sheet. */
  const combinedRemarks = useMemo(
    () =>
      REMARK_CATEGORIES.filter((c) => c in remarks)
        .map((c) => `${c}: ${remarks[c].trim()}`)
        .join(" | "),
    [remarks]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const missing = REQUIRED.filter((k) => !form[k].trim());
    if (missing.length) {
      setError(`Please fill: ${missing.map((k) => FIELD_LABELS[k]).join(", ")}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (isMsil && !form.channel) {
      setError("Please select Arena or Nexa.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const chosen = REMARK_CATEGORIES.filter((c) => c in remarks);
    if (chosen.length === 0) {
      setError("Please select at least one remark category.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const blank = chosen.filter((c) => !remarks[c].trim());
    if (blank.length) {
      setError(`Please write a remark for: ${blank.join(", ")}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    setSubmitting(true);
    try {
      const body = new FormData();
      // Re-stamp the date at submit time — the form may have sat open past midnight.
      Object.entries({ ...form, visit_date: todayISO() }).forEach(([k, v]) =>
        body.append(k, v)
      );
      body.append("remarks", combinedRemarks);
      body.append("remark_categories", chosen.join(", "));
      if (photo) body.append("photo", photo);

      const res = await fetch(`${API_URL}/visit-log/submit`, { method: "POST", body });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || "Could not submit. Please try again.");
      }
      setSubmitted(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit. Check your connection.");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setSubmitting(false);
    }
  };

  const resetForAnother = () => {
    setForm({ ...EMPTY, visit_date: todayISO() });
    setRemarks({});
    setPhoto(null);
    setSubmitted(false);
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="min-h-[100dvh] w-full bg-[#faf7f4]">
      <AnimatePresence>{showSplash && <Splash />}</AnimatePresence>

      <div
        className="w-full px-4 py-5 flex flex-col items-center gap-2"
        style={{
          background: "linear-gradient(150deg, #1a1005 0%, #2b1608 55%, #3a1a08 100%)",
          paddingTop: "max(1.25rem, env(safe-area-inset-top))",
        }}
      >
        <img
          src={logoSrc}
          alt="Amato Automotive"
          className="h-8 w-auto"
          style={{ filter: "brightness(0) invert(1)" }}
        />
        <p className="text-[9px] font-bold uppercase tracking-[0.24em] text-white/70 text-center">
          OE Network · Visit / Calling Log
        </p>
      </div>

      <div className="max-w-[560px] mx-auto px-4 py-6 pb-28">
        <AnimatePresence mode="wait">
          {submitted ? (
            <motion.div
              key="done"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white rounded-3xl border border-orange-100 p-8 flex flex-col items-center text-center gap-4"
              style={{ boxShadow: "0 10px 40px rgba(0,0,0,0.04)" }}
            >
              <CheckCircle2 size={44} className="text-green-500" />
              <h2 className="text-lg font-bold text-gray-800">Response recorded</h2>
              <p className="text-sm text-gray-500">Your visit log has been submitted. Thank you.</p>
              <button
                onClick={resetForAnother}
                className="mt-2 h-[52px] px-6 rounded-2xl text-sm font-bold uppercase tracking-wider text-white active:scale-[0.98] transition-transform"
                style={{
                  background: "linear-gradient(135deg, #9B2020, #6B1010)",
                  boxShadow: "0 4px 24px rgba(139, 20, 20, 0.35)",
                }}
              >
                Submit another response
              </button>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              onSubmit={handleSubmit}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: showSplash ? 1.6 : 0, duration: 0.45 }}
              className="bg-white rounded-3xl border border-orange-100 p-5 sm:p-7 flex flex-col gap-7"
              style={{ boxShadow: "0 10px 40px rgba(0,0,0,0.04)" }}
            >
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 px-3 py-3 rounded-2xl text-sm text-red-600"
                  style={{ background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)" }}
                >
                  <AlertCircle size={16} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </motion.div>
              )}

              {/* ── Visit details ── */}
              <Section title="Visit Details" icon={<User size={14} />}>
                <div className="flex flex-col gap-4">
                  <SelectField
                    label={FIELD_LABELS.salesperson}
                    required
                    options={SALESPEOPLE}
                    value={form.salesperson}
                    onChange={setSalesperson}
                  />
                  <SelectField
                    label={FIELD_LABELS.oem}
                    required
                    options={OEMS}
                    value={form.oem}
                    onChange={setOem}
                  />
                  <SelectField
                    label={FIELD_LABELS.contact_mode}
                    required
                    options={CONTACT_MODES}
                    value={form.contact_mode}
                    onChange={setContactMode}
                  />
                  {/* Always today — reps log the visit on the day it happened,
                      so the date is fixed rather than pickable. */}
                  <div className="flex flex-col gap-2">
                    <Label required>{FIELD_LABELS.visit_date}</Label>
                    <div
                      className="w-full h-[52px] px-4 rounded-2xl text-base bg-gray-50 border border-gray-200 flex items-center gap-2.5 text-gray-700"
                      aria-readonly="true"
                    >
                      <CalendarDays size={16} className="shrink-0 text-gray-400" />
                      <span>{formatDisplayDate(form.visit_date)}</span>
                    </div>
                  </div>
                </div>
              </Section>

              {/* ── Location ── */}
              <Section title="Location" icon={<MapPin size={14} />}>
                <div className="flex flex-col gap-4">
                  <SearchableField
                    label={FIELD_LABELS.state}
                    required
                    options={states}
                    value={form.state}
                    onChange={setStateField}
                    placeholder="Search state…"
                  />
                  <SearchableField
                    label={FIELD_LABELS.city}
                    required
                    options={cities}
                    value={form.city}
                    onChange={(v) => set("city", v)}
                    placeholder="Search city…"
                    disabled={!form.state}
                    hint="Select a state first"
                    loading={citiesLoading}
                  />
                </div>
              </Section>

              {/* ── Dealership (filtered by State, not City) ── */}
              <Section title="Dealership" icon={<Building2 size={14} />}>
                <div className="flex flex-col gap-4">
                  <SearchableField
                    label={FIELD_LABELS.dealership}
                    required
                    options={dealershipOptions}
                    value={form.dealership}
                    onChange={(v) => set("dealership", v)}
                    placeholder="Search dealership…"
                    disabled={!form.state}
                    hint="Select a state first"
                  />
                  <div className="flex flex-col gap-2">
                    <Label>{FIELD_LABELS.address}</Label>
                    <textarea
                      rows={2}
                      className={areaBase}
                      value={form.address}
                      onChange={(e) => set("address", e.target.value)}
                      placeholder="Dealership address"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>{FIELD_LABELS.contact_person}</Label>
                    <textarea
                      rows={2}
                      className={areaBase}
                      value={form.contact_person}
                      onChange={(e) => set("contact_person", e.target.value)}
                      placeholder="Person met"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>{FIELD_LABELS.designation}</Label>
                    <textarea
                      rows={2}
                      className={areaBase}
                      value={form.designation}
                      onChange={(e) => set("designation", e.target.value)}
                      placeholder="Their designation"
                    />
                  </div>
                </div>
              </Section>

              {/* ── Monthly figures ── */}
              <Section title="Dealer's Monthly Figures" icon={<TrendingUp size={14} />}>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label>{FIELD_LABELS.car_sales}</Label>
                    <input
                      type="number" inputMode="numeric" min="0"
                      className={fieldBase}
                      value={form.car_sales}
                      onChange={(e) => set("car_sales", e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label>{FIELD_LABELS.seat_cover_sales}</Label>
                    <input
                      type="number" inputMode="numeric" min="0"
                      className={fieldBase}
                      value={form.seat_cover_sales}
                      onChange={(e) => set("seat_cover_sales", e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  {/* Every OEM except MSIL reports mats; MSIL reports its
                      channel (Arena / Nexa) instead. */}
                  <AnimatePresence initial={false} mode="wait">
                    {showMats && (
                      <motion.div
                        key="mats"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="flex flex-col gap-2 overflow-hidden"
                      >
                        <Label>{FIELD_LABELS.mats_sales}</Label>
                        <input
                          type="number" inputMode="numeric" min="0"
                          className={fieldBase}
                          value={form.mats_sales}
                          onChange={(e) => set("mats_sales", e.target.value)}
                          placeholder="0"
                        />
                      </motion.div>
                    )}
                    {isMsil && (
                      <motion.div
                        key="channel"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="flex flex-col gap-2 overflow-hidden"
                      >
                        <Label required>{FIELD_LABELS.channel}</Label>
                        <div className="grid grid-cols-2 gap-2">
                          {MSIL_CHANNELS.map((c) => {
                            const on = form.channel === c;
                            return (
                              <button
                                key={c}
                                type="button"
                                onClick={() => set("channel", on ? "" : c)}
                                className={`h-[52px] px-3 rounded-2xl text-base font-medium border transition-colors flex items-center justify-center gap-2 ${
                                  on
                                    ? "bg-orange-50 border-orange-300 text-orange-700"
                                    : "bg-white border-gray-200 text-gray-600"
                                }`}
                              >
                                {on && <Check size={16} className="text-orange-500" />}
                                {c}
                              </button>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </Section>

              {/* ── Remarks: pick categories, each opens its own note ── */}
              <Section title="Remarks" icon={<MessageSquare size={14} />}>
                <div className="flex flex-col gap-3">
                  <Label required>Remark Category</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {REMARK_CATEGORIES.map((cat) => {
                      const on = cat in remarks;
                      return (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => toggleRemark(cat)}
                          className={`h-[52px] px-3 rounded-2xl text-sm font-medium border transition-colors ${
                            on
                              ? "bg-orange-50 border-orange-300 text-orange-700"
                              : "bg-white border-gray-200 text-gray-600"
                          }`}
                        >
                          {cat}
                        </button>
                      );
                    })}
                  </div>

                  <AnimatePresence initial={false}>
                    {REMARK_CATEGORIES.filter((c) => c in remarks).map((cat) => (
                      <motion.div
                        key={cat}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="flex flex-col gap-2 overflow-hidden"
                      >
                        <Label required>{cat}</Label>
                        <textarea
                          rows={3}
                          className={areaBase}
                          value={remarks[cat]}
                          onChange={(e) =>
                            setRemarks((r) => ({ ...r, [cat]: e.target.value }))
                          }
                          placeholder={`Notes on ${cat.toLowerCase()}…`}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </Section>

              {/* ── Photo: Visit only, gallery only ── */}
              <AnimatePresence initial={false}>
                {showPhoto && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <Section title="Photo" icon={<ImagePlus size={14} />}>
                      {photoPreview ? (
                        <div className="relative rounded-2xl overflow-hidden border border-gray-200">
                          <img src={photoPreview} alt="Selected" className="w-full max-h-72 object-cover" />
                          <button
                            type="button"
                            onClick={() => setPhoto(null)}
                            className="absolute top-2 right-2 h-10 w-10 rounded-full bg-black/60 text-white flex items-center justify-center active:bg-black/80"
                            aria-label="Remove photo"
                          >
                            <X size={18} />
                          </button>
                        </div>
                      ) : (
                        <label className="flex flex-col items-center justify-center gap-2 h-32 rounded-2xl border-2 border-dashed border-gray-200 active:border-orange-300 active:bg-orange-50/40 transition-colors cursor-pointer">
                          <ImagePlus size={22} className="text-gray-400" />
                          <span className="text-sm text-gray-500 font-medium">Choose from gallery</span>
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                          />
                        </label>
                      )}
                    </Section>
                  </motion.div>
                )}
              </AnimatePresence>

              <p className="text-center text-[10px] text-gray-400 uppercase tracking-wider">
                © {new Date().getFullYear()} Amato Automotive
              </p>
            </motion.form>
          )}
        </AnimatePresence>
      </div>

      {!submitted && (
        <div
          className="fixed bottom-0 left-0 right-0 px-4 pt-3 border-t border-orange-100 bg-white/95 backdrop-blur"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <div className="max-w-[560px] mx-auto">
            <button
              type="submit"
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full h-[52px] rounded-2xl text-sm font-bold uppercase tracking-wider text-white disabled:opacity-60 flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
              style={{
                background: submitting
                  ? "rgba(139, 28, 28, 0.5)"
                  : "linear-gradient(135deg, #9B2020, #6B1010)",
                boxShadow: submitting ? "none" : "0 4px 24px rgba(139, 20, 20, 0.35)",
              }}
            >
              {submitting ? (
                <><Loader2 size={16} className="animate-spin" />Submitting…</>
              ) : (
                <><Send size={15} />Submit</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
