import { Outlet, useNavigate } from "react-router-dom";
import { Search, Bell, User } from "lucide-react";
import { motion } from "framer-motion";
import Sidebar from "@/components/Sidebar";
import { useAuth } from "@/context/AuthContext";

export default function DashboardLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user) {
    navigate("/login");
    return null;
  }

  return (
    <div
      className="h-screen w-full flex gap-3 p-3 overflow-hidden"
      style={{ background: "#fff2e6" }}
    >
      {/* Background glow blobs */}
      <div
        className="fixed top-[-50px] left-20 w-[400px] h-[400px] rounded-full pointer-events-none z-0"
        style={{
          background: "radial-gradient(circle, rgba(244,102,23,0.07) 0%, transparent 70%)",
          filter: "blur(80px)",
        }}
      />
      <div
        className="fixed bottom-0 right-0 w-[350px] h-[350px] rounded-full pointer-events-none z-0"
        style={{
          background: "radial-gradient(circle, rgba(59,130,246,0.06) 0%, transparent 70%)",
          filter: "blur(60px)",
        }}
      />

      {/* Sidebar */}
      <Sidebar />

      {/* Main content */}
      <motion.main
        layout
        className="relative z-10 flex-1 flex flex-col bg-white rounded-[32px] overflow-hidden min-w-0"
        style={{ boxShadow: "0 10px 40px rgba(0,0,0,0.04)" }}
      >
        {/* Top Header */}
        <header className="flex items-center justify-between h-16 px-6 border-b border-gray-50 shrink-0">
          {/* Search */}
          <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2 w-64 group hover:bg-gray-100 transition-colors">
            <Search size={14} className="text-gray-400" />
            <input
              id="header-search"
              type="text"
              placeholder="Search..."
              className="bg-transparent text-sm text-gray-600 placeholder-gray-400 outline-none flex-1"
            />
            <kbd className="text-[10px] text-gray-300 font-mono bg-white rounded px-1.5 py-0.5 border border-gray-100">
              ctrl+K
            </kbd>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {/* Notification bell */}
            <button
              id="header-notifications"
              className="relative w-9 h-9 rounded-xl flex items-center justify-center text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition-all"
            >
              <Bell size={16} />
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-orange-500" />
            </button>

            {/* User avatar */}
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-orange-500 flex items-center justify-center text-white text-xs font-bold">
                {user.name.charAt(0)}
              </div>
              <div className="hidden md:block">
                <p className="text-xs font-bold text-gray-800">{user.name}</p>
                <p className="text-[10px] text-orange-500 font-bold uppercase tracking-wider">
                  {user.role.replace("_", " ")}
                </p>
              </div>
            </div>
          </div>
        </header>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </motion.main>
    </div>
  );
}
