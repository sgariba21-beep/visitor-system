import { useState, useEffect } from "react";
import { supabase } from "../lib/supabaseClient";
import { QRCodeSVG } from "qrcode.react";
import SchoolLogo from "../components/SchoolLogo";

export default function QrPage() {
  const [visit, setVisit]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  // Extract token from URL path: /qr/VIS-XXXXXX
  const token = window.location.pathname.split("/qr/")[1];

  useEffect(() => {
    if (!token) {
      setError("No QR token provided.");
      setLoading(false);
      return;
    }
    lookupVisit(token);
  }, [token]);

  async function lookupVisit(qrToken) {
    try {
      // A single visit by its exact token is a capability lookup (scoped
      // to whoever already holds this token), not a broad table read, so
      // it's served by a narrow RPC rather than a direct table select —
      // see get_visit_by_token in 0012_gate_read_rpcs.
      const { data, error: queryError } = await supabase
        .rpc("get_visit_by_token", { p_qr_token: qrToken });

      if (queryError) throw queryError;

      if (!data) {
        setError("Visit not found. This link may be invalid.");
        return;
      }

      setVisit(data);
    } catch (err) {
      console.error("Lookup failed:", err);
      setError("Could not load visit details. Please check your connection.");
    } finally {
      setLoading(false);
    }
  }

  // Format "2025-04-05" → "Saturday, 5 April 2025"
  function formatDate(dateStr) {
    if (!dateStr) return "";
    const [year, month, day] = dateStr.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric",
      month: "long",   year: "numeric"
    });
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <p style={{ textAlign: "center", color: "#6b7280", fontSize: 15 }}>
            Loading your QR code...
          </p>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>&#10060;</div>
            <h1 style={styles.title}>{error}</h1>
            <p style={{ color: "#6b7280", fontSize: 14, marginTop: 8 }}>
              If you believe this is a mistake, contact the school office.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Visit found — display QR ──────────────────────────────────────────────
  const displayPurpose = visit.purpose === "Other"
    ? visit.purpose_other
    : visit.purpose;

  return (
    <div style={styles.page}>
      <div style={styles.card}>

        {/* Header */}
        <div style={styles.header}>
          <SchoolLogo height={44} style={{ margin: "0 auto 8px" }} />
          <h1 style={styles.title}>Your Visit QR Code</h1>
          <p style={styles.subtitle}>
            Show this to staff at the gate on your visiting day
          </p>
        </div>

        {/* QR Code */}
        <div style={styles.qrWrapper}>
          <QRCodeSVG
            value={visit.qr_token}
            size={200}
            level="H"
            includeMargin={true}
          />
          <p style={styles.qrToken}>{visit.qr_token}</p>
        </div>

        {/* Visit summary */}
        <div style={styles.summary}>
          <Row label="Visitor"    value={visit.visitor_name} />
          <Row label="Phone"      value={visit.visitor_phone} />
          <Row label="Visit Date" value={formatDate(visit.visit_date)} />
          <Row label="Purpose"    value={displayPurpose} />
          <Row
            label="Student(s)"
            value={visit.visit_students.map(s => `${s.student_name} (${s.class})`).join(", ")}
          />
          <Row label="Status" value={visit.status.replace("_", " ").toUpperCase()} />
        </div>

        {/* Instructions */}
        <div style={styles.instructions}>
          <p style={styles.instructionTitle}>&#128204; Important</p>
          <ul style={styles.instructionList}>
            <li>Screenshot or save this QR code before closing this page.</li>
            <li>This QR is only valid on <strong>{formatDate(visit.visit_date)}</strong>.</li>
            <li>If you lose it, staff can look you up manually at the gate.</li>
          </ul>
        </div>

      </div>
    </div>
  );
}

// ── Small helper ─────────────────────────────────────────────────────────────
function Row({ label, value }) {
  return (
    <div style={rowStyles.row}>
      <span style={rowStyles.label}>{label}</span>
      <span style={rowStyles.value}>{value}</span>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(160deg, #f0f4ff 0%, #fafafa 100%)",
    padding: "32px 16px",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
  },
  card: {
    background: "#fff",
    borderRadius: 20,
    padding: "36px 32px",
    width: "100%",
    maxWidth: 560,
    boxShadow: "0 4px 32px rgba(0,0,0,0.08)",
  },
  header: { textAlign: "center", marginBottom: 24 },
  title: {
    fontSize: 22, fontWeight: 700, color: "#0f172a", marginBottom: 4,
  },
  subtitle: { fontSize: 14, color: "#6b7280" },

  qrWrapper: {
    display: "flex", flexDirection: "column",
    alignItems: "center", marginBottom: 24,
    padding: 20, background: "#f8fafc",
    borderRadius: 16, border: "1px dashed #cbd5e1",
  },
  qrToken: {
    marginTop: 12, fontSize: 18, fontWeight: 700,
    letterSpacing: "0.12em", color: "#0f172a",
    fontFamily: "monospace",
  },

  summary: {
    background: "#f8fafc", borderRadius: 12,
    padding: "16px 20px", marginBottom: 20,
  },

  instructions: {
    background: "#fffbeb", border: "1px solid #fde68a",
    borderRadius: 10, padding: "14px 18px",
  },
  instructionTitle: { fontWeight: 700, color: "#92400e", marginBottom: 8, fontSize: 14 },
  instructionList: { paddingLeft: 18, color: "#78350f", fontSize: 13, lineHeight: 1.8 },
};

const rowStyles = {
  row: {
    display: "flex", justifyContent: "space-between",
    padding: "7px 0", borderBottom: "1px solid #e2e8f0", fontSize: 14,
  },
  label: { color: "#64748b", fontWeight: 500 },
  value: {
    color: "#0f172a", fontWeight: 600, textAlign: "right",
    maxWidth: "60%", wordBreak: "break-word",
  },
};
