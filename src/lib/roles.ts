import { UserRole } from "@/context/AuthContext";

export const ROLE_LABELS: Record<UserRole, string> = {
  superadmin: "Super Admin",
  management: "Management",
  sales_head: "Sales Head",
  leads_head: "Leads Head",
  sales_rep: "Sales Rep",
  staff: "Staff",
};

export const ROLE_COLORS: Record<UserRole, string> = {
  superadmin: "bg-purple-100 text-purple-700",
  management: "bg-blue-100 text-blue-700",
  sales_head: "bg-green-100 text-green-700",
  leads_head: "bg-orange-100 text-orange-700",
  sales_rep: "bg-yellow-100 text-yellow-700",
  staff: "bg-gray-100 text-gray-600",
};

// Roles offered when creating or editing a user. Deliberately just three:
// Super Admin, Management, Staff. The older sales_head/leads_head/sales_rep
// roles are retired from the picker but kept in ROLE_LABELS/ROLE_COLORS above so
// any legacy user still assigned one keeps a proper badge until reassigned.
// (Access is governed by per-module toggles now, not by role — see modules.ts.)
export const ALL_ROLES: UserRole[] = [
  "superadmin",
  "management",
  "staff",
];
