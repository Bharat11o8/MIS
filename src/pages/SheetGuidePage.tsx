import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Copy, Check, ExternalLink, Eye, BellOff, Link2, ShieldCheck,
  TrendingUp, Wallet, AlertTriangle,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/ui/Toast";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const container = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.06 } } };
const item = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.35 } } };

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="w-7 h-7 rounded-full bg-orange-500 text-white text-xs font-black flex items-center justify-center shrink-0">
        {n}
      </div>
      <div className="flex-1 pb-6 border-b border-gray-50 last:border-0">
        <p className="text-sm font-bold text-gray-800">{title}</p>
        <div className="text-xs text-gray-500 mt-1.5 leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

export default function SheetGuidePage() {
  const { token } = useAuth();
  const toast = useToast();

  const [email, setEmail] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/sheets/service-account`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.detail || `Couldn't load the sharing address (HTTP ${r.status})`);
        return body;
      })
      .then((d) => setEmail(d.client_email))
      .catch((e: Error) => {
        setEmailError(e.message);
        toast.error("Couldn't load the sharing address", e.message);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const copyEmail = async () => {
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      toast.success("Address copied", "Paste it into the Google Sheets Share box.");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy automatically", "Select the address and copy it manually.");
    }
  };

  return (
    <div className="p-6 flex flex-col gap-6 max-w-[980px]">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <h1 className="flex items-center gap-3">
          <span className="page-title-dark">CONNECT A</span>
          <span className="page-title-orange">GOOGLE SHEET</span>
        </h1>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-8 h-0.5 bg-gray-800 rounded" />
          <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
            Share your sheet with the MIS, then paste the link into the module
          </p>
        </div>
      </motion.div>

      <motion.div variants={container} initial="hidden" animate="show" className="flex flex-col gap-5">
        {/* The sharing address */}
        <motion.div variants={item} className="card-premium p-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500">
              <ShieldCheck size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-gray-800">Share your sheet with this address</h2>
              <p className="text-[11px] text-gray-400">
                This is the MIS service account — it reads your sheet, nothing else.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="h-12 bg-gray-50 rounded-2xl animate-pulse" />
          ) : emailError ? (
            <div className="flex items-start gap-2.5 rounded-2xl border border-red-100 bg-red-50/60 p-4">
              <AlertTriangle size={15} className="text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-red-600">Couldn't load the sharing address</p>
                <p className="text-[11px] text-red-500/80 mt-0.5">{emailError}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <code className="flex-1 min-w-[280px] text-[13px] font-mono font-semibold text-gray-800 bg-gray-50 border border-gray-100 rounded-2xl px-4 py-3 break-all select-all">
                {email}
              </code>
              <button
                onClick={copyEmail}
                className={`flex items-center gap-1.5 text-xs font-bold px-4 py-3 rounded-2xl border transition-all ${
                  copied
                    ? "text-green-600 border-green-200 bg-green-50"
                    : "text-white bg-orange-500 border-orange-500 hover:bg-orange-600"
                }`}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          )}
        </motion.div>

        {/* Steps */}
        <motion.div variants={item} className="card-premium p-6">
          <h2 className="text-sm font-bold text-gray-800 mb-5">Step by step</h2>

          <div className="flex flex-col">
            <Step n={1} title="Open your sheet and click Share">
              <p>Open the Google Sheet you want to connect, then click the blue <b>Share</b> button in the top-right corner.</p>
            </Step>

            <Step n={2} title="Paste the address above into the Share box">
              <p>
                Paste <span className="font-mono text-[11px] bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5">{email ?? "the address above"}</span> into
                the “Add people, groups…” field. Google shows it as a normal person — that's expected.
              </p>
            </Step>

            <Step n={3} title="Set the role to Viewer">
              <p className="flex items-start gap-2">
                <Eye size={14} className="text-orange-500 shrink-0 mt-0.5" />
                <span>
                  Change the dropdown on the right from Editor to <b>Viewer</b>. The MIS only ever reads your
                  sheet — Viewer is all it needs, and it means nothing here can change your data.
                </span>
              </p>
            </Step>

            <Step n={4} title="Turn OFF “Notify people”">
              <p className="flex items-start gap-2">
                <BellOff size={14} className="text-orange-500 shrink-0 mt-0.5" />
                <span>
                  Untick the <b>Notify people</b> checkbox before sharing. It's a robot account — the email
                  would just bounce into the void.
                </span>
              </p>
            </Step>

            <Step n={5} title="Click Share">
              <p>Confirm with the blue <b>Share</b> button. That's the Google side done.</p>
            </Step>

            <Step n={6} title="Copy the sheet link">
              <p className="flex items-start gap-2">
                <Link2 size={14} className="text-orange-500 shrink-0 mt-0.5" />
                <span>
                  Open <b>Share</b> again and click <b>Copy link</b> — or just copy the URL from your browser's
                  address bar. Either works.
                </span>
              </p>
            </Step>

            <Step n={7} title="Paste the link into the module">
              <p>Go to the module you're adding the sheet to, paste the link, and hit Sync. See below for where.</p>
            </Step>
          </div>
        </motion.div>

        {/* Screenshot */}
        <motion.div variants={item} className="card-premium p-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-xl bg-orange-50 flex items-center justify-center text-orange-500">
              <Eye size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-gray-800">What it should look like</h2>
              <p className="text-[11px] text-gray-400">Role set to Viewer, “Notify people” unticked.</p>
            </div>
          </div>
          <div className="rounded-2xl border border-gray-100 bg-gray-50/60 p-4 flex justify-center">
            <img
              src="/sheet-share-example.png"
              alt="Google Sheets Share dialog with the MIS service account added, role set to Viewer and Notify people unticked"
              className="rounded-xl border border-gray-200 max-w-full h-auto shadow-sm"
            />
          </div>
        </motion.div>

        {/* Where to paste */}
        <motion.div variants={item} className="card-premium p-6">
          <h2 className="text-sm font-bold text-gray-800 mb-1">Where to paste the link</h2>
          <p className="text-[11px] text-gray-400 mb-4">Modules that read from Google Sheets.</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <a
              href="/dashboard/sales"
              className="group flex items-start gap-3 rounded-2xl border border-gray-100 p-4 hover:border-orange-200 hover:bg-orange-50/40 transition-all"
            >
              <div className="w-9 h-9 rounded-xl bg-orange-50 text-orange-500 flex items-center justify-center shrink-0">
                <TrendingUp size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-gray-800 flex items-center gap-1">
                  Sales <ExternalLink size={11} className="text-gray-300 group-hover:text-orange-400" />
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                  Plant to Depot and Depot to Distributor each take their own sheet, added from the tab's own panel.
                </p>
              </div>
            </a>

            <a
              href="/dashboard/finance"
              className="group flex items-start gap-3 rounded-2xl border border-gray-100 p-4 hover:border-orange-200 hover:bg-orange-50/40 transition-all"
            >
              <div className="w-9 h-9 rounded-xl bg-green-50 text-green-600 flex items-center justify-center shrink-0">
                <Wallet size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-bold text-gray-800 flex items-center gap-1">
                  Finance <ExternalLink size={11} className="text-gray-300 group-hover:text-orange-400" />
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                  Super admin only — register the Monthly and Yearly master files under “Data Sources”. Each holds
                  one tab per company.
                </p>
              </div>
            </a>
          </div>
        </motion.div>

        {/* Troubleshooting */}
        <motion.div variants={item} className="card-premium p-6">
          <h2 className="text-sm font-bold text-gray-800 mb-4">If the sync fails</h2>
          <div className="flex flex-col gap-3">
            {[
              {
                q: "“The caller does not have permission” / 403",
                a: "The sheet isn't shared with the address above, or it was shared with a different account. Re-check step 2.",
              },
              {
                q: "“Requested entity was not found” / 404",
                a: "The link points at a sheet that doesn't exist or was deleted. Copy the link again from the sheet itself.",
              },
              {
                q: "It synced, but no data showed up",
                a: "The tabs are probably named or laid out differently than the module expects. Check the tab names against the template for that module.",
              },
            ].map((f) => (
              <div key={f.q} className="rounded-2xl border border-gray-100 p-4">
                <p className="text-xs font-bold text-gray-700">{f.q}</p>
                <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
