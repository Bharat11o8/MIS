import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Eye, EyeOff, Lock, Mail, AlertCircle } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

const logoSrc = "/autoform-logo.png";


export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (result.success) {
      navigate("/dashboard");
    } else {
      setError(result.error || "Invalid credentials. Please check your email and password.");
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden flex items-center justify-center">
      {/* Background — automotive product image via gradient fallback */}
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

      {/* Login Card */}
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        className="relative z-10 w-full max-w-[400px] mx-4"
      >
        <div className="glass-card rounded-3xl p-8 flex flex-col gap-6">
          {/* Logo */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center justify-center">
              <img
                src={logoSrc}
                alt="AutoForm India"
                className="h-14 w-auto"
                style={{ filter: "brightness(0) invert(1)" }}
              />
            </div>
            <div className="text-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-white/85 mt-1">
                Management Information System
              </p>
            </div>
            {/* Divider */}
            <div className="flex items-center gap-3 w-full mt-1">
              <div className="flex-1 h-px bg-white/10" />
              <div
                className="text-[9px] font-bold uppercase tracking-widest px-3 py-1 rounded-full border"
                style={{
                  color: "#ffffff",
                  borderColor: "rgba(255,255,255,0.1)",
                  backgroundColor: "rgba(255,255,255,0.1)",
                }}
              >
                Internal Portal
              </div>
              <div className="flex-1 h-px bg-white/10" />
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Email */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">
                Email Address
              </label>
              <div className="relative">
                <Mail
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-white/70"
                />
                <input
                  id="login-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@autoformindia.com"
                  className="w-full h-11 pl-9 pr-4 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.12)",
                  }}
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

            {/* Password */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wider text-white/80">
                Password
              </label>
              <div className="relative">
                <Lock
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-white/70"
                />
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-11 pl-9 pr-10 rounded-xl text-sm text-white placeholder-white/35 outline-none transition-all duration-200"
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.12)",
                  }}
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
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/70 hover:text-white/60 transition-colors"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Error message */}
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

            {/* Submit Button */}
            <motion.button
              id="login-submit"
              type="submit"
              disabled={loading}
              whileTap={{ scale: 0.97 }}
              className="w-full h-11 rounded-xl text-sm font-bold uppercase tracking-wider text-white transition-all duration-200 disabled:opacity-60 mt-1"
              style={{
                background: loading
                  ? "rgba(139, 28, 28, 0.5)"
                  : "linear-gradient(135deg, #9B2020, #6B1010)",
                boxShadow: loading
                  ? "none"
                  : "0 4px 24px rgba(139, 20, 20, 0.5)",
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg
                    className="animate-spin h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8z"
                    />
                  </svg>
                  Signing In...
                </span>
              ) : (
                "Sign In"
              )}
            </motion.button>
          </form>

          {/* Demo credentials hint */}
          <div
            className="rounded-xl p-3 text-center"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
          >
            <p className="text-[10px] text-white/35 uppercase tracking-wider font-medium">
              Demo: admin@autoformindia.com / admin123
            </p>
          </div>
        </div>
        {/* Footer */}
        <p className="text-center text-[10px] text-white/100 mt-4 uppercase tracking-wider">
          © 2025 AutoForm India
        </p>
      </motion.div>
    </div>
  );
}
