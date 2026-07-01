export type ModuleKey = "sales" | "leads" | "finance";

export const ALL_MODULES: ModuleKey[] = ["sales", "leads", "finance"];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  sales: "Sales",
  leads: "Lead Analytics",
  finance: "Finance",
};
