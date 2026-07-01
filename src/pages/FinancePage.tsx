import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  RefreshCw, Plus, ChevronDown, ChevronUp, CheckCircle2, XCircle, Clock, History, Trash2,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import Select from "@/components/ui/Select";
import BalanceSheetView from "@/pages/finance/BalanceSheetView";
import ProfitLossView from "@/pages/finance/ProfitLossView";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface SheetSourceItem {
  id: string; sheet_id: string; label: string;
  created_at: string; last_synced_at: string | null; last_sync_status: string | null;
}
interface SyncResult {
  sync_id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; errors: string[]; status: string;
}
interface SyncHistoryItem {
  id: string; rows_total: number; rows_inserted: number; rows_updated: number;
  rows_failed: number; rows_deleted: number; status: string; synced_at: string;
}
type Statement = "balance_sheet" | "profit_loss";

export default function FinancePage() {
  const { token } = useAuth();
  const headers = { Authorization: `Bearer ${token}` };

  const [sources, setSources] = useState<SheetSourceItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [statement, setStatement] = useState<Statement>("balance_sheet");

  const [showAddForm, setShowAddForm] = useState(false);
  const [newLink, setNewLink] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
      if (data.length && !selectedId) setSelectedId(data[0].id);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => { loadSources(); }, [loadSources]);

  const loadHistory = useCallback(async (sourceId: string) => {
    try {
      const res = await fetch(`${API_URL}/finance/sync-history?sheet_source_id=${sourceId}`, { headers });
      if (res.ok) { setHistory(await res.json()); setHistoryLoaded(true); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (selectedId) { loadHistory(selectedId); setSyncResult(null); }
  }, [selectedId, loadHistory]);

  const handleAddSheet = async () => {
    if (!newLink.trim() || !newLabel.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(`${API_URL}/finance/sheet-sources`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_url_or_id: newLink.trim(), label: newLabel.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not add sheet");
      setNewLink(""); setNewLabel(""); setShowAddForm(false);
      await loadSources();
      setSelectedId(data.id);
      setSyncing(true);
      setSyncResult(null);
      try {
        const syncRes = await fetch(`${API_URL}/finance/sheet-sources/${data.id}/sync`, { method: "POST", headers });
        const syncData = await syncRes.json();
        if (!syncRes.ok) throw new Error(syncData.detail || "Sync failed");
        setSyncResult(syncData);
        loadHistory(data.id);
        loadSources();
      } catch (syncErr: any) {
        setSyncResult({ sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0, errors: [syncErr.message], status: "Error" });
      } finally {
        setSyncing(false);
      }
    } catch (e: any) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  };

  const handleSync = async () => {
    if (!selectedId) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch(`${API_URL}/finance/sheet-sources/${selectedId}/sync`, { method: "POST", headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Sync failed");
      setSyncResult(data);
      loadHistory(selectedId);
      loadSources();
    } catch (err: any) {
      setSyncResult({ sync_id: "", rows_total: 0, rows_inserted: 0, rows_updated: 0, rows_failed: 1, rows_deleted: 0, errors: [err.message], status: "Error" });
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    const source = sources.find((s) => s.id === selectedId);
    if (!source) return;
    const ok = window.confirm(`Delete "${source.label}"?\n\nThis will permanently remove all Balance Sheet and P&L data for this company. This cannot be undone.`);
    if (!ok) return;
    setDeleting(true);
    try {
      await fetch(`${API_URL}/finance/sheet-sources/${selectedId}`, { method: "DELETE", headers });
      setSelectedId("");
      await loadSources();
    } catch { /* ignore */ } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="p-6 flex flex-col gap-6">
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="flex items-center gap-3">
            <span className="page-title-dark">FINANCE</span>
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-8 h-0.5 bg-gray-800 rounded" />
            <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
            <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Balance Sheet & Profit and Loss, per company</p>
          </div>
        </div>
        <div className="flex items-center bg-gray-100 rounded-xl p-1">
          {([["balance_sheet", "Balance Sheet"], ["profit_loss", "P&L"]] as [Statement, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setStatement(key)}
              className={`text-xs font-bold px-4 py-2 rounded-lg transition-all ${statement === key ? "bg-white text-orange-500 shadow-sm" : "text-gray-500"}`}>
              {label}
            </button>
          ))}
        </div>
      </motion.div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <Select
            value={selectedId}
            onChange={setSelectedId}
            placeholder="Select a company…"
            options={sources.map((s) => ({ value: s.id, label: s.label }))}
            className="min-w-[160px]"
          />
          <button onClick={() => setShowAddForm(!showAddForm)}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 hover:text-orange-500 px-3 py-2 rounded-xl border border-gray-200 hover:border-orange-200 transition-all">
            <Plus size={13} /> Add Company
          </button>
          {selectedId && (
            <button onClick={handleDelete} disabled={deleting}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-500 px-2 py-2 rounded-xl border border-gray-200 hover:border-red-200 transition-all disabled:opacity-50">
              <Trash2 size={13} />
            </button>
          )}
        </div>
        <button
          onClick={handleSync}
          disabled={syncing || !selectedId}
          className="flex items-center gap-2 text-xs font-semibold text-white px-4 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 disabled:cursor-not-allowed shadow-lg shadow-orange-200 transition-all">
          {syncing ? (<><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Syncing…</>) : (<><RefreshCw size={13} /> Sync Now</>)}
        </button>
      </div>

      <AnimatePresence>
        {showAddForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="bg-white border border-orange-100 rounded-2xl p-5 shadow-sm flex flex-col gap-3">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Sheet link or ID</label>
                  <input value={newLink} onChange={(e) => setNewLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…"
                    className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                </div>
                <div className="flex flex-col gap-1 min-w-[160px]">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Company Name</label>
                  <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Autoform India"
                    className="h-10 px-3 rounded-xl border border-gray-200 text-sm text-gray-800 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 transition-all" />
                </div>
                <button onClick={handleAddSheet} disabled={adding}
                  className="h-10 flex items-center gap-1.5 text-xs font-semibold text-white px-4 rounded-xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 disabled:opacity-60 transition-all">
                  {adding ? "Adding…" : syncing ? "Syncing…" : "Add & Sync"}
                </button>
                <button onClick={() => setShowAddForm(false)} className="h-10 px-3 text-xs font-medium text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
              {addError && <p className="text-xs text-red-600">{addError}</p>}
              <p className="text-[11px] text-gray-400">
                Make sure this sheet is shared (Viewer is enough) with the service account's email before syncing — Google Sheets access is per-document and isn't granted automatically. Access to this company's data must also be granted per user from the Users page.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {syncResult && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className={`rounded-2xl border p-5 ${syncResult.rows_failed === 0 ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-start gap-4">
              {syncResult.rows_failed === 0 ? <CheckCircle2 className="w-6 h-6 text-green-500 shrink-0 mt-0.5" /> : <XCircle className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />}
              <div className="flex-1">
                <p className="font-semibold text-gray-800">Sync {syncResult.status === "Error" ? "failed" : "complete"}</p>
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
          No company registered yet. Click "Add Company" above to register a company's Finance Google Sheet.
        </div>
      )}

      {selectedId && statement === "balance_sheet" && <BalanceSheetView sheetSourceId={selectedId} />}
      {selectedId && statement === "profit_loss" && <ProfitLossView sheetSourceId={selectedId} />}

      {selectedId && (
        <div>
          <h2 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2"><History size={16} className="text-gray-400" /> Sync History</h2>
          {!historyLoaded ? (
            <div className="text-sm text-gray-400">Loading…</div>
          ) : history.length === 0 ? (
            <div className="text-sm text-gray-400 bg-gray-50 rounded-2xl p-6 text-center">No syncs yet for this company. Click "Sync Now" above.</div>
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
