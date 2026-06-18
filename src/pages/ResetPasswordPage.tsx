import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Eye, EyeOff, Lock, AlertCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";
const logoSrc = "/autoform-logo.png";

function getStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const map = [
    { label: "Too short", color: "#ef4444" },
    { label: "Weak", color: "#f97316" },
    { label: "Fair", color: "#eab308" },
    { label: "Good", color: "#22c55e" },
    { label: "Strong", color: "#10b981" },
  ];
  return { score, ...map[score] };
}

export default function ResetPasswordPage() {
  const { token, clearPasswordFlag } = useAuth();
  const navigate = useNavigate();

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const strength = getStrength(newPw);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPw !== confirmPw) {
      setError("New passwords do not match");
      return;
    }
    if (newPw.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/change-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          current_password: currentPw,
          new_password: newPw,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Failed to change password");
        return;
      }

      setSuccess(true);
      clearPasswordFlag();
      setTimeout(() => navigate("/dashboard"), 1500);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden flex items-center justify-center">
      {/* Background */}
      <div
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: "url('../Assets/seat-cover-hero-4.webp')",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        }}
      />
      <div className="absolute inset-0 z-0" style={{ background: "rgba(8, 15, 30, 0.2)" }} />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        className="relative z-10 w-full max-w-[400px] mx-4"
      >
        <div className="glass-card rounded-3xl p-8 flex flex-col gap-6">
          {/* Logo + heading */}
          <div className="flex flex-col items-center gap-3">
            <img
              src={logoSrc}
              alt="AutoForm India"
              className="h-12 w-auto"
              style={{ filter: "brightness(0) invert(1)" }}
            />
            <div className="text-center">
              <p className="text-sm font-bold text-white">Set Your Password</p>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/60 mt-1">
                First-time login — please update your credentials
              </p>
            </div>
            <div className="flex items-center gap-3 w-full">
              <div className="flex-1 h-px bg-white/10" />
              <div
                className="text-[9px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border"
                style={{
                  color: "#ffffff",
                  borderColor: "rgba(255,255,255,0.1)",
                  backgroundColor: "rgba(255,255,255,0.1)",
                }}
              >
                Account Setup
              </div>
              <div className="flex-1 h-px bg-white/10" />
            </div>
          </div>

          {success ? (
            <div
              className="rounded-xl p-4 text-center"
              style={{ background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.25)" }}
            >
              <p className="text-green-400 font-bold text-sm">Password updated! Redirecting…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {/* Current password */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">
                  Current Password
                </label>
                <div className="relative">
                  <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/70" />
                  <input
                    type={showCurrent ? "text" : "password"}
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    required
                    placeholder="Enter your current password"
                    className="w-full h-11 pl-9 pr-10 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}
                    onFocus={(e) => {
                      e.target.style.border = "1px solid rgba(244,102,23,0.5)";
                      e.target.style.background = "rgba(255,255,255,0.12)";
                    }}
                    onBlur={(e) => {
                      e.target.style.border = "1px solid rgba(255,255,255,0.12)";
                      e.target.style.background = "rgba(255,255,255,0.08)";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrent(!showCurrent)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/70 hover:text-white/60 transition-colors"
                  >
                    {showCurrent ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              {/* New password */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">
                  New Password
                </label>
                <div className="relative">
                  <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/70" />
                  <input
                    type={showNew ? "text" : "password"}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    required
                    placeholder="Create a strong password"
                    className="w-full h-11 pl-9 pr-10 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}
                    onFocus={(e) => {
                      e.target.style.border = "1px solid rgba(244,102,23,0.5)";
                      e.target.style.background = "rgba(255,255,255,0.12)";
                    }}
                    onBlur={(e) => {
                      e.target.style.border = "1px solid rgba(255,255,255,0.12)";
                      e.target.style.background = "rgba(255,255,255,0.08)";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew(!showNew)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/70 hover:text-white/60 transition-colors"
                  >
                    {showNew ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {/* Strength bar */}
                {newPw && (
                  <div className="mt-1 space-y-1">
                    <div className="flex gap-1">
                      {[0, 1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className="h-1 flex-1 rounded-full transition-all duration-300"
                          style={{
                            backgroundColor: i < strength.score ? strength.color : "rgba(255,255,255,0.12)",
                          }}
                        />
                      ))}
                    </div>
                    <p className="text-[10px] font-bold" style={{ color: strength.color }}>
                      {strength.label}
                    </p>
                  </div>
                )}
              </div>

              {/* Confirm */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/70" />
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={(e) => setConfirmPw(e.target.value)}
                    required
                    placeholder="Repeat new password"
                    className="w-full h-11 pl-9 pr-4 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                    style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)" }}
                    onFocus={(e) => {
                      e.target.style.border = "1px solid rgba(244,102,23,0.5)";
                      e.target.style.background = "rgba(255,255,255,0.12)";
                    }}
                    onBlur={(e) => {
                      e.target.style.border = "1px solid rgba(255,255,255,0.12)";
                      e.target.style.background = "rgba(255,255,255,0.08)";
                    }}
                  />
                </div>
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-red-300"
                  style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
                >
                  <AlertCircle size={13} className="shrink-0" />
                  {error}
                </motion.div>
              )}

              <motion.button
                type="submit"
                disabled={loading}
                whileTap={{ scale: 0.97 }}
                className="w-full h-11 rounded-xl text-sm font-bold uppercase tracking-wider text-white transition-all duration-200 disabled:opacity-60 mt-1"
                style={{
                  background: loading
                    ? "rgba(139, 28, 28, 0.5)"
                    : "linear-gradient(135deg, #9B2020, #6B1010)",
                  boxShadow: loading ? "none" : "0 4px 24px rgba(139, 20, 20, 0.5)",
                }}
              >
                {loading ? "Updating…" : "Set New Password"}
              </motion.button>
            </form>
          )}
        </div>

        <p className="text-center text-[10px] text-white/100 mt-4 uppercase tracking-wider">
          © 2025 AutoForm India
        </p>
      </motion.div>
    </div>
  );
}
