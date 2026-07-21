import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw, Plus, ChevronDown, ChevronUp, CheckCircle2, XCircle, Clock, History, Trash2, Printer, Database,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import BalanceSheetView from "@/pages/finance/BalanceSheetView";
import ProfitLossView from "@/pages/finance/ProfitLossView";
import PlantOpsView from "@/pages/finance/PlantOpsView";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface SheetSourceItem { id: string; sheet_id: string; label: string; created_at: string; }
interface MasterItem { id: string; sheet_id: string; label: string; last_synced_at: string | null; last_sync_status: string | null; }
interface SyncResult {
  sync_id: string; companies?: number; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; errors: string[]; status: string;
}
interface SyncHistoryItem {
  id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; status: string; synced_at: string;
}
type Statement = "balance_sheet" | "profit_loss" | "plant_ops";

export default function FinancePage() {
  const { token, user } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };
  const isAdmin = user?.role === "superadmin" || user?.role === "management";
  const toast = useToast();

  const [sources, setSources] = useState<SheetSourceItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [statement, setStatement] = useState<Statement>("balance_sheet");
  const [refreshNonce, setRefreshNonce] = useState(0); // bumped after a sync to refetch the active view

  // Master data files (admin only)
  const [masters, setMasters] = useState<MasterItem[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLink, setNewLink] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string>("");

  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [showSyncErrors, setShowSyncErrors] = useState(false);
  const [history, setHistory] = useState<SyncHistoryItem[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/finance/sheet-sources`, { headers });
      if (!res.ok) return;
      const data: SheetSourceItem[] = await res.json();
      setSources(data);
      setSelectedId((cur) => (cur && data.some((s) => s.id === cur) ? cur : (data[0]?.id ?? "")));
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadMasters = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`${API_URL}/finance/masters`, { headers });
      if (res.ok) setMasters(await res.json());
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAdmin]);

  const loadHistory = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch(`${API_URL}/finance/sync-history`, { headers });
      if (res.ok) { setHistory(await res.json()); setHistoryLoaded(true); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isAdmin]);

  useEffect(() => { loadSources(); loadMasters(); loadHistory(); }, [loadSources, loadMasters, loadHistory]);

  const handleAddMaster = async () => {
    if (!newLink.trim() || !newLabel.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`${API_URL}/finance/masters`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: newLink.trim(), label: newLabel.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not add master file");
      setNewLink(""); setNewLabel(""); setShowAddForm(false);
      await loadMasters();
    } catch (e: any) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleSyncMaster = async (id: string) => {
    if (syncingId) return;
    setSyncingId(id);
    setSyncResult(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000); // 3 min safety cap
    try {
      const res = await fetch(`${API_URL}/finance/masters/${id}/sync`, { method: "POST", headers, signal: controller.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      setRefreshNonce((n) => n + 1);
      loadSources(); loadMasters(); loadHistory();
    } catch (err: any) {
      const msg = err?.name === "AbortError" ? "Sync timed out — the backend may still be finishing; refresh in a moment." : err.message;
      setSyncResult({ sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0, errors: [msg], status: "Error" });
    } finally {
      clearTimeout(timer);
      setSyncingId("");
    }
  };

  const handleDeleteMaster = async (id: string, label: string) => {
    if (!window.confirm(`Remove the "${label}" master file registration?\n\nCompany data stays until the next sync; you can re-register it anytime.`)) return;
    try {
      const res = await fetch(`${API_URL}/finance/masters/${id}`, { method: "DELETE", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      await loadMasters();
      toast.success("Master file removed", `"${label}" is no longer registered.`);
    } catch (e) {
      toast.error("Couldn't remove master file", e instanceof Error ? e.message : "Please try again.");
    }
  };

  const handleDeleteCompany = async () => {
    if (!selectedId) return;
    const source = sources.find((s) => s.id === selectedId);
    if (!source) return;
    if (!window.confirm(`Delete company "${source.label}"?\n\nThis removes all its finance data. It will reappear on the next master sync if its tab still exists.`)) return;
    try {
      const res = await fetch(`${API_URL}/finance/sheet-sources/${selectedId}`, { method: "DELETE", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      setSelectedId("");
      await loadSources();
      toast.success("Company deleted", `"${source.label}" and its finance data were removed.`);
    } catch (e) {
      toast.error("Couldn't delete company", e instanceof Error ? e.message : "Please try again.");
    }
  };

  const companyLabel = sources.find((s) => s.id === selectedId)?.label ?? "";
  const statementLabel = statement === "balance_sheet" ? "Balance Sheet" : statement === "profit_loss" ? "Profit & Loss" : "Plant Operations";

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Print-only board-pack header */}
      <div className="print-only mb-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-gray-400">AutoForm · Financial Dashboard</div>
        <div className="text-xl font-bold text-gray-900 mt-0.5">{companyLabel} — {statementLabel}</div>
        <div className="text-[11px] text-gray-400">Generated {new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</div>
      </div>

      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="no-print">
        <h1 className="flex items-center gap-3"><span className="page-title-dark">FINANCE</span></h1>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-8 h-0.5 bg-gray-800 rounded" />
          <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Balance Sheet · Profit & Loss · Plant Operations, per company</p>
        </div>
      </motion.div>

      {/* Statement switcher — sticky so it stays reachable while scrolling a long dashboard.
          Its own scroll-column child (not nested in the header) so it stays pinned for the
          whole page; h-14 + top-2 give it a fixed footprint that DashboardControls tops out below. */}
      <div className="no-print sticky top-2 z-30 h-14 -mx-6 px-6 flex items-center justify-end bg-white/85 backdrop-blur border-b border-[#EAE3D6]">
        <div className="flex items-center bg-gray-100 rounded-xl p-1">
          {([["balance_sheet", "Balance Sheet"], ["profit_loss", "P&L"], ["plant_ops", "Plant Ops"]] as [Statement, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setStatement(key)}
              className={`text-xs font-bold px-4 py-2 rounded-lg transition-all ${statement === key ? "bg-white text-orange-500 shadow-sm" : "text-gray-500"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Company selector (view) */}
      <div className="no-print flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Select
            value={selectedId}
            onChange={setSelectedId}
            placeholder="Select a company…"
            options={sources.map((s) => ({ value: s.id, label: s.label }))}
            className="min-w-[180px]"
          />
          {isAdmin && selectedId && (
            <button onClick={handleDeleteCompany}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-500 px-2 py-2 rounded-xl border border-gray-200 hover:border-red-200 transition-all">
              <Trash2 size={13} />
            </button>
          )}
        </div>
        {selectedId && (
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
            <Printer size={13} /> Print / PDF
          </button>
        )}
      </div>

      {/* Data Sources — admin only */}
      {isAdmin && (
        <div className="no-print bg-white border border-[#EAE3D6] rounded-2xl p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Database size={15} className="text-gray-400" /> Data Sources — master files</h2>
            <button onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-1.5 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
              <Plus size={13} /> Add master file
            </button>
          </div>

          {masters.length === 0 ? (
            <p className="text-[13px] text-gray-400">No master files yet. Register the <b>Monthly</b> and <b>Yearly</b> master spreadsheets — each holds every company as a tab. Syncing ingests all companies.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {masters.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 border border-gray-100 rounded-xl px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-gray-800 truncate">{m.label}</div>
                    <div className="text-[11px] text-gray-400 truncate">
                      {m.last_synced_at ? `Last synced ${formatDate(m.last_synced_at)} · ${m.last_sync_status}` : "Never synced"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => handleSyncMaster(m.id)} disabled={!!syncingId}
                      className="flex items-center gap-1.5 text-xs font-semibold text-white px-3 py-1.5 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 disabled:cursor-not-allowed shadow-md shadow-orange-100 transition-all">
                      {syncingId === m.id ? (<><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>) : (<><RefreshCw size={12} /> Sync</>)}
                    </button>
                    <button onClick={() => handleDeleteMaster(m.id, m.label)} disabled={!!syncingId}
                      className="text-gray-400 hover:text-red-500 px-1.5 py-1.5 rounded-lg border border-gray-200 hover:border-red-200 transition-all disabled:opacity-50">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <AnimatePresence>
            {showAddForm && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="bg-[#FAF7F1] border border-gray-100 rounded-xl p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap gap-3 items-end">
                    <div className="flex flex-col gap-1 flex-1 min-w-[240px]">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Master sheet link or ID</label>
                      <input value={newLink} onChange={(e) => setNewLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…"
                        className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                    </div>
                    <div className="flex flex-col gap-1 min-w-[160px]">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Label</label>
                      <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Monthly master"
                        className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                    </div>
                    <button onClick={handleAddMaster} disabled={adding}
                      className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
                      {adding ? "Adding…" : "Add"}
                    </button>
                    <button onClick={() => setShowAddForm(false)} className="h-10 px-3 text-xs font-medium text-gray-400 hover:text-gray-600">Cancel</button>
                  </div>
                  {addError && <p className="text-xs text-red-600">{addError}</p>}
                  <p className="text-[11px] text-gray-400">
                    Share the sheet (Viewer is enough) with the service account before syncing. One tab per company; the same tab name links a company across the monthly and yearly files. After syncing, grant each user access to their companies from the Users page.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <AnimatePresence>
        {syncResult && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className={`no-print rounded-2xl border p-5 ${syncResult.rows_failed === 0 ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-start gap-4">
              {syncResult.rows_failed === 0 ? <CheckCircle2 className="w-6 h-6 text-green-500 shrink-0 mt-0.5" /> : <XCircle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />}
              <div className="flex-1">
                <p className="font-semibold text-gray-800">Sync {syncResult.status === "Error" ? "failed" : "complete"}{syncResult.companies != null ? ` · ${syncResult.companies} companies` : ""}</p>
                <div className="flex flex-wrap gap-4 mt-2 text-sm">
                  <span className="text-green-700 font-medium">✅ {syncResult.rows_inserted} inserted</span>
                  <span className="text-blue-600 font-medium">🔄 {syncResult.rows_updated} updated</span>
                  {syncResult.rows_deleted > 0 && <span className="text-gray-500 font-medium">🗑 {syncResult.rows_deleted} removed</span>}
                  {syncResult.rows_failed > 0 && <span className="text-red-600 font-medium">❌ {syncResult.rows_failed} failed</span>}
                </div>
                {syncResult.errors.length > 0 && (
                  <div className="mt-3">
                    <button onClick={() => setShowSyncErrors(!showSyncErrors)} className="text-xs text-amber-700 font-medium flex items-center gap-1 hover:underline">
                      {showSyncErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {showSyncErrors ? "Hide" : "Show"} details ({syncResult.errors.length})
                    </button>
                    {showSyncErrors && (
                      <ul className="mt-2 space-y-0.5 text-xs text-amber-800 bg-white/60 rounded-xl p-3">
                        {syncResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!selectedId && (
        <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-8 text-center">
          {isAdmin
            ? "No companies yet — register the master files above and click Sync to ingest every company tab."
            : "No companies available. Ask an admin to grant you access to a company's finance data."}
        </div>
      )}

      {selectedId && statement === "balance_sheet" && <BalanceSheetView sheetSourceId={selectedId} refreshNonce={refreshNonce} />}
      {selectedId && statement === "profit_loss" && <ProfitLossView sheetSourceId={selectedId} refreshNonce={refreshNonce} />}
      {selectedId && statement === "plant_ops" && <PlantOpsView sheetSourceId={selectedId} refreshNonce={refreshNonce} />}

      {isAdmin && (
        <div className="no-print">
          <h2 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2"><History size={16} className="text-gray-400" /> Sync History</h2>
          {!historyLoaded ? (
            <div className="text-sm text-gray-400">Loading…</div>
          ) : history.length === 0 ? (
            <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-6 text-center">No syncs yet. Register a master file above and click Sync.</div>
          ) : (
            <div className="bg-white border border-orange-100 rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-orange-50 bg-orange-50/40">
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Inserted</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Updated</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Removed</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Failed</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, i) => (
                    <tr key={h.id} className={i % 2 === 0 ? "bg-white" : "bg-orange-50/20"}>
                      <td className="px-4 py-3 text-right text-green-700 font-medium">{h.rows_inserted}</td>
                      <td className="px-4 py-3 text-right text-blue-600 font-medium">{h.rows_updated}</td>
                      <td className="px-4 py-3 text-right text-gray-500 font-medium">{h.rows_deleted}</td>
                      <td className="px-4 py-3 text-right text-red-600 font-medium">{h.rows_failed}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${h.status === "Done" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                          {h.status === "Done" ? <CheckCircle2 size={10} /> : <Clock size={10} />} {h.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(h.synced_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
