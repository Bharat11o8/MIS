import { Outlet, useNavigate } from "react-router-dom";
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

      <Sidebar />

      <motion.main
        layout
        className="relative z-10 flex-1 flex flex-col bg-white rounded-[32px] overflow-hidden min-w-0"
        style={{ boxShadow: "0 10px 40px rgba(0,0,0,0.04)" }}
      >
        {/* Page content */}
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </motion.main>
    </div>
  );
}
