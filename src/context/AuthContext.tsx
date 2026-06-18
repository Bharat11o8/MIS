import React, { createContext, useContext, useState } from "react";

export type UserRole =
  | "superadmin"
  | "management"
  | "sales_head"
  | "leads_head"
  | "sales_rep"
  | "staff";

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  department?: string;
  must_change_password?: boolean;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  mustChangePassword: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
  clearPasswordFlag: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

function loadFromStorage(): { user: User | null; token: string | null } {
  try {
    const storedUser = localStorage.getItem("mis_user");
    const storedToken = localStorage.getItem("mis_token");
    if (storedUser && storedToken) {
      return { user: JSON.parse(storedUser), token: storedToken };
    }
  } catch {
    localStorage.removeItem("mis_user");
    localStorage.removeItem("mis_token");
  }
  return { user: null, token: null };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const initial = loadFromStorage();
  const [user, setUser] = useState<User | null>(initial.user);
  const [token, setToken] = useState<string | null>(initial.token);
  const [mustChangePassword, setMustChangePassword] = useState<boolean>(
    initial.user?.must_change_password ?? false
  );

  const login = async (
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: errorData.detail || "Invalid email or password",
        };
      }

      const data = await response.json();
      setUser(data.user);
      setToken(data.access_token);
      setMustChangePassword(!!data.must_change_password);
      localStorage.setItem("mis_user", JSON.stringify(data.user));
      localStorage.setItem("mis_token", data.access_token);
      return { success: true };
    } catch {
      return {
        success: false,
        error: "Cannot connect to server. Please check if the backend is running.",
      };
    }
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    setMustChangePassword(false);
    localStorage.removeItem("mis_user");
    localStorage.removeItem("mis_token");
  };

  // Called by ResetPasswordPage after successful reset
  const clearPasswordFlag = () => {
    setMustChangePassword(false);
    if (user) {
      const updated = { ...user, must_change_password: false };
      setUser(updated);
      localStorage.setItem("mis_user", JSON.stringify(updated));
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, token, isAuthenticated: !!user, mustChangePassword, login, logout, clearPasswordFlag }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
