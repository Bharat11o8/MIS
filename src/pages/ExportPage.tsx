import { useState } from "react";
import { motion } from "framer-motion";
import { Download, FileSpreadsheet, Filter, Calendar, CheckSquare } from "lucide-react";

type Module = "sales" | "leads" | "all";
type DateRange = "today" | "week" | "month" | "quarter" | "custom";
type FileFormat = "xlsx" | "csv";

export default function ExportPage() {
  const [module, setModule] = useState<Module>("all");
  const [dateRange, setDateRange] = useState<DateRange>("month");
  const [format, setFormat] = useState<FileFormat>("xlsx");
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    setExported(false);
    await new Promise((r) => setTimeout(r, 1500));
    setExporting(false);
    setExported(true);
    setTimeout(() => setExported(false), 3000);
  };

  const dateLabels: Record<DateRange, string> = {
    today: "Today",
    week: "This Week",
    month: "This Month",
    quarter: "This Quarter",
    custom: "Custom Range",
  };

  const moduleLabels: Record<Module, string> = {
    sales: "Sales (Plant to Depot)",
    leads: "Leads (All Channels)",
    all: "All Modules",
  };

  return (
    <div className="p-6 flex flex-col gap-6 max-w-2xl">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="flex items-center gap-3">
          <span className="page-title-dark">EXPORT</span>
          <span className="page-title-orange">DATA</span>
        </h1>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-8 h-0.5 bg-gray-800 rounded" />
          <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
            Download Filtered Reports
          </p>
        </div>
      </motion.div>

      {/* Export form card */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="card-premium p-6 flex flex-col gap-6"
      >
        {/* Module selector */}
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400 flex items-center gap-1.5 mb-3">
            <Filter size={12} /> Select Module
          </label>
          <div className="flex flex-wrap gap-2">
            {(["all", "sales", "leads"] as Module[]).map((m) => (
              <button
                key={m}
                id={`export-module-${m}`}
                onClick={() => setModule(m)}
                className="px-4 py-2 rounded-xl text-xs font-bold border transition-all duration-200"
                style={
                  module === m
                    ? { background: "#fff4ed", color: "#f46617", borderColor: "#fed7aa" }
                    : { background: "#f9fafb", color: "#6b7280", borderColor: "#f3f4f6" }
                }
              >
                {moduleLabels[m]}
              </button>
            ))}
          </div>
        </div>

        {/* Date range */}
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400 flex items-center gap-1.5 mb-3">
            <Calendar size={12} /> Date Range
          </label>
          <div className="flex flex-wrap gap-2">
            {(["today", "week", "month", "quarter"] as DateRange[]).map((d) => (
              <button
                key={d}
                id={`export-date-${d}`}
                onClick={() => setDateRange(d)}
                className="px-4 py-2 rounded-xl text-xs font-bold border transition-all duration-200"
                style={
                  dateRange === d
                    ? { background: "#eff6ff", color: "#3b82f6", borderColor: "#bfdbfe" }
                    : { background: "#f9fafb", color: "#6b7280", borderColor: "#f3f4f6" }
                }
              >
                {dateLabels[d]}
              </button>
            ))}
          </div>
        </div>

        {/* File format */}
        <div>
          <label className="text-[11px] font-bold uppercase tracking-wider text-gray-400 flex items-center gap-1.5 mb-3">
            <FileSpreadsheet size={12} /> File Format
          </label>
          <div className="flex gap-3">
            {(["xlsx", "csv"] as FileFormat[]).map((f) => (
              <button
                key={f}
                id={`export-format-${f}`}
                onClick={() => setFormat(f)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold border transition-all duration-200"
                style={
                  format === f
                    ? { background: "#f0fdf4", color: "#16a34a", borderColor: "#bbf7d0" }
                    : { background: "#f9fafb", color: "#6b7280", borderColor: "#f3f4f6" }
                }
              >
                <FileSpreadsheet size={13} />
                .{f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Summary */}
        <div
          className="rounded-2xl p-4 flex flex-col gap-1"
          style={{ background: "#fafafa", border: "1px solid #f3f4f6" }}
        >
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Export Summary</p>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Module</span>
            <span className="font-bold text-gray-800">{moduleLabels[module]}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Period</span>
            <span className="font-bold text-gray-800">{dateLabels[dateRange]}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Format</span>
            <span className="font-bold text-gray-800">.{format.toUpperCase()}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Est. rows</span>
            <span className="font-bold text-gray-800">~{module === "all" ? "2,400" : module === "sales" ? "1,800" : "620"} records</span>
          </div>
        </div>

        {/* Export button */}
        <motion.button
          id="export-download-btn"
          onClick={handleExport}
          disabled={exporting}
          whileTap={{ scale: 0.97 }}
          className="w-full h-12 rounded-xl flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-wider text-white transition-all duration-200 disabled:opacity-60"
          style={{
            background: exported
              ? "linear-gradient(135deg, #16a34a, #15803d)"
              : "linear-gradient(135deg, #f46617, #d85512)",
            boxShadow: exported
              ? "0 4px 20px rgba(22,163,74,0.3)"
              : "0 4px 20px rgba(244,102,23,0.3)",
          }}
        >
          {exporting ? (
            <>
              <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Preparing Export...
            </>
          ) : exported ? (
            <>
              <CheckSquare size={16} />
              Downloaded!
            </>
          ) : (
            <>
              <Download size={16} />
              Download {format.toUpperCase()}
            </>
          )}
        </motion.button>
      </motion.div>
    </div>
  );
}
