// Login page: collects the access password and starts the authenticated session.
import { useState, type FormEvent } from "react";
import { api, messageOf } from "@/shared/api/client";

// Collect the access password, authenticate against the backend and continue into the workspace.
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Post the password to the login endpoint and report success or the error.
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onSuccess();
    } catch (cause) {
      setError(messageOf(cause));
    } finally { setBusy(false); }
  };
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand-row"><div className="brand-mark">C</div><span>CLAUDE REMOTER</span></div>
        <h1>Your code, <br />still on this Mac.</h1>
        <p className="login-copy">Connect over your encrypted LAN to continue Claude Code sessions, approve actions and watch live progress.</p>
        <form onSubmit={submit}>
          <label htmlFor="password">Access password</label>
          <input id="password" autoFocus autoComplete="current-password" type="password" value={password}
            onChange={(event) => setPassword(event.target.value)} placeholder="Enter the password you set during setup" />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary wide" disabled={busy}>{busy ? "Signing in…" : "Enter workspace"}</button>
        </form>
        <p className="secure-note"><span className="status-dot online" /> HTTPS · Single user · Local-first</p>
      </section>
      <aside className="login-atmosphere"><div className="terminal-ghost">$ claude --resume<br /><span>⟶ session attached</span><br /><span>⟶ waiting for prompt</span></div></aside>
    </main>
  );
}
