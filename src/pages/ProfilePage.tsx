import { useState } from "react";
import { motion } from "framer-motion";
import { User, Mail, Shield, CheckCircle, AlertCircle } from "lucide-react";
import { useAuth, UserRole } from "@/context/AuthContext";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

const ROLE_LABELS: Record<UserRole, string> = {
  superadmin: "Super Admin",
  management: "Management",
  sales_head: "Sales Head",
  leads_head: "Leads Head",
  sales_rep: "Sales Rep",
  staff: "Staff",
};

const ROLE_COLORS: Record<UserRole, string> = {
  superadmin: "bg-purple-100 text-purple-700",
  management: "bg-blue-100 text-blue-700",
  sales_head: "bg-green-100 text-green-700",
  leads_head: "bg-orange-100 text-orange-700",
  sales_rep: "bg-yellow-100 text-yellow-700",
  staff: "bg-gray-100 text-gray-600",
};

export default function ProfilePage() {
  const { user, token, updateUser } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  const isDirty = name !== user?.name || email !== user?.email;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDirty) return;
    setError("");
    setSuccess(false);
    setSaving(true);

    try {
      const res = await fetch(`${API_URL}/users/me`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Failed to save changes.");
      } else {
        updateUser({ name: data.name, email: data.email });
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch {
      setError("Cannot connect to server.");
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <div className="p-6 max-w-2xl">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <h1 className="flex items-center gap-3">
          <span className="page-title-dark">MY</span>
          <span className="page-title-orange">PROFILE</span>
        </h1>
        <div className="flex items-center gap-2 mt-1 mb-8">
          <div className="w-8 h-0.5 bg-gray-800 rounded" />
          <div className="w-4 h-0.5 rounded" style={{ background: "#f46617" }} />
          <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">
            Account Settings
          </p>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
        className="card-premium p-8 flex flex-col gap-6"
      >
        {/* Avatar */}
        <div className="flex items-center gap-5">
          <div className="w-16 h-16 rounded-2xl bg-orange-500 flex items-center justify-center text-white text-2xl font-black shrink-0">
            {user.name.charAt(0)}
          </div>
          <div>
            <p className="text-lg font-black text-gray-900">{user.name}</p>
            <span className={`inline-block text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full mt-1 ${ROLE_COLORS[user.role]}`}>
              {ROLE_LABELS[user.role]}
            </span>
          </div>
        </div>

        <div className="h-px bg-gray-100" />

        {/* Edit form */}
        <form onSubmit={handleSave} className="flex flex-col gap-5">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-500">
              <User size={12} /> Full Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => { setName(e.target.value); setSuccess(false); }}
              className="h-11 px-4 rounded-xl border border-gray-200 text-sm text-gray-800 font-medium outline-none transition-all duration-200 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 bg-white"
              placeholder="Your full name"
            />
          </div>

          {/* Email */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-500">
              <Mail size={12} /> Email Address <span className="text-gray-300 normal-case font-normal">(also your login username)</span>
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => { setEmail(e.target.value); setSuccess(false); }}
              className="h-11 px-4 rounded-xl border border-gray-200 text-sm text-gray-800 font-medium outline-none transition-all duration-200 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 bg-white"
              placeholder="you@autoformindia.com"
            />
          </div>

          {/* Role (read-only) */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-500">
              <Shield size={12} /> Role
            </label>
            <div className="h-11 px-4 rounded-xl border border-gray-100 bg-gray-50 flex items-center text-sm text-gray-500 font-medium">
              {ROLE_LABELS[user.role]}
              <span className="ml-2 text-[10px] text-gray-400">(managed by admin)</span>
            </div>
          </div>

          {/* Feedback */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs text-red-600 bg-red-50 border border-red-100">
              <AlertCircle size={13} className="shrink-0" /> {error}
            </div>
          )}
          {success && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs text-green-700 bg-green-50 border border-green-100"
            >
              <CheckCircle size={13} className="shrink-0" /> Profile updated successfully.
            </motion.div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving || !isDirty}
              className="h-10 px-6 rounded-xl text-sm font-bold text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: "linear-gradient(135deg,#f46617,#d85512)", boxShadow: "0 4px 16px rgba(244,102,23,0.3)" }}
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>

            <button
              type="button"
              onClick={() => { setName(user.name); setEmail(user.email); setError(""); setSuccess(false); }}
              disabled={!isDirty}
              className="h-10 px-5 rounded-xl text-sm font-medium text-gray-500 border border-gray-200 hover:border-gray-300 hover:text-gray-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
          </div>
        </form>

      </motion.div>
    </div>
  );
}
