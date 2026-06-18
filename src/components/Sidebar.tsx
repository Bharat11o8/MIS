import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  TrendingUp,
  Upload,
  BarChart2,
  ChevronLeft,
  ChevronRight,
  LogOut,
  UserCircle,
} from "lucide-react";
import { useAuth, UserRole } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

const logoSrc = "/autoform-logo.png";

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
  section?: string;
  roles: UserRole[];
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "overview",
    label: "Overview",
    icon: <LayoutDashboard size={16} />,
    path: "/dashboard",
    roles: ["superadmin", "management", "sales_head", "leads_head", "staff"],
  },
  {
    id: "sales",
    label: "Sales",
    icon: <TrendingUp size={16} />,
    path: "/dashboard/sales",
    section: "MODULES",
    roles: ["superadmin", "management", "sales_head"],
  },
  {
    id: "leads",
    label: "Lead Analytics",
    icon: <BarChart2 size={16} />,
    path: "/dashboard/leads",
    roles: ["superadmin", "management", "leads_head", "sales_rep"],
  },
  {
    id: "leads-upload",
    label: "Upload Data",
    icon: <Upload size={16} />,
    path: "/dashboard/leads/upload",
    roles: ["superadmin", "management", "leads_head", "sales_rep"],
  },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const visibleItems = NAV_ITEMS.filter((item) =>
    user ? item.roles.includes(user.role) : false
  );

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const roleLabel: Record<UserRole, string> = {
    superadmin: "Super Admin",
    management: "Management",
    sales_head: "Sales Head",
    leads_head: "Leads Head",
    sales_rep: "Sales Rep",
    staff: "Staff",
  };

  return (
    <motion.aside
      layout
      animate={{ width: collapsed ? 88 : 280 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      className="relative flex flex-col h-full bg-white rounded-[32px] border border-orange-100 overflow-hidden"
      style={{ boxShadow: "0 10px 40px rgba(0,0,0,0.04)", flexShrink: 0 }}
    >
      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute top-5 -right-3 z-20 w-6 h-6 rounded-full bg-white border border-orange-100 flex items-center justify-center text-gray-400 hover:text-orange-500 hover:border-orange-300 transition-all duration-200 shadow-sm"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>

      {/* Logo — always centred */}
      <div className="flex items-center justify-center h-20 border-b border-orange-50 shrink-0 px-4">
        <AnimatePresence mode="wait">
          {collapsed ? (
            <motion.img
              key="icon"
              src={logoSrc}
              alt="AutoForm"
              className="h-8 w-8 object-contain object-left"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
          ) : (
            <motion.img
              key="full"
              src={logoSrc}
              alt="AutoForm India"
              className="h-10 w-auto"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 flex flex-col gap-0.5">
        {visibleItems.map((item, idx) => {
          const isActive =
            item.path === "/dashboard"
              ? location.pathname === "/dashboard"
              : location.pathname.startsWith(item.path);

          const prevItem = visibleItems[idx - 1];
          const showSection = item.section && item.section !== prevItem?.section;

          return (
            <div key={item.id}>
              {showSection && !collapsed && (
                <p className="nav-section-label">{item.section}</p>
              )}
              {showSection && collapsed && (
                <div className="my-2 mx-3 h-px bg-orange-50" />
              )}

              <button
                id={`nav-${item.id}`}
                onClick={() => navigate(item.path)}
                className={cn(
                  "nav-item w-full",
                  isActive && "active",
                  collapsed && "justify-center px-0"
                )}
                title={collapsed ? item.label : undefined}
              >
                <span className="nav-icon">{item.icon}</span>
                <AnimatePresence>
                  {!collapsed && (
                    <motion.span
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: "auto" }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden whitespace-nowrap text-sm font-medium"
                    >
                      {item.label}
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
            </div>
          );
        })}
      </nav>

      {/* Bottom — user info + logout */}
      <div className="px-3 pb-4 border-t border-orange-50 pt-3 shrink-0 flex flex-col gap-2">

        {/* User card — click to go to profile */}
        <button
          onClick={() => navigate("/dashboard/profile")}
          className={cn(
            "flex items-center gap-3 rounded-2xl p-3 w-full text-left transition-colors hover:bg-orange-50",
            location.pathname === "/dashboard/profile" ? "bg-orange-50" : "bg-orange-50/40",
            collapsed && "justify-center p-2"
          )}
          title={collapsed ? "My Profile" : undefined}
        >
          <div className="w-8 h-8 rounded-xl bg-orange-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
            {user?.name?.charAt(0) ?? "U"}
          </div>

          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: "auto" }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.2 }}
                className="flex-1 overflow-hidden min-w-0"
              >
                <p className="text-xs font-bold text-gray-800 truncate">{user?.name}</p>
                <p className="text-[10px] text-orange-500 font-bold uppercase tracking-wider">
                  {user ? roleLabel[user.role] : ""}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="shrink-0 text-gray-300"
              >
                <UserCircle size={14} />
              </motion.span>
            )}
          </AnimatePresence>
        </button>

        {/* Sign Out button */}
        <AnimatePresence>
          {!collapsed ? (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={handleLogout}
              className="flex items-center justify-center gap-2 w-full h-9 rounded-xl text-xs font-bold uppercase tracking-wider text-red-400 border border-red-100 bg-red-50/60 hover:bg-red-100 hover:text-red-600 hover:border-red-200 transition-all duration-200"
            >
              <LogOut size={13} />
              Sign Out
            </motion.button>
          ) : (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={handleLogout}
              title="Sign Out"
              className="flex items-center justify-center w-full h-9 rounded-xl text-red-400 hover:bg-red-50 hover:text-red-600 transition-all duration-200"
            >
              <LogOut size={15} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </motion.aside>
  );
}
