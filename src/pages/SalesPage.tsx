import { motion } from "framer-motion";
import { Truck, CheckCircle, Clock, Package, ArrowUpRight, BarChart3, MapPin } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line,
} from "recharts";

const depotData = [
  { depot: "Delhi", dispatched: 520, delivered: 498, pending: 22 },
  { depot: "Mumbai", dispatched: 380, delivered: 365, pending: 15 },
  { depot: "Chennai", dispatched: 290, delivered: 280, pending: 10 },
  { depot: "Kolkata", dispatched: 210, delivered: 200, pending: 10 },
  { depot: "Pune", dispatched: 175, delivered: 170, pending: 5 },
  { depot: "Hyderabad", dispatched: 155, delivered: 150, pending: 5 },
];

const monthlyTrend = [
  { month: "Jan", units: 1200 }, { month: "Feb", units: 1450 },
  { month: "Mar", units: 1800 }, { month: "Apr", units: 1600 },
  { month: "May", units: 2100 }, { month: "Jun", units: 1900 },
];

const recentDispatches = [
  { id: "INV-2025-001", plant: "Noida Plant", depot: "Delhi Depot", sku: "SC-4W-LUXURY-BLK", qty: 50, status: "Delivered", date: "15 Jun" },
  { id: "INV-2025-002", plant: "Noida Plant", depot: "Mumbai Depot", sku: "SC-2W-SPORT-RED", qty: 120, status: "In Transit", date: "14 Jun" },
  { id: "INV-2025-003", plant: "Pune Plant", depot: "Chennai Depot", sku: "SC-4W-ECO-GRY", qty: 80, status: "Delivered", date: "13 Jun" },
  { id: "INV-2025-004", plant: "Pune Plant", depot: "Kolkata Depot", sku: "SC-4W-PREMIUM-BEI", qty: 35, status: "Pending", date: "13 Jun" },
  { id: "INV-2025-005", plant: "Noida Plant", depot: "Hyderabad Depot", sku: "SC-2W-CLASSIC-BLK", qty: 200, status: "In Transit", date: "12 Jun" },
];

const statusColors: Record<string, string> = {
  Delivered: "badge-green",
  "In Transit": "badge-blue",
  Pending: "badge-yellow",
};

const kpis = [
  { id: "sales-total-dispatched", label: "Total Dispatched", value: "10,050", icon: <Truck size={18} />, color: "#3b82f6", bg: "#eff6ff", sub: "Units YTD" },
  { id: "sales-delivered", label: "Delivered", value: "9,563", icon: <CheckCircle size={18} />, color: "#22c55e", bg: "#f0fdf4", sub: "95.3% rate" },
  { id: "sales-in-transit", label: "In Transit", value: "340", icon: <Package size={18} />, color: "#f59e0b", bg: "#fffbeb", sub: "Across routes" },
  { id: "sales-pending", label: "Pending", value: "147", icon: <Clock size={18} />, color: "#ef4444", bg: "#fef2f2", sub: "Needs dispatch" },
];

const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.08 } } };
const item = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4 } } };

export default function SalesPage() {
  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="flex items-center gap-3">
          <span className="page-title-dark">SALES</span>
          <span className="page-title-orange">PLANT TO DEPOT</span>
        </h1>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-8 h-0.5 bg-gray-800 rounded" />
          <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
            Dispatch & Delivery Tracking
          </p>
        </div>
      </motion.div>

      {/* KPIs */}
      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <motion.div key={kpi.id} variants={item} id={kpi.id} className="kpi-card">
            <div className="flex items-start justify-between">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: kpi.bg, color: kpi.color }}>
                {kpi.icon}
              </div>
            </div>
            <div className="mt-3">
              <p className="text-2xl font-black text-gray-900">{kpi.value}</p>
              <p className="text-xs font-bold text-gray-500 mt-0.5">{kpi.label}</p>
              <p className="text-[11px] text-gray-400">{kpi.sub}</p>
            </div>
          </motion.div>
        ))}
      </motion.div>

      {/* Charts */}
      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Depot wise bar */}
        <motion.div variants={item} className="card-premium p-6 xl:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
                <MapPin size={16} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-800">Depot-wise Dispatch</h3>
                <p className="text-[11px] text-gray-400">Dispatched vs Delivered per depot</p>
              </div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={depotData} barGap={4}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="depot" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} cursor={{ fill: "rgba(241,245,249,0.5)" }} />
              <Bar dataKey="dispatched" fill="#3b82f6" radius={[6, 6, 0, 0]} name="Dispatched" />
              <Bar dataKey="delivered" fill="#22c55e" radius={[6, 6, 0, 0]} name="Delivered" />
            </BarChart>
          </ResponsiveContainer>
        </motion.div>

        {/* Monthly trend line */}
        <motion.div variants={item} className="card-premium p-6">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500">
              <BarChart3 size={16} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-800">Monthly Volume</h3>
              <p className="text-[11px] text-gray-400">Units dispatched trend</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={monthlyTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#fff", border: "1px solid #f1f5f9", borderRadius: 12, fontSize: 12 }} />
              <Line type="monotone" dataKey="units" stroke="#f46617" strokeWidth={2.5} dot={{ fill: "#f46617", r: 4 }} activeDot={{ r: 6 }} name="Units" />
            </LineChart>
          </ResponsiveContainer>
        </motion.div>
      </motion.div>

      {/* Recent Dispatches Table */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="card-premium overflow-hidden">
        <div className="flex items-center justify-between p-6 pb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
              <Truck size={16} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-800">Recent Dispatches</h3>
              <p className="text-[11px] text-gray-400">Latest dispatch records</p>
            </div>
          </div>
          <button className="flex items-center gap-1 text-[11px] font-bold text-orange-500 hover:text-orange-600 transition-colors">
            View All <ArrowUpRight size={12} />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-gray-50 bg-gray-50/50">
                <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-6 py-3">Invoice</th>
                <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-3">Plant</th>
                <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-3">Depot</th>
                <th className="text-left text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-3">SKU</th>
                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-3">Qty</th>
                <th className="text-center text-[10px] font-bold uppercase tracking-wider text-gray-400 px-4 py-3">Status</th>
                <th className="text-right text-[10px] font-bold uppercase tracking-wider text-gray-400 px-6 py-3">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {recentDispatches.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-3.5 font-mono text-xs text-gray-600 font-bold">{row.id}</td>
                  <td className="px-4 py-3.5 text-xs text-gray-700">{row.plant}</td>
                  <td className="px-4 py-3.5 text-xs text-gray-700">{row.depot}</td>
                  <td className="px-4 py-3.5 font-mono text-[11px] text-gray-500">{row.sku}</td>
                  <td className="px-4 py-3.5 text-xs text-gray-700 text-right font-bold">{row.qty}</td>
                  <td className="px-4 py-3.5 text-center">
                    <span className={`badge ${statusColors[row.status]}`}>{row.status}</span>
                  </td>
                  <td className="px-6 py-3.5 text-xs text-gray-400 text-right">{row.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.div>
    </div>
  );
}
