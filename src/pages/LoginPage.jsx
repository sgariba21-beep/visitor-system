import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";
import { useNavigate } from "react-router-dom";
import Spinner from "../components/Spinner";

export default function LoginPage() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const navigate = useNavigate();

  async function handleLogin(e) {
    e.preventDefault();           // Prevent page reload on form submit
    setError("");
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      navigate("/admin/students"); // Redirect to admin panel on success
    } catch (err) {
      // Firebase error codes are descriptive — we translate them for users
      if (err.code === "auth/user-not-found" || 
          err.code === "auth/wrong-password" ||
          err.code === "auth/invalid-credential") {
        setError("Invalid email or password.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logo}>🏫</div>
        <h1 style={styles.title}>Staff Login</h1>
        <p style={styles.subtitle}>Visitor Management System</p>

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

          <button style={styles.button} type="submit" disabled={loading}>
            {loading ? <Spinner size={18} color="#fff" /> : "Sign In"}
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