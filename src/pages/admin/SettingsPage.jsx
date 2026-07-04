import { useState, useEffect } from "react";
import { supabase } from "../../lib/supabaseClient";
import Spinner from "../../components/Spinner";

const PIN_PATTERN = /^[0-9]{4,6}$/;

export default function SettingsPage() {
  const [pin, setPin]           = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [feedback, setFeedback] = useState(null); // { type, message }

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSettings() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("gate_settings")
        .select("pin, updated_at")
        .eq("id", true)
        .single();
      if (error) throw error;
      setPin(data.pin);
      setUpdatedAt(data.updated_at);
    } catch {
      showFeedback("error", "Failed to load gate settings.");
    } finally {
      setLoading(false);
    }
  }

  function showFeedback(type, message) {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 4000);
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!PIN_PATTERN.test(pin)) {
      showFeedback("error", "PIN must be 4 to 6 digits.");
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("gate_settings")
        .update({ pin, updated_at: new Date().toISOString() })
        .eq("id", true)
        .select("updated_at")
        .single();
      if (error) throw error;
      setUpdatedAt(data.updated_at);
      showFeedback("success", "Gate PIN updated. Gate devices will pick it up next time they're online.");
    } catch {
      showFeedback("error", "Failed to update gate PIN.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.page} className="admin-page">

      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Settings</h1>
          <p style={styles.subtitle}>Manage gate access</p>
        </div>
      </div>

      {feedback && (
        <div style={{
          ...styles.feedback,
          background: feedback.type === "success" ? "#f0fdf4" : "#fef2f2",
          borderColor: feedback.type === "success" ? "#86efac" : "#fca5a5",
          color:       feedback.type === "success" ? "#166534" : "#991b1b",
        }}>
          {feedback.type === "success" ? "✅" : "❌"} {feedback.message}
        </div>
      )}

      <div style={styles.card}>
        <h2 style={styles.cardTitle}>Gate PIN</h2>
        <p style={styles.cardHint}>
          The 4–6 digit PIN gate staff enter to unlock the scanner at{" "}
          <code>/gate</code>. Changing it here does not require a redeploy —
          gate devices pick up the new PIN the next time they're online
          (they keep working offline with the last PIN they saw).
        </p>

        {loading ? (
          <div style={{ padding: 24 }}>
            <Spinner size={28} />
          </div>
        ) : (
          <form onSubmit={handleSave} style={styles.form}>
            <div style={styles.field}>
              <label style={styles.label}>PIN</label>
              <input
                style={styles.input}
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, ""))}
                placeholder="1234"
                required
              />
            </div>
            {updatedAt && (
              <p style={styles.updatedAt}>
                Last changed {new Date(updatedAt).toLocaleString("en-GB")}
              </p>
            )}
            <button type="submit" style={styles.btnPrimary} disabled={saving}>
              {saving ? <Spinner size={16} color="#fff" /> : "Save PIN"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  page:    { padding: 32, maxWidth: 640, margin: "0 auto" },
  header:  { marginBottom: 24 },
  title:   { fontSize: 26, fontWeight: 700, color: "#0f172a" },
  subtitle:{ fontSize: 14, color: "#6b7280", marginTop: 2 },

  feedback: { padding: "10px 16px", borderRadius: 8, border: "1px solid",
              marginBottom: 16, fontSize: 14 },

  card: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12,
          padding: 24 },
  cardTitle: { fontSize: 17, fontWeight: 600, color: "#0f172a", marginBottom: 8 },
  cardHint:  { fontSize: 13, color: "#6b7280", lineHeight: 1.6, marginBottom: 20 },

  form:  { display: "flex", flexDirection: "column", gap: 6, maxWidth: 220 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  label: { fontSize: 13, fontWeight: 600, color: "#374151" },
  input: { padding: "9px 12px", fontSize: 16, letterSpacing: "0.1em",
           border: "1.5px solid #d1d5db", borderRadius: 8, outline: "none" },

  updatedAt: { fontSize: 12, color: "#9ca3af", marginTop: 2 },

  btnPrimary: { marginTop: 14, padding: "9px 18px", background: "#2563eb",
                color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
                fontSize: 14, fontWeight: 600, display: "flex",
                alignItems: "center", justifyContent: "center", gap: 6 },
};
