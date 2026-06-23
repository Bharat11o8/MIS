import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Users, CheckCircle, TrendingUp, Radio, Clock, XCircle,
  ArrowUpRight, BarChart3, PieChart as PieIcon,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";
import { useAuth } from "@/context/AuthContext";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const SOURCE_COLORS: Record<string, string> = {
  IVR: "#3b82f6", WhatsApp: "#22c55e", Instagram: "#f46617", Other: "#94a3b8",
};

interface Analytics {
  kpis: {
    total: number;
    closed_won: number;
    follow_up: number;
    closed_lost: number;
    conversion_rate: number;
    top_source: string | null;
    top_source_count: number;
  };
  trends: { period: string; count: number; closed_won: number; follow_up: number }[];
  sources: { source: string; count: number }[];
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] } },
};

function SkeletonCard() {
  return (
    <div className="kpi-card animate-pulse">
      <div className="w-10 h-10 rounded-xl bg-gray-100 mb-3" />
      <div className="h-7 w-24 bg-gray-100 rounded mb-2" />
      <div className="h-3 w-16 bg-gray-100 rounded" />
    </div>
  );
}

export default function OverviewPage() {
  const { user, token, logout } = useAuth();
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/leads/analytics`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (r.status === 401) { logout(); return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => { if (d) setData(d); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [token]);

  const isManagement = user?.role === "superadmin" || user?.role === "management";

  const trendData = (data?.trends ?? []).map((t) => ({
    month: new Date(t.period).toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
    leads: t.count,
    closedWon: t.closed_won,
    followUp: t.follow_up,
  }));

  const sourceData = (data?.sources ?? []).map((s) => ({
    name: s.source,
    value: s.count,
    color: SOURCE_COLORS[s.source] ?? "#94a3b8",
  }));

  const kpis = [
    {
      id: "total-leads",
      label: "Total Leads",
      value: loading ? "—" : (data?.kpis?.total ?? 0).toLocaleString("en-IN"),
      sub: isManagement ? "All channels combined" : "Your portfolio",
      icon: <Users size={18} />,
      color: "#f46617",
      bg: "#fff4ed",
    },
    {
      id: "closed-won",
      label: "Closed Won",
      value: loading ? "—" : (data?.kpis?.closed_won ?? 0).toLocaleString("en-IN"),
      sub: "Converted leads",
      icon: <CheckCircle size={18} />,
      color: "#22c55e",
      bg: "#f0fdf4",
    },
    {
      id: "conversion-rate",
      label: "Conversion Rate",
      value: loading ? "—" : `${data?.kpis?.conversion_rate ?? 0}%`,
      sub: "Lead to Closed Won",
      icon: <TrendingUp size={18} />,
      color: "#3b82f6",
      bg: "#eff6ff",
    },
    {
      id: "follow-up",
      label: "Follow Ups",
      value: loading ? "—" : (data?.kpis?.follow_up ?? 0).toLocaleString("en-IN"),
      sub: "Pending follow-up",
      icon: <Clock size={18} />,
      color: "#f59e0b",
      bg: "#fffbeb",
    },
    {
      id: "closed-lost",
      label: "Closed Lost",
      value: loading ? "—" : (data?.kpis?.closed_lost ?? 0).toLocaleString("en-IN"),
      sub: "Did not convert",
      icon: <XCircle size={18} />,
      color: "#ef4444",
      bg: "#fef2f2",
    },
        {
      id: "top-source",
      label: "Top Channel",
      value: loading ? "—" : (data?.kpis?.top_source ?? "—"),
      sub: loading ? "" : `${(data?.kpis?.top_source_count ?? 0).toLocaleString("en-IN")} leads`,
      icon: <Radio size={18} />,
      color: "#8b5cf6",
      bg: "#f5f3ff",
    },
  ];

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="flex items-end justify-between">
          <div>
            <h1 className="flex items-center gap-3">
              <span className="page-title-dark">DASHBOARD</span>
              <span className="page-title-orange">OVERVIEW</span>
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-8 h-0.5 bg-gray-800 rounded" />
              <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
                {isManagement ? "All Departments" : "My Portfolio"} · {user?.name}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400">Last updated</p>
            <p className="text-sm font-bold text-gray-700">
              {new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            </p>
          </div>
        </div>
      </motion.div>

      {/* KPI Cards */}
      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : kpis.map((kpi) => (
              <motion.div key={kpi.id} variants={item} className="kpi-card">
                <div className="flex items-start justify-between">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{ background: kpi.bg, color: kpi.color }}
                  >
                    {kpi.icon}
                  </div>
                </div>
                <div className="mt-3">
                  <p className="text-2xl font-black text-gray-900">{kpi.value}</p>
                  <p className="text-xs font-bold text-gray-500 mt-0.5">{kpi.label}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">{kpi.sub}</p>
                </div>
              </motion.div>
            ))}
      </motion.div>

      {/* Charts */}
      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Monthly Trend */}
        <motion.div variants={item} className="card-premium p-6 xl:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500">
                <BarChart3 size={16} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-800">Lead Acquisition Trend</h3>
                <p className="text-[11px] text-gray-400">
                  {isManagement ? "All channels" : "Your uploads"} — monthly
                </p>
              </div>
            </div>
            <button
              className="flex items-center gap-1 text-[11px] font-bold text-orange-500 hover:text-orange-600 transition-colors"
              onClick={() => window.location.href = "/dashboard/leads"}
            >
              View All <ArrowUpRight size={12} />
            </button>
          </div>
          {loading ? (
            <div className="h-[220px] bg-gray-50 rounded-xl animate-pulse" />
          ) : trendData.length === 0 ? (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => (
                    <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{value}</span>
                  )}
                />
                <Line
                  type="monotone"
                  dataKey="leads"
                  stroke="#f46617"
                  strokeWidth={2.5}
                  dot={{ fill: "#f46617", r: 4 }}
                  activeDot={{ r: 6 }}
                  name="Total Leads"
                />
                <Line
                  type="monotone"
                  dataKey="closedWon"
                  stroke="#22c55e"
                  strokeWidth={2.5}
                  dot={{ fill: "#22c55e", r: 4 }}
                  activeDot={{ r: 6 }}
                  name="Closed Won"
                />
                <Line
                  type="monotone"
                  dataKey="followUp"
                  stroke="#f59e0b"
                  strokeWidth={2.5}
                  dot={{ fill: "#f59e0b", r: 4 }}
                  activeDot={{ r: 6 }}
                  name="Follow Up"
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </motion.div>

        {/* Source Pie */}
        <motion.div variants={item} className="card-premium p-6">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500">
              <PieIcon size={16} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-800">Lead Sources</h3>
              <p className="text-[11px] text-gray-400">Channel breakdown</p>
            </div>
          </div>
          {loading ? (
            <div className="h-[200px] bg-gray-50 rounded-xl animate-pulse" />
          ) : sourceData.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">No data yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={sourceData}
                  cx="50%"
                  cy="45%"
                  innerRadius={55}
                  outerRadius={80}
                  paddingAngle={4}
                  dataKey="value"
                >
                  {sourceData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }}
                />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => (
                    <span style={{ fontSize: 11, color: "#64748b", fontWeight: 600 }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </motion.div>
      </motion.div>

      {/* Sales placeholder — shown only for management until Sales module is built */}
      {isManagement && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="card-premium p-6 flex items-center gap-4"
        >
          <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">
            <BarChart3 size={18} />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-700">Sales Module — Coming Soon</p>
            <p className="text-xs text-gray-400 mt-0.5">
              Plant-to-depot dispatch analytics will appear here once the Sales module is enabled.
            </p>
          </div>
        </motion.div>
      )}
    </div>
  );
}
