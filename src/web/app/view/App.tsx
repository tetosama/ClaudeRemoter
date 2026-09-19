// Root component: checks authentication once and routes between the splash, login and workspace screens.
import { useEffect, useState } from "react";
import { Login } from "@/pages/login";
import { Workspace } from "@/pages/workspace";
import { api } from "@/shared/api/client";

// Decide which screen to show based on the current authentication state.
export function App() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");
  useEffect(() => {
    api<{ authenticated: boolean }>("/api/auth/status")
      .then((value) => setAuth(value.authenticated ? "in" : "out"))
      .catch(() => setAuth("out"));
  }, []);
  if (auth === "loading") return <Splash />;
  if (auth === "out") return <Login onSuccess={() => setAuth("in")} />;
  return <Workspace onLogout={() => setAuth("out")} />;
}

// Show the branded splash screen while the authentication check is pending.
function Splash() {
  return <main className="splash"><div className="brand-mark">C</div><p>Connecting to this Mac…</p></main>;
}
