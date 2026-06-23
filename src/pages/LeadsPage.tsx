import { useState, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Users, TrendingUp, PhoneCall, CheckCircle2, Clock, XCircle,
  BarChart2, MapPin, Award, RefreshCw, SlidersHorizontal, X
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from "recharts";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import MultiSelect from "@/components/ui/MultiSelect";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

// ── Colour maps ───────────────────────────────────────────────────────────────
const SOURCE_COLORS: Record<string, string> = {
  IVR: "#3b82f6", WhatsApp: "#22c55e", Instagram: "#f46617", Other: "#94a3b8",
};
const STATUS_COLORS: Record<string, string> = {
  "Closed Won": "#22c55e", "Closed Lost": "#ef4444", "Follow Up": "#f59e0b",
  "No Response": "#94a3b8", "Call Disconnected": "#6366f1",
  "Switch Off": "#f97316", "Complaint": "#ec4899",
};
const STATUS_BADGE: Record<string, string> = {
  "Closed Won": "bg-green-100 text-green-700",
  "Closed Lost": "bg-red-100 text-red-700",
  "Follow Up": "bg-yellow-100 text-yellow-700",
  "No Response": "bg-gray-100 text-gray-600",
  "Call Disconnected": "bg-purple-100 text-purple-700",
  "Switch Off": "bg-orange-100 text-orange-700",
  "Complaint": "bg-pink-100 text-pink-700",
};
const REASON_COLORS: Record<string, string> = {
  "Assigned to ASM": "#6366f1", "Already Bought": "#22c55e",
  "Images Shared": "#3b82f6", "Store Shared": "#f59e0b",
  "Inquiry": "#ec4899", "Other": "#94a3b8",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface MonthOption { year: number; month: number; label: string; date_from: string; date_to: string; }
interface FilterOptions {
  months: MonthOption[]; sources: string[]; asms: string[];
  call_statuses: string[]; rev_statuses: string[];
  reason_cats: string[]; states: string[];
}
interface ActiveFilters {
  year: number | null;
  months: number[]; // selected month numbers within `year`; empty = all months in that year
  source: string; asm: string; call_status: string;
  review_status: string; reason_category: string; state: string;
}

const EMPTY_FILTERS: ActiveFilters = {
  year: null, months: [], source: "", asm: "", call_status: "",
  review_status: "", reason_category: "", state: "",
};

const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Select helper ─────────────────────────────────────────────────────────────
function FilterSelect({
  label, value, onChange, options, allLabel = "All",
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: string[]; allLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-1 min-w-[130px]">
      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{label}</label>
      <Select
        value={value}
        onChange={onChange}
        options={[{ value: "", label: allLabel }, ...options.map((o) => ({ value: o, label: o }))]}
      />
    </div>
  );
}

export default function LeadsPage() {
  const { token } = useAuth();

  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [filters, setFilters] = useState<ActiveFilters>(EMPTY_FILTERS);
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [leads, setLeads] = useState<any[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(true);

  const headers = { Authorization: `Bearer ${token}` };

  // ── Load filter options once ───────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API_URL}/leads/filter-options`, { headers })
      .then((r) => r.json())
      .then(setFilterOptions)
      .catch(console.error);
  }, [token]);

  // ── Build query params from active filters ─────────────────────────────────
  const buildParams = useCallback((f: ActiveFilters) => {
    const p = new URLSearchParams();
    if (f.year !== null) {
      const monthsInYear = (filterOptions?.months ?? []).filter((m) => m.year === f.year);
      const selected = f.months.length === 0 ? monthsInYear : monthsInYear.filter((m) => f.months.includes(m.month));
      if (selected.length) {
        p.set("months", selected.map((m) => `${m.year}-${String(m.month).padStart(2, "0")}`).join(","));
      }
    }
    if (f.source) p.set("source", f.source);
    if (f.asm) p.set("asm", f.asm);
    if (f.call_status) p.set("call_status", f.call_status);
    if (f.review_status) p.set("review_status", f.review_status);
    if (f.reason_category) p.set("reason_category", f.reason_category);
    if (f.state) p.set("state", f.state);
    return p.toString();
  }, [filterOptions]);

  // ── Fetch all analytics + list whenever filters change ────────────────────
  const fetchData = useCallback(async (f: ActiveFilters) => {
    setLoading(true);
    const qs = buildParams(f);
    try {
      const [analyticsRes, listRes] = await Promise.all([
        fetch(`${API_URL}/leads/analytics${qs ? "?" + qs : ""}`, { headers }),
        fetch(`${API_URL}/leads/list?per_page=20${qs ? "&" + qs : ""}`, { headers }),
      ]);
      const [aData, lData] = await Promise.all([analyticsRes.json(), listRes.json()]);
      // Format trend periods
      if (aData.trends) {
        aData.trends = aData.trends.map((t: any) => ({
          ...t,
          period: new Date(t.period + "T00:00:00").toLocaleDateString("en-IN", {
            month: "short", year: "2-digit",
          }),
        }));
      }
      setAnalytics(aData);
      setLeads(lData.data || []);
      setTotalLeads(lData.total || 0);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [token, buildParams]);

  useEffect(() => { fetchData(filters); }, [filters, fetchData]);

  // ── Active filter count ────────────────────────────────────────────────────
  const activeCount = [
    filters.year !== null, filters.source, filters.asm, filters.call_status,
    filters.review_status, filters.reason_category, filters.state,
  ].filter(Boolean).length;

  const setFilter = (key: keyof ActiveFilters, value: any) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const clearAll = () => setFilters(EMPTY_FILTERS);

  // ── Year / Month filter (scales across years instead of one flat chip list) ─
  const availableYears = useMemo(() => {
    const years = Array.from(new Set((filterOptions?.months ?? []).map((m) => m.year)));
    return years.sort((a, b) => b - a);
  }, [filterOptions]);

  const monthsInSelectedYear = useMemo(() => {
    if (filters.year === null) return [];
    return (filterOptions?.months ?? [])
      .filter((m) => m.year === filters.year)
      .sort((a, b) => a.month - b.month);
  }, [filterOptions, filters.year]);

  const handleYearChange = (yearStr: string) =>
    setFilters((prev) => ({ ...prev, year: yearStr === "" ? null : Number(yearStr), months: [] }));

  const handleMonthsChange = (monthStrs: string[]) =>
    setFilter("months", monthStrs.map(Number));

  // ── KPI cards ──────────────────────────────────────────────────────────────
  const kpiCards = analytics ? [
    {
      id: "leads-total", label: "Total Leads", value: analytics.kpis.total.toLocaleString(),
      icon: <Users size={18} />, color: "#3b82f6", bg: "#eff6ff",
      sub: activeCount > 0 ? "Filtered result" : "All channels",
    },
    {
      id: "leads-won", label: "Closed Won", value: analytics.kpis.closed_won.toLocaleString(),
      icon: <CheckCircle2 size={18} />, color: "#22c55e", bg: "#f0fdf4",
      sub: "Converted leads",
    },
    {
      id: "leads-conversion", label: "Conversion Rate",
      value: `${analytics.kpis.conversion_rate}%`,
      icon: <TrendingUp size={18} />, color: "#3b82f6", bg: "#eff6ff",
      sub: "Lead to Closed Won",
    },
    {
      id: "leads-followup", label: "Follow Ups",
      value: analytics.kpis.follow_up.toLocaleString(),
      icon: <Clock size={18} />, color: "#f59e0b", bg: "#fffbeb",
      sub: "Pending follow-up",
    },
    {
      id: "leads-lost", label: "Closed Lost",
      value: analytics.kpis.closed_lost.toLocaleString(),
      icon: <XCircle size={18} />, color: "#ef4444", bg: "#fef2f2",
      sub: "Did not convert",
    },
        {
      id: "leads-source", label: "Top Channel",
      value: analytics.kpis.top_source ?? "—",
      icon: <PhoneCall size={18} />, color: "#f46617", bg: "#fff7ed",
      sub: `${analytics.kpis.top_source_count} leads`,
    },
  ] : [];

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-3">
            <span className="page-title-dark">LEADS</span>
            <span className="page-title-orange">ANALYTICS</span>
          </h1>
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mt-1">
            {analytics ? `${analytics.kpis.total.toLocaleString()} leads` : "Loading…"}
            {activeCount > 0 && <span className="text-orange-500"> · {activeCount} filter{activeCount > 1 ? "s" : ""} active</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => fetchData(filters)}
            className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-orange-500 transition-colors px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200">
            <RefreshCw size={13} /> Refresh
          </button>
          <button
            onClick={() => setFiltersOpen(!filtersOpen)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl border transition-all ${
              activeCount > 0
                ? "bg-orange-500 text-white border-orange-500"
                : "text-gray-600 border-gray-200 hover:border-orange-200"
            }`}>
            <SlidersHorizontal size={13} />
            Filters
            {activeCount > 0 && (
              <span className="bg-white text-orange-500 text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center">
                {activeCount}
              </span>
            )}
          </button>
        </div>
      </motion.div>

      {/* Filter panel */}
      <AnimatePresence>
        {filtersOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm">
              <div className="flex flex-wrap gap-4 items-end">
                {/* Year + Month */}
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Year</label>
                  <Select
                    value={filters.year !== null ? String(filters.year) : ""}
                    onChange={handleYearChange}
                    options={[
                      { value: "", label: "All Years" },
                      ...availableYears.map((y) => ({ value: String(y), label: String(y) })),
                    ]}
                    className="min-w-[110px]"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Month</label>
                  <MultiSelect
                    values={filters.months.map(String)}
                    onChange={handleMonthsChange}
                    options={monthsInSelectedYear.map((m) => ({ value: String(m.month), label: MONTH_NAMES[m.month - 1] }))}
                    placeholder="All Months"
                    disabled={filters.year === null}
                    className="min-w-[130px]"
                  />
                </div>

                <div className="w-px h-10 bg-gray-100 hidden xl:block" />

                {/* Dropdowns */}
                <FilterSelect label="Source" value={filters.source}
                  onChange={(v) => setFilter("source", v)}
                  options={filterOptions?.sources ?? []} />

                <FilterSelect label="ASM" value={filters.asm}
                  onChange={(v) => setFilter("asm", v)}
                  options={filterOptions?.asms ?? []} allLabel="All ASMs" />

                <FilterSelect label="Call Status" value={filters.call_status}
                  onChange={(v) => setFilter("call_status", v)}
                  options={filterOptions?.call_statuses ?? []} />

                <FilterSelect label="Review Status" value={filters.review_status}
                  onChange={(v) => setFilter("review_status", v)}
                  options={filterOptions?.rev_statuses ?? []} />

                <FilterSelect label="Reason" value={filters.reason_category}
                  onChange={(v) => setFilter("reason_category", v)}
                  options={filterOptions?.reason_cats ?? []} />

                <FilterSelect label="State" value={filters.state}
                  onChange={(v) => setFilter("state", v)}
                  options={filterOptions?.states ?? []} />

                {/* Clear */}
                {activeCount > 0 && (
                  <button onClick={clearAll}
                    className="flex items-center gap-1 text-xs font-semibold text-red-500 hover:text-red-600 px-3 py-2 rounded-xl border border-red-200 hover:bg-red-50 transition-all self-end">
                    <X size={12} /> Clear all
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Loading overlay */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-4 text-sm text-gray-400">
          <div className="w-4 h-4 border-2 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
          Updating charts…
        </div>
      )}

      {analytics && !loading && (
        <>
          {/* KPI Cards */}
          <motion.div variants={container} initial="hidden" animate="show"
            className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
            {kpiCards.map((kpi) => (
              <motion.div key={kpi.id} variants={item} id={kpi.id} className="kpi-card">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ background: kpi.bg, color: kpi.color }}>
                  {kpi.icon}
                </div>
                <div className="mt-3">
                  <p className="text-2xl font-black text-gray-900">{kpi.value}</p>
                  <p className="text-xs font-bold text-gray-500 mt-0.5">{kpi.label}</p>
                  <p className="text-[11px] text-gray-400">{kpi.sub}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>

          {/* Row 1: Monthly Trend + Source donut */}
          <motion.div variants={container} initial="hidden" animate="show"
            className="grid grid-cols-1 xl:grid-cols-3 gap-4">

            <motion.div variants={item} className="card-premium p-6 xl:col-span-2">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
                  <TrendingUp size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Monthly Lead Volume</h3>
                  <p className="text-[11px] text-gray-400">Leads per month — filtered result</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={analytics.trends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Legend iconType="circle" iconSize={8}
                    formatter={(v) => <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{v}</span>} />
                  <Line type="monotone" dataKey="count" stroke="#f46617" strokeWidth={2.5}
                    dot={{ fill: "#f46617", r: 4 }} activeDot={{ r: 6 }} name="Total Leads" />
                  <Line type="monotone" dataKey="closed_won" stroke="#22c55e" strokeWidth={2.5}
                    dot={{ fill: "#22c55e", r: 4 }} activeDot={{ r: 6 }} name="Closed Won" />
                  <Line type="monotone" dataKey="follow_up" stroke="#f59e0b" strokeWidth={2.5}
                    dot={{ fill: "#f59e0b", r: 4 }} activeDot={{ r: 6 }} name="Follow Up" />
                </LineChart>
              </ResponsiveContainer>
            </motion.div>

            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500">
                  <PhoneCall size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Source Split</h3>
                  <p className="text-[11px] text-gray-400">Lead distribution by channel</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={analytics.sources} cx="50%" cy="45%" innerRadius={50} outerRadius={75}
                    paddingAngle={4} dataKey="count" nameKey="source">
                    {analytics.sources.map((s: any) => (
                      <Cell key={s.source} fill={SOURCE_COLORS[s.source] ?? "#94a3b8"} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Legend iconType="circle" iconSize={8}
                    formatter={(v) => <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{v}</span>} />
                </PieChart>
              </ResponsiveContainer>
            </motion.div>
          </motion.div>

          {/* Row 2: Call status + Review status */}
          <motion.div variants={container} initial="hidden" animate="show"
            className="grid grid-cols-1 xl:grid-cols-2 gap-4">

            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
                  <PhoneCall size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Initial Call Status</h3>
                  <p className="text-[11px] text-gray-400">First-contact outcome distribution</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={analytics.call_status} layout="vertical" barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis dataKey="status" type="category" tick={{ fontSize: 11, fill: "#64748b" }}
                    width={110} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} name="Leads">
                    {analytics.call_status.map((s: any) => (
                      <Cell key={s.status} fill={STATUS_COLORS[s.status] ?? "#94a3b8"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </motion.div>

            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-5">
                <div className="w-8 h-8 rounded-xl bg-green-50 flex items-center justify-center text-green-500">
                  <CheckCircle2 size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Review Outcome</h3>
                  <p className="text-[11px] text-gray-400">Post-follow-up status distribution</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={analytics.review_status} layout="vertical" barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                  <YAxis dataKey="status" type="category" tick={{ fontSize: 11, fill: "#64748b" }}
                    width={120} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
                  <Bar dataKey="count" radius={[0, 6, 6, 0]} name="Leads">
                    {analytics.review_status.map((s: any) => (
                      <Cell key={s.status} fill={STATUS_COLORS[s.status] ?? "#94a3b8"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </motion.div>
          </motion.div>

          {/* Row 3: ASM performance + Top states + Reason categories */}
          <motion.div variants={container} initial="hidden" animate="show"
            className="grid grid-cols-1 xl:grid-cols-3 gap-4">

            {/* ASM performance */}
            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-xl bg-purple-50 flex items-center justify-center text-purple-500">
                  <Award size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">ASM Performance</h3>
                  <p className="text-[11px] text-gray-400">Leads shared & won</p>
                </div>
              </div>
              <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                {analytics.asm_performance.length === 0 && (
                  <p className="text-xs text-gray-400 text-center py-4">No data for this filter</p>
                )}
                {analytics.asm_performance.slice(0, 12).map((a: any, i: number) => (
                  <div key={a.asm} className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-gray-400 w-4">{i + 1}</span>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-0.5">
                        <button
                          onClick={() => setFilter("asm", filters.asm === a.asm ? "" : a.asm)}
                          className={`text-xs font-semibold transition-colors ${
                            filters.asm === a.asm ? "text-orange-500" : "text-gray-700 hover:text-orange-500"
                          }`}
                        >
                          {a.asm}
                        </button>
                        <span className="text-xs text-gray-400">{a.total}</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-orange-400 to-orange-500"
                          style={{ width: `${(a.total / (analytics.asm_performance[0]?.total || 1)) * 100}%` }} />
                      </div>
                    </div>
                    <span className="text-[10px] font-bold text-green-600 w-8 text-right">{a.closed_won}✓</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Top states */}
            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
                  <MapPin size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Top States</h3>
                  <p className="text-[11px] text-gray-400">Click to filter by state</p>
                </div>
              </div>
              <div className="space-y-2.5">
                {analytics.top_states.map((s: any, i: number) => (
                  <div key={s.state} className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-gray-400 w-4">{i + 1}</span>
                    <button
                      onClick={() => setFilter("state", filters.state === s.state ? "" : s.state)}
                      className={`text-xs flex-1 text-left font-medium transition-colors ${
                        filters.state === s.state ? "text-orange-500 font-bold" : "text-gray-700 hover:text-orange-500"
                      }`}
                    >
                      {s.state}
                    </button>
                    <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-blue-400"
                        style={{ width: `${(s.count / (analytics.top_states[0]?.count || 1)) * 100}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 w-8 text-right font-medium">{s.count}</span>
                  </div>
                ))}
              </div>
            </motion.div>

            {/* Reason categories */}
            <motion.div variants={item} className="card-premium p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500">
                  <BarChart2 size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Lead Distribution</h3>
                  <p className="text-[11px] text-gray-400">Click to filter</p>
                </div>
              </div>
              <div className="space-y-3">
                {analytics.reason_categories.map((r: any) => {
                  const total = analytics.reason_categories.reduce((a: number, b: any) => a + b.count, 0);
                  const pct = ((r.count / total) * 100).toFixed(1);
                  const isActive = filters.reason_category === r.category;
                  return (
                    <button key={r.category} onClick={() => setFilter("reason_category", isActive ? "" : r.category)}
                      className={`w-full text-left transition-all rounded-xl p-1.5 -m-1.5 ${isActive ? "bg-orange-50" : "hover:bg-gray-50"}`}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className={`font-medium ${isActive ? "text-orange-500" : "text-gray-700"}`}>{r.category}</span>
                        <span className="text-gray-400">{r.count} · {pct}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: REASON_COLORS[r.category] ?? "#94a3b8" }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>

          {/* Leads table */}
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }} className="card-premium overflow-hidden">
            <div className="flex items-center justify-between p-6 pb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
                  <Users size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">Lead Records</h3>
                  <p className="text-[11px] text-gray-400">
                    Showing 20 of {totalLeads.toLocaleString()} leads
                    {activeCount > 0 && " (filtered)"}
                  </p>
                </div>
              </div>
              {activeCount > 0 && (
                <button onClick={clearAll}
                  className="text-xs text-orange-500 font-semibold hover:underline flex items-center gap-1">
                  <X size={11} /> Clear filters
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y border-gray-50 bg-gray-50/50">
                    {["Date", "Name", "Mobile", "State", "Source", "Product", "ASM", "Review Status", "Review Reason"].map((h) => (
                      <th key={h}
                        className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-3 first:pl-6 last:pr-6">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {leads.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-center py-8 text-sm text-gray-400">
                        No leads match the selected filters.
                      </td>
                    </tr>
                  ) : leads.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-6 py-3 text-xs text-gray-500">{row.lead_date}</td>
                      <td className="px-4 py-3 text-xs font-semibold text-gray-800">
                        {row.customer_name ?? <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-gray-500">{row.mobile_number ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-gray-600">
                        <button onClick={() => setFilter("state", filters.state === row.state ? "" : row.state)}
                          className={`hover:text-orange-500 transition-colors ${filters.state === row.state ? "text-orange-500 font-bold" : ""}`}>
                          {row.state ?? "—"}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
                          style={{
                            background: (SOURCE_COLORS[row.source] ?? "#94a3b8") + "20",
                            color: SOURCE_COLORS[row.source] ?? "#94a3b8",
                          }}>
                          {row.source}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 max-w-[120px] truncate">{row.product_type ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-gray-600 font-medium">
                        <button onClick={() => setFilter("asm", filters.asm === row.assigned_asm ? "" : row.assigned_asm)}
                          className={`hover:text-orange-500 transition-colors ${filters.asm === row.assigned_asm ? "text-orange-500 font-bold" : ""}`}>
                          {row.assigned_asm ?? "—"}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        {row.review_status ? (
                          <button
                            onClick={() => setFilter("review_status", filters.review_status === row.review_status ? "" : row.review_status)}
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full transition-all ${
                              STATUS_BADGE[row.review_status] ?? "bg-gray-100 text-gray-600"
                            } ${filters.review_status === row.review_status ? "ring-2 ring-orange-400" : ""}`}>
                            {row.review_status}
                          </button>
                        ) : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 max-w-[200px] truncate" title={row.review_reason ?? undefined}>
                        {row.review_reason ?? <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        </>
      )}
    </div>
  );
}
