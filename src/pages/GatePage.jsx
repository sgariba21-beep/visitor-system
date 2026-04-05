import { useState, useEffect, useRef } from "react";
import {
  collection, query, where,
  getDocs, updateDoc, doc, serverTimestamp
} from "firebase/firestore";
import { db } from "../firebase";
import { Html5Qrcode } from "html5-qrcode";

// ─── Constants ────────────────────────────────────────────────────────────────
const CORRECT_PIN    = process.env.REACT_APP_GATE_PIN || "1234";
const SCANNER_DIV_ID = "qr-reader"; // html5-qrcode needs a div with a known ID

export default function GatePage() {

  // ── Screen state ────────────────────────────────────────────────────────────
  // Controls which UI panel is shown
  const [screen, setScreen] = useState("pin"); // "pin"|"scanner"|"result"|"manual"

  // ── PIN state ───────────────────────────────────────────────────────────────
  const [pinInput, setPinInput]   = useState("");
  const [pinError, setPinError]   = useState("");

  // ── Scanner state ───────────────────────────────────────────────────────────
  const [scannerError, setScannerError] = useState("");
  const scannerRef = useRef(null); // holds the Html5Qrcode instance

  // ── Result state ────────────────────────────────────────────────────────────
  const [visitDoc, setVisitDoc]     = useState(null);  // full visit data from Firestore
  const [visitDocId, setVisitDocId] = useState(null);  // Firestore document ID
  const [actionLoading, setActionLoading] = useState(false);
  const [actionFeedback, setActionFeedback] = useState(null); // {type, message}

  
  // ── Today's date string ─────────────────────────────────────────────────────
  // Used to validate QR codes — must match visit's visitDate
  const todayStr = new Date().toISOString().split("T")[0]; // "2025-04-05"

  // ────────────────────────────────────────────────────────────────────────────
  // PIN LOGIC
  // ────────────────────────────────────────────────────────────────────────────

  function handlePinSubmit(e) {
    e.preventDefault();
    if (pinInput === CORRECT_PIN) {
      // Store in sessionStorage so refreshing the page doesn't log them out
      sessionStorage.setItem("gate_auth", "true");
      setScreen("scanner");
      setPinError("");
    } else {
      setPinError("Incorrect PIN. Please try again.");
      setPinInput("");
    }
  }

  // Check sessionStorage on mount — if already authenticated, skip PIN
  useEffect(() => {
    if (sessionStorage.getItem("gate_auth") === "true") {
      setScreen("scanner");
    }
  }, []);

  // ────────────────────────────────────────────────────────────────────────────
  // SCANNER LOGIC
  // ────────────────────────────────────────────────────────────────────────────

  // Start the scanner when we enter the "scanner" screen
  useEffect(() => {
    if (screen !== "scanner") return;

    // Small delay to ensure the div is mounted in the DOM before
    // html5-qrcode tries to attach to it
    const timer = setTimeout(() => {
      startScanner();
    }, 300);

    // Cleanup: stop the scanner when we leave this screen
    return () => {
      clearTimeout(timer);
      stopScanner();
    };
  }, [screen]);

  async function startScanner() {
    try {
      // html5-qrcode attaches itself to a div by ID
      const scanner = new Html5Qrcode(SCANNER_DIV_ID);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" }, // use back camera on phones
        {
          fps: 10,           // scan attempts per second
          qrbox: { width: 250, height: 250 }, // the green scanning box
        },
        onScanSuccess,  // called when a QR code is detected
        onScanFailure   // called every failed frame (usually ignored)
      );
    } catch (err) {
      // Common reason: user denied camera permission
      setScannerError(
        "Camera access denied or unavailable. " +
        "Please allow camera access and reload the page."
      );
      console.error("Scanner start error:", err);
    }
  }

  async function stopScanner() {
    if (scannerRef.current) {
      try {
        const state = scannerRef.current.getState();
        // State 2 = SCANNING — only stop if actively scanning
        if (state === 2) {
          await scannerRef.current.stop();
        }
        scannerRef.current.clear();
      } catch (err) {
        // Ignore errors during cleanup — component may already be unmounted
      }
      scannerRef.current = null;
    }
  }

  // Called by html5-qrcode when it successfully reads a QR code
  async function onScanSuccess(decodedText) {
    // Stop scanning immediately — we don't want multiple triggers
    await stopScanner();
    setScannerError("");

    // Look up the visit in Firestore
    await lookupVisit(decodedText);
  }

  // Called on every failed scan frame — we just ignore these
  function onScanFailure() {}

  // ────────────────────────────────────────────────────────────────────────────
  // VISIT LOOKUP (shared by scanner and manual search)
  // ────────────────────────────────────────────────────────────────────────────

  async function lookupVisit(token) {
    try {
      const q = query(
        collection(db, "visits"),
        where("qrToken", "==", token.trim().toUpperCase())
      );
      const snap = await getDocs(q);

      if (snap.empty) {
        // Token not found in database
        showScanError("QR code not recognised. Ask the visitor to show their registration confirmation.");
        return;
      }

      const docSnap = snap.docs[0];
      const data    = docSnap.data();

      // ── DATE VALIDATION ────────────────────────────────────────────────────
      // This is the core security check.
      // A QR registered for April 12th must NOT work on April 5th.
      if (data.visitDate !== todayStr) {
        const formatted = formatDate(data.visitDate);
        showScanError(
          `This QR code is for ${formatted}, not today. ` +
          `Use manual lookup if the visitor needs assistance.`
        );
        return;
      }

      // All checks passed — show the visit details
      setVisitDoc(data);
      setVisitDocId(docSnap.id);
      setActionFeedback(null);
      setScreen("result");

    } catch (err) {
      console.error("Lookup failed:", err);
      showScanError("Database lookup failed. Check your connection and try again.");
    }
  }

  function showScanError(message) {
    setScannerError(message);
    setScreen("scanner");
    // Restart the scanner after 3 seconds so staff can try again
    setTimeout(() => {
      setScannerError("");
      startScanner();
    }, 3000);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CHECK-IN / CHECK-OUT LOGIC
  // ────────────────────────────────────────────────────────────────────────────

  async function handleAction() {
    if (!visitDocId || !visitDoc) return;
    setActionLoading(true);
    setActionFeedback(null);

    try {
      const ref = doc(db, "visits", visitDocId);

      if (visitDoc.status === "registered") {
        // ── CHECK IN ────────────────────────────────────────────────────────
        await updateDoc(ref, {
          status:      "checked_in",
          checkedInAt: serverTimestamp(),
        });
        setVisitDoc(prev => ({ ...prev, status: "checked_in" }));
        setActionFeedback({ type: "success", message: "✅ Checked in successfully. Welcome!" });

      } else if (visitDoc.status === "checked_in") {
        // ── CHECK OUT ───────────────────────────────────────────────────────
        await updateDoc(ref, {
          status:       "checked_out",
          checkedOutAt: serverTimestamp(),
        });
        setVisitDoc(prev => ({ ...prev, status: "checked_out" }));
        setActionFeedback({ type: "success", message: "👋 Checked out successfully. Safe travels!" });

      } else {
        // ── ALREADY CHECKED OUT ─────────────────────────────────────────────
        setActionFeedback({ type: "info", message: "This visit is already complete." });
      }

    } catch (err) {
      console.error("Action failed:", err);
      setActionFeedback({ type: "error", message: "Action failed. Check your connection." });
    } finally {
      setActionLoading(false);
    }
  }

  // After checking in/out, go back to scanner for the next visitor
  function scanNext() {
    setVisitDoc(null);
    setVisitDocId(null);
    setActionFeedback(null);
    setScreen("scanner");
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>

      {/* ── Top bar ── */}
      <div style={styles.topBar}>
        <span style={styles.topBarTitle}>🚦 Gate</span>
        {screen !== "pin" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              style={{
                ...styles.topBarBtn,
                background: screen === "scanner" ? "#1e40af" : "transparent",
              }}
              onClick={() => setScreen("scanner")}
            >
              📷 Scan
            </button>
            <button
              style={{
                ...styles.topBarBtn,
                background: screen === "manual" ? "#1e40af" : "transparent",
              }}
              onClick={() => setScreen("manual")}
            >
              🔍 Manual
            </button>
          </div>
        )}
        {screen !== "pin" && (
          <button
            style={styles.lockBtn}
            onClick={() => {
              sessionStorage.removeItem("gate_auth");
              setScreen("pin");
            }}
          >
            🔒
          </button>
        )}
      </div>

      {/* ════════════════════════════════════════════════════
          SCREEN: PIN entry
      ════════════════════════════════════════════════════ */}
      {screen === "pin" && (
        <div style={styles.centeredContent}>
          <div style={styles.pinCard}>
            <div style={{ fontSize: 48, textAlign: "center", marginBottom: 8 }}>🔐</div>
            <h2 style={styles.pinTitle}>Gate Access</h2>
            <p style={styles.pinSubtitle}>Enter your PIN to continue</p>
            <form onSubmit={handlePinSubmit}>
              <input
                style={styles.pinInput}
                type="password"
                inputMode="numeric"   // shows numeric keyboard on phones
                maxLength={6}
                value={pinInput}
                onChange={e => setPinInput(e.target.value)}
                placeholder="••••"
                autoFocus
              />
              {pinError && <p style={styles.pinError}>{pinError}</p>}
              <button type="submit" style={styles.btnPrimary}>
                Unlock Gate
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════
          SCREEN: QR Scanner
      ════════════════════════════════════════════════════ */}
      {screen === "scanner" && (
        <div style={styles.scannerScreen}>
          <p style={styles.scannerInstruction}>
            Point the camera at the visitor's QR code
          </p>

          {/* html5-qrcode mounts the camera feed into this div */}
          <div style={styles.scannerBox}>
            <div id={SCANNER_DIV_ID} style={{ width: "100%", height: "100%" }} />
          </div>

          {/* Error or status message below scanner */}
          {scannerError ? (
            <div style={styles.scannerError}>
              ⚠️ {scannerError}
            </div>
          ) : (
            <p style={styles.scannerHint}>
              QR not working? Use{" "}
              <span
                style={{ color: "#93c5fd", cursor: "pointer", textDecoration: "underline" }}
                onClick={() => setScreen("manual")}
              >
                manual lookup
              </span>
            </p>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════
          SCREEN: Visit result
      ════════════════════════════════════════════════════ */}
      {screen === "result" && visitDoc && (
        <div style={styles.centeredContent}>
          <div style={styles.resultCard}>

            {/* Status badge at top */}
            <div style={styles.statusBadgeRow}>
              <StatusBadge status={visitDoc.status} />
            </div>

            {/* Visitor info */}
            <h2 style={styles.visitorName}>{visitDoc.visitorName}</h2>
            <p style={styles.visitorPhone}>📞 {visitDoc.visitorPhone}</p>
            <p style={styles.visitorRelationship}>
              {visitDoc.relationship || "Visitor"}
            </p>

            <hr style={styles.divider} />

            {/* Students being visited */}
            <p style={styles.sectionLabel}>VISITING</p>
            <div style={styles.studentList}>
              {visitDoc.students?.map((s, i) => (
                <div key={i} style={styles.studentChip}>
                  🎓 {s.studentName}
                  <span style={styles.studentClass}>{s.class}</span>
                </div>
              ))}
            </div>

            {/* Purpose */}
            <p style={styles.sectionLabel} >PURPOSE</p>
            <p style={styles.purposeText}>
              {visitDoc.purpose === "Other"
                ? visitDoc.purposeOther
                : visitDoc.purpose}
            </p>

            <hr style={styles.divider} />

            {/* Timestamps */}
            <div style={styles.timestamps}>
              <TimestampRow
                label="Registered"
                value={visitDoc.registeredAt}
              />
              {visitDoc.checkedInAt && (
                <TimestampRow label="Checked In"  value={visitDoc.checkedInAt} />
              )}
              {visitDoc.checkedOutAt && (
                <TimestampRow label="Checked Out" value={visitDoc.checkedOutAt} />
              )}
            </div>

            {/* Feedback message after action */}
            {actionFeedback && (
              <div style={{
                ...styles.feedbackBox,
                background: actionFeedback.type === "success" ? "#f0fdf4"
                          : actionFeedback.type === "error"   ? "#fef2f2"
                          : "#f0f9ff",
                borderColor: actionFeedback.type === "success" ? "#86efac"
                           : actionFeedback.type === "error"   ? "#fca5a5"
                           : "#7dd3fc",
                color: actionFeedback.type === "success" ? "#166534"
                     : actionFeedback.type === "error"   ? "#991b1b"
                     : "#0369a1",
              }}>
                {actionFeedback.message}
              </div>
            )}

            {/* Action button — changes based on current status */}
            {visitDoc.status !== "checked_out" ? (
              <button
                style={{
                  ...styles.actionBtn,
                  background: visitDoc.status === "registered"
                    ? "linear-gradient(135deg, #16a34a, #15803d)"  // green for check-in
                    : "linear-gradient(135deg, #dc2626, #b91c1c)",  // red for check-out
                }}
                onClick={handleAction}
                disabled={actionLoading}
              >
                {actionLoading ? "Processing..." : (
                  visitDoc.status === "registered"
                    ? "✅  Check In Visitor"
                    : "👋  Check Out Visitor"
                )}
              </button>
            ) : (
              <div style={styles.completeBox}>
                🏁 This visit is complete
              </div>
            )}

            {/* Scan next button */}
            <button style={styles.scanNextBtn} onClick={scanNext}>
              ← Scan Next Visitor
            </button>

          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════
          SCREEN: Manual lookup (placeholder — built in Step 5)
      ════════════════════════════════════════════════════ */}
      {screen === "manual" && (
        <div style={styles.centeredContent}>
          <div style={styles.resultCard}>
            <p style={{ textAlign: "center", color: "#94a3b8", padding: 32 }}>
              🔍 Manual lookup coming in Step 5.
            </p>
            <button style={styles.scanNextBtn} onClick={() => setScreen("scanner")}>
              ← Back to Scanner
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Helper components ────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const config = {
    registered:  { label: "Not Arrived",   bg: "#fef3c7", color: "#92400e" },
    checked_in:  { label: "On Campus",     bg: "#dcfce7", color: "#166534" },
    checked_out: { label: "Departed",      bg: "#f3f4f6", color: "#374151" },
  };
  const c = config[status] || config.registered;
  return (
    <span style={{
      padding: "5px 14px", borderRadius: 999, fontSize: 13,
      fontWeight: 700, background: c.bg, color: c.color,
    }}>
      {c.label}
    </span>
  );
}

// Renders a Firestore Timestamp or null gracefully
function TimestampRow({ label, value }) {
  // Firestore Timestamps have a .toDate() method
  // But right after a serverTimestamp() write, it might be null briefly
  const formatted = value?.toDate
    ? value.toDate().toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      })
    : "—";

  return (
    <div style={{ display: "flex", justifyContent: "space-between",
                  fontSize: 13, padding: "4px 0", color: "#6b7280" }}>
      <span>{label}</span>
      <span style={{ fontWeight: 600, color: "#374151" }}>{formatted}</span>
    </div>
  );
}

// ─── Format date helper ───────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return "";
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page: {
    minHeight: "100vh",
    background: "#0f172a",
    color: "#f8fafc",
    display: "flex",
    flexDirection: "column",
  },

  // Top bar
  topBar: {
    display: "flex", justifyContent: "space-between",
    alignItems: "center", padding: "12px 16px",
    background: "#1e293b", borderBottom: "1px solid #334155",
    flexShrink: 0,
  },
  topBarTitle: { fontWeight: 700, fontSize: 16, color: "#f8fafc" },
  topBarBtn: {
    padding: "6px 14px", border: "1px solid #334155",
    borderRadius: 8, color: "#94a3b8", cursor: "pointer",
    fontSize: 13, fontWeight: 500,
  },
  lockBtn: {
    background: "transparent", border: "none",
    fontSize: 18, cursor: "pointer",
  },

  // Centered wrapper for PIN + result screens
  centeredContent: {
    flex: 1, display: "flex",
    justifyContent: "center", alignItems: "flex-start",
    padding: "24px 16px", overflowY: "auto",
  },

  // PIN screen
  pinCard: {
    background: "#1e293b", borderRadius: 20,
    padding: "36px 28px", width: "100%", maxWidth: 340,
    textAlign: "center",
  },
  pinTitle:    { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  pinSubtitle: { fontSize: 14, color: "#94a3b8", marginBottom: 24 },
  pinInput: {
    width: "100%", padding: "14px", fontSize: 24,
    textAlign: "center", letterSpacing: "0.3em",
    background: "#0f172a", border: "2px solid #334155",
    borderRadius: 12, color: "#f8fafc", marginBottom: 8,
  },
  pinError: { color: "#f87171", fontSize: 13, marginBottom: 12 },

  // Scanner screen
  scannerScreen: {
    flex: 1, display: "flex", flexDirection: "column",
    alignItems: "center", padding: "24px 16px",
  },
  scannerInstruction: {
    color: "#94a3b8", fontSize: 15, marginBottom: 16, textAlign: "center",
  },
  scannerBox: {
    width: "100%", maxWidth: 360, height: 320,
    borderRadius: 16, overflow: "hidden",
    border: "2px solid #334155",
    background: "#1e293b",
  },
  scannerError: {
    background: "#450a0a", border: "1px solid #991b1b",
    color: "#fca5a5", borderRadius: 10, padding: "12px 16px",
    fontSize: 14, marginTop: 16, maxWidth: 360,
    textAlign: "center", lineHeight: 1.5,
  },
  scannerHint: {
    color: "#475569", fontSize: 13, marginTop: 16, textAlign: "center",
  },

  // Result card
  resultCard: {
    background: "#1e293b", borderRadius: 20,
    padding: "24px 20px", width: "100%", maxWidth: 420,
  },
  statusBadgeRow: { textAlign: "center", marginBottom: 16 },
  visitorName: {
    fontSize: 24, fontWeight: 700,
    textAlign: "center", marginBottom: 4,
  },
  visitorPhone: {
    textAlign: "center", color: "#94a3b8", fontSize: 15, marginBottom: 2,
  },
  visitorRelationship: {
    textAlign: "center", color: "#64748b", fontSize: 13,
  },
  divider: { border: "none", borderTop: "1px solid #334155", margin: "16px 0" },
  sectionLabel: {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
    color: "#475569", marginBottom: 8, textTransform: "uppercase",
  },
  studentList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 },
  studentChip: {
    background: "#0f172a", borderRadius: 8,
    padding: "8px 12px", fontSize: 14, fontWeight: 600,
    display: "flex", justifyContent: "space-between", alignItems: "center",
  },
  studentClass: {
    fontSize: 12, color: "#64748b", fontWeight: 400,
  },
  purposeText: {
    fontSize: 14, color: "#94a3b8", marginBottom: 16,
  },
  timestamps: { marginBottom: 16 },

  feedbackBox: {
    padding: "10px 14px", borderRadius: 8, border: "1px solid",
    fontSize: 14, marginBottom: 14, textAlign: "center", lineHeight: 1.5,
  },

  actionBtn: {
    width: "100%", padding: "16px", fontSize: 17, fontWeight: 700,
    border: "none", borderRadius: 14, cursor: "pointer",
    color: "#fff", marginBottom: 12,
    boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
  },
  completeBox: {
    width: "100%", padding: "14px", textAlign: "center",
    background: "#1e293b", border: "1px solid #334155",
    borderRadius: 12, color: "#64748b", fontSize: 15,
    marginBottom: 12,
  },
  scanNextBtn: {
    width: "100%", padding: "11px", background: "transparent",
    border: "1px solid #334155", borderRadius: 10,
    color: "#64748b", cursor: "pointer", fontSize: 14,
  },

  // Shared
  btnPrimary: {
    width: "100%", padding: "13px", fontSize: 15, fontWeight: 700,
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#fff", border: "none", borderRadius: 12, cursor: "pointer",
    marginTop: 4,
  },
};