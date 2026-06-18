import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, ArrowLeft, Eye, EyeOff, CheckCircle, AlertCircle } from "lucide-react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

type Step = "email" | "otp" | "success";

const inputStyle = {
  base: {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
  },
  focus: {
    border: "1px solid rgba(244,102,23,0.5)",
    background: "rgba(255,255,255,0.12)",
  },
};

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("email");

  // Step 1 state
  const [email, setEmail] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
  const [sendError, setSendError] = useState("");

  // Step 2 state
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  // ── Step 1: Send OTP ──────────────────────────────────────────────────────
  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendError("");
    setSendingOtp(true);
    try {
      const res = await fetch(`${API_URL}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendError(data.detail || "Something went wrong. Please try again.");
      } else {
        setStep("otp");
        setResendCooldown(60);
        setTimeout(() => otpRefs.current[0]?.focus(), 100);
      }
    } catch {
      setSendError("Cannot connect to server. Please try again.");
    } finally {
      setSendingOtp(false);
    }
  };

  // ── OTP box handlers ──────────────────────────────────────────────────────
  const handleOtpChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;
    const next = [...otp];
    next[index] = value.slice(-1);
    setOtp(next);
    if (value && index < 5) otpRefs.current[index + 1]?.focus();
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    }
  };

  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const next = [...otp];
    digits.split("").forEach((d, i) => { next[i] = d; });
    setOtp(next);
    const lastFilled = Math.min(digits.length, 5);
    otpRefs.current[lastFilled]?.focus();
  };

  const otpValue = otp.join("");

  // ── Step 2: Reset Password ────────────────────────────────────────────────
  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError("");

    if (otpValue.length < 6) {
      setResetError("Please enter the full 6-digit OTP.");
      return;
    }
    if (newPassword.length < 8) {
      setResetError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setResetError("Passwords do not match.");
      return;
    }

    setResetting(true);
    try {
      const res = await fetch(`${API_URL}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, otp: otpValue, new_password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResetError(data.detail || "Something went wrong. Please try again.");
      } else {
        setStep("success");
      }
    } catch {
      setResetError("Cannot connect to server. Please try again.");
    } finally {
      setResetting(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setSendingOtp(true);
    await fetch(`${API_URL}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setSendingOtp(false);
    setResendCooldown(60);
    setOtp(["", "", "", "", "", ""]);
    setResetError("");
    setTimeout(() => otpRefs.current[0]?.focus(), 100);
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden flex items-center justify-center">
      <div
        className="absolute inset-0 z-0"
        style={{
          backgroundImage: "url('../Assets/seat-cover-hero-4.webp')",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <div className="absolute inset-0 z-0" style={{ background: "rgba(8,15,30,0.2)" }} />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        className="relative z-10 w-full max-w-[400px] mx-4"
      >
        <div className="glass-card rounded-3xl p-8 flex flex-col gap-6">

          {/* ── Success ── */}
          <AnimatePresence mode="wait">
            {step === "success" && (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center gap-4 py-4 text-center"
              >
                <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
                  <CheckCircle size={32} className="text-green-400" />
                </div>
                <div>
                  <p className="text-white font-bold text-lg">Password Reset!</p>
                  <p className="text-white/60 text-sm mt-1">You can now log in with your new password.</p>
                </div>
                <button
                  onClick={() => navigate("/login")}
                  className="w-full h-11 rounded-xl text-sm font-bold uppercase tracking-wider text-white mt-2"
                  style={{ background: "linear-gradient(135deg,#9B2020,#6B1010)", boxShadow: "0 4px 24px rgba(139,20,20,0.5)" }}
                >
                  Back to Login
                </button>
              </motion.div>
            )}

            {/* ── Step 1: Email ── */}
            {step === "email" && (
              <motion.div key="email" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {/* Header */}
                <div className="flex flex-col items-center gap-1 mb-6">
                  <p className="text-white font-bold text-lg">Forgot Password?</p>
                  <p className="text-white/50 text-xs text-center">
                    Enter your work email and we'll send you a one-time password.
                  </p>
                </div>

                <form onSubmit={handleSendOtp} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">
                      Work Email
                    </label>
                    <div className="relative">
                      <Mail size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/70" />
                      <input
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@autoformindia.com"
                        className="w-full h-11 pl-9 pr-4 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                        style={inputStyle.base}
                        onFocus={(e) => Object.assign(e.target.style, inputStyle.focus)}
                        onBlur={(e) => Object.assign(e.target.style, inputStyle.base)}
                      />
                    </div>
                  </div>

                  {sendError && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-red-300"
                      style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                      <AlertCircle size={13} className="shrink-0" />{sendError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={sendingOtp}
                    className="w-full h-11 rounded-xl text-sm font-bold uppercase tracking-wider text-white disabled:opacity-60"
                    style={{ background: "linear-gradient(135deg,#9B2020,#6B1010)", boxShadow: "0 4px 24px rgba(139,20,20,0.5)" }}
                  >
                    {sendingOtp ? "Sending…" : "Send OTP"}
                  </button>
                </form>

                <button
                  onClick={() => navigate("/login")}
                  className="flex items-center justify-center gap-1.5 w-full mt-4 text-[11px] text-white/50 hover:text-white/80 transition-colors"
                >
                  <ArrowLeft size={12} /> Back to Login
                </button>
              </motion.div>
            )}

            {/* ── Step 2: OTP + New Password ── */}
            {step === "otp" && (
              <motion.div key="otp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="flex flex-col items-center gap-1 mb-6">
                  <p className="text-white font-bold text-lg">Enter OTP</p>
                  <p className="text-white/50 text-xs text-center">
                    Sent to <span className="text-white/80">{email}</span>. Valid for 10 minutes.
                  </p>
                </div>

                <form onSubmit={handleReset} className="flex flex-col gap-5">
                  {/* 6-digit OTP boxes */}
                  <div className="flex gap-2 justify-center" onPaste={handleOtpPaste}>
                    {otp.map((digit, i) => (
                      <input
                        key={i}
                        ref={(el) => { otpRefs.current[i] = el; }}
                        type="text"
                        inputMode="numeric"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleOtpChange(i, e.target.value)}
                        onKeyDown={(e) => handleOtpKeyDown(i, e)}
                        className="w-11 h-13 text-center text-xl font-black text-white rounded-xl outline-none transition-all duration-200"
                        style={{
                          height: "52px",
                          background: digit ? "rgba(244,102,23,0.15)" : "rgba(255,255,255,0.08)",
                          border: digit ? "1px solid rgba(244,102,23,0.5)" : "1px solid rgba(255,255,255,0.12)",
                        }}
                      />
                    ))}
                  </div>

                  {/* New password */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">New Password</label>
                    <div className="relative">
                      <input
                        type={showPw ? "text" : "password"}
                        required
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Min. 8 characters"
                        className="w-full h-11 px-4 pr-10 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                        style={inputStyle.base}
                        onFocus={(e) => Object.assign(e.target.style, inputStyle.focus)}
                        onBlur={(e) => Object.assign(e.target.style, inputStyle.base)}
                      />
                      <button type="button" onClick={() => setShowPw(!showPw)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-white/70 hover:text-white/60">
                        {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  {/* Confirm password */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">Confirm Password</label>
                    <input
                      type={showPw ? "text" : "password"}
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      className="w-full h-11 px-4 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                      style={inputStyle.base}
                      onFocus={(e) => Object.assign(e.target.style, inputStyle.focus)}
                      onBlur={(e) => Object.assign(e.target.style, inputStyle.base)}
                    />
                  </div>

                  {resetError && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-red-300"
                      style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                      <AlertCircle size={13} className="shrink-0" />{resetError}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={resetting || otpValue.length < 6}
                    className="w-full h-11 rounded-xl text-sm font-bold uppercase tracking-wider text-white disabled:opacity-60"
                    style={{ background: "linear-gradient(135deg,#9B2020,#6B1010)", boxShadow: "0 4px 24px rgba(139,20,20,0.5)" }}
                  >
                    {resetting ? "Resetting…" : "Reset Password"}
                  </button>
                </form>

                {/* Resend + back */}
                <div className="flex items-center justify-between mt-4">
                  <button
                    onClick={() => { setStep("email"); setOtp(["","","","","",""]); setResetError(""); }}
                    className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white/80 transition-colors"
                  >
                    <ArrowLeft size={12} /> Change email
                  </button>
                  <button
                    onClick={handleResend}
                    disabled={resendCooldown > 0 || sendingOtp}
                    className="text-[11px] font-bold text-white/50 hover:text-orange-400 disabled:opacity-40 transition-colors"
                  >
                    {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend OTP"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <p className="text-center text-[10px] text-white/60 mt-4 uppercase tracking-wider">
          © 2025 AutoForm India
        </p>
      </motion.div>
    </div>
  );
}
