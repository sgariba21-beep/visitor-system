import { useState, useEffect } from "react";
import { supabase } from "../lib/supabaseClient";
import { useNavigate } from "react-router-dom";
import Spinner from "../components/Spinner";
import SchoolLogo from "../components/SchoolLogo";

export default function LoginPage() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [lockedUntil, setLockedUntil] = useState(null); // Date or null
  const [lockRemaining, setLockRemaining] = useState(0); // seconds left
  const navigate = useNavigate();

  // Live countdown while this email is locked out (3 wrong tries).
  useEffect(() => {
    if (!lockedUntil) return;
    const tick = () => {
      const secs = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      setLockRemaining(secs);
      if (secs <= 0) setLockedUntil(null);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [lockedUntil]);

  async function handleLogin(e) {
    e.preventDefault();           // Prevent page reload on form submit
    setError("");

    if (lockedUntil) return; // still cooling down

    setLoading(true);

    try {
      // Locked by email (not by device), tracked server-side so a page
      // refresh can't reset the count — checked before even attempting
      // the real sign-in.
      const { data: status } = await supabase.rpc("login_attempt_status", { p_email: email });
      if (status?.locked) {
        setLockedUntil(new Date(status.locked_until));
        setError("Too many failed attempts.");
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      const { data: result } = await supabase.rpc("record_login_result", {
        p_email: email,
        p_success: !signInError,
      });

      if (signInError) {
        if (result?.locked) {
          setLockedUntil(new Date(result.locked_until));
          setError("Too many failed attempts.");
        } else {
          const remaining = result?.attempts_remaining;
          setError(
            signInError.message.includes("Invalid login credentials")
              ? `Invalid email or password.${remaining != null ? ` ${remaining} attempt(s) remaining.` : ""}`
              : "Something went wrong. Please try again."
          );
        }
        return;
      }
      navigate("/admin/students"); // Redirect to admin panel on success
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <SchoolLogo height={52} style={{ margin: "0 auto 12px" }} />
        <h1 style={styles.title}>Staff Login</h1>
        <p style={styles.subtitle}>Our Lady of Grace SHS — Visitor Management System</p>

        <form onSubmit={handleLogin} style={styles.form}>
          <div style={styles.field}>
            <label style={styles.label}>Email</label>
            <input
              style={styles.input}
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@school.com"
              required
              autoFocus
            />
          </div>

          <div style={styles.field}>
            <label style={styles.label}>Password</label>
            <input
              style={styles.input}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}
          {lockedUntil && (
            <p style={styles.error}>
              Try again in {Math.floor(lockRemaining / 60)}:{String(lockRemaining % 60).padStart(2, "0")}
            </p>
          )}

          <button style={styles.button} type="submit" disabled={loading || !!lockedUntil}>
            {loading ? <Spinner size={18} color="#fff" /> : lockedUntil ? "Locked" : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)",
    padding: 16,
  },
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "40px 32px",
    width: "100%",
    maxWidth: 400,
    boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
    textAlign: "center",
  },
  logo:     { fontSize: 48, marginBottom: 12 },
  title:    { fontSize: 24, fontWeight: 700, color: "#1e3a5f", marginBottom: 4 },
  subtitle: { fontSize: 14, color: "#6b7280", marginBottom: 32 },
  form:     { textAlign: "left" },
  field:    { marginBottom: 16 },
  label:    { display: "block", fontSize: 13, fontWeight: 600, 
              color: "#374151", marginBottom: 6 },
  input:    {
    width: "100%", padding: "10px 14px", fontSize: 15,
    border: "1.5px solid #d1d5db", borderRadius: 8, outline: "none",
    transition: "border-color 0.2s",
  },
  error:  { color: "#dc2626", fontSize: 13, marginBottom: 12, 
            background: "#fef2f2", padding: "8px 12px", borderRadius: 6 },
  button: {
    width: "100%", padding: "12px", fontSize: 15, fontWeight: 600,
    background: "#2563eb", color: "#fff", border: "none",
    borderRadius: 8, cursor: "pointer", marginTop: 8,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
  },
};