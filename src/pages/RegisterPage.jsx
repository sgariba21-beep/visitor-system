import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import { QRCodeCanvas } from "qrcode.react";

// ─── Purpose options ──────────────────────────────────────────────────────────
const PURPOSE_OPTIONS = [
  "General Visit",
  "PTA Meeting",
  "Academic Concerns",
  "Medical",
  "Financial",
  "Pickup / Leave",
  "Other",
];

// ─── Relationship options ─────────────────────────────────────────────────────
const RELATIONSHIP_OPTIONS = [
  "Parent / Guardian",
  "Sibling",
  "Relative",
  "Family Friend",
  "Other",
];

export default function RegisterPage() {

  // ── Form field state ────────────────────────────────────────────────────────
  const [visitorName, setVisitorName]   = useState("");
  const [visitorPhone, setVisitorPhone] = useState("");
  const [relationship, setRelationship] = useState("");
  const [visitDate, setVisitDate]       = useState("");
  const [purpose, setPurpose]           = useState("");
  const [purposeOther, setPurposeOther] = useState(""); // shown only when purpose = "Other"

  // ── Student search state ────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]         = useState("");
  const [searchResults, setSearchResults]     = useState([]);
  const [selectedStudents, setSelectedStudents] = useState([]); // array of student objects
  const [searching, setSearching]             = useState(false);
  const searchTimeout                         = useRef(null);   // for debouncing
  const qrWrapperRef                          = useRef(null);   // for QR canvas image export

  // ── Student ID verification state ────────────────────────────────────────────
  const [pendingStudent, setPendingStudent] = useState(null);  // student awaiting ID verification
  const [idInput, setIdInput]               = useState("");    // what the visitor typed
  const [idError, setIdError]               = useState("");    // per-attempt error message
  const [failedAttempts, setFailedAttempts] = useState(0);     // session-wide counter
  const [lockedOut, setLockedOut]           = useState(false); // true after 3 failures
  const MAX_ATTEMPTS = 3;

  // ── Page state ──────────────────────────────────────────────────────────────
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState("");
  const [successData, setSuccessData] = useState(null); // holds visit doc after submission

  // ── Date boundaries ─────────────────────────────────────────────────────────
  // Parents can only pick today or a future date
  const today = new Date().toISOString().split("T")[0]; // "2025-04-05"

  // ── Student search with debounce ────────────────────────────────────────────
  // Debounce means: don't fire a Firestore query on every single keypress.
  // Wait until the user stops typing for 400ms, THEN search.
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }

    // Clear any existing timer
    if (searchTimeout.current) clearTimeout(searchTimeout.current);

    // Set a new timer
    searchTimeout.current = setTimeout(() => {
      performSearch(searchQuery.trim());
    }, 400);

    // Cleanup timer if component unmounts or query changes again
    return () => clearTimeout(searchTimeout.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  async function performSearch(queryText) {
    setSearching(true);
    try {
      // Postgres full-text search isn't wired up (no need at this scale) —
      // we fetch all active students and filter client-side, same as before.
      const { data, error } = await supabase
        .from("students")
        .select("*")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      const all = data;

      // Filter locally by name or class
      const lower = queryText.toLowerCase();
      const results = all.filter(s =>
        s.name.toLowerCase().includes(lower) ||
        s.class.toLowerCase().includes(lower)
      );

      // Remove already-selected students from results
      const selectedIds = selectedStudents.map(s => s.id);
      setSearchResults(results.filter(s => !selectedIds.includes(s.id)));

    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setSearching(false);
    }
  }

  // ── Add a student to the selected list (now requires ID verification) ──────
  function selectStudent(student) {
    if (lockedOut) return;

    // Block students without a student_id
    if (!student.student_id) {
      setError("This student does not have a Student ID configured. Please contact the school.");
      setSearchQuery("");
      setSearchResults([]);
      return;
    }

    // Open verification prompt instead of adding immediately
    setPendingStudent(student);
    setIdInput("");
    setIdError("");
    setSearchQuery("");
    setSearchResults([]);
  }

  // ── Verify the student ID the visitor typed ────────────────────────────────
  function verifyStudentId() {
    if (!pendingStudent) return;

    const correctId = (pendingStudent.student_id || "").toLowerCase();
    if (idInput.trim().toLowerCase() === correctId) {
      // Correct — add student to selected list
      setSelectedStudents(prev => [...prev, pendingStudent]);
      setPendingStudent(null);
      setIdInput("");
      setIdError("");
    } else {
      // Incorrect
      const newCount = failedAttempts + 1;
      setFailedAttempts(newCount);

      if (newCount >= MAX_ATTEMPTS) {
        setLockedOut(true);
        setPendingStudent(null);
        setIdInput("");
        setIdError("");
      } else {
        setIdError(
          `Incorrect Student ID. ${MAX_ATTEMPTS - newCount} attempt(s) remaining.`
        );
        setIdInput("");
      }
    }
  }

  function cancelVerification() {
    setPendingStudent(null);
    setIdInput("");
    setIdError("");
  }

  // ── Remove a student from the selected list ─────────────────────────────────
  function removeStudent(studentId) {
    setSelectedStudents(prev => prev.filter(s => s.id !== studentId));
  }

  // ── Form submission ─────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    setError("");

    // Validate students selected
    if (selectedStudents.length === 0) {
      setError("Please search for and select at least one student.");
      return;
    }

    // Validate purpose
    if (!purpose) {
      setError("Please select a purpose for your visit.");
      return;
    }

    if (purpose === "Other" && !purposeOther.trim()) {
      setError("Please describe the purpose of your visit.");
      return;
    }

    setSubmitting(true);

    try {
      // create_visit atomically inserts the visits row + one visit_students
      // row per selected student, and generates + collision-checks the QR
      // token server-side.
      const { data, error: rpcError } = await supabase.rpc("create_visit", {
        p_visitor_name:  visitorName.trim(),
        p_visitor_phone: visitorPhone.trim(),
        p_relationship:  relationship || "Not specified",
        p_purpose:       purpose,
        p_purpose_other: purpose === "Other" ? purposeOther.trim() : "",
        p_visit_date:    visitDate,
        p_status:        "registered",
        p_created_by:    "self",
        p_students: selectedStudents.map(s => ({
          student_id:   s.id,
          student_name: s.name,
          class:        s.class,
        })),
      });

      if (rpcError) throw rpcError;

      // Show the success / QR screen. The students list is built from what
      // we already have client-side rather than re-fetching the join.
      setSuccessData({
        visitorName:  data.visitor_name,
        visitorPhone: data.visitor_phone,
        purpose:      data.purpose,
        purposeOther: data.purpose_other,
        visitDate:    data.visit_date,
        qrToken:      data.qr_token,
        students: selectedStudents.map(s => ({
          studentName: s.name,
          class:       s.class,
        })),
      });

    } catch (err) {
      console.error("Registration failed:", err);
      setError("Registration failed. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Reset to register another visit ────────────────────────────────────────
  function registerAnother() {
    setVisitorName("");
    setVisitorPhone("");
    setRelationship("");
    setVisitDate("");
    setPurpose("");
    setPurposeOther("");
    setSelectedStudents([]);
    setSearchQuery("");
    setSearchResults([]);
    setSuccessData(null);
    setError("");
    setFailedAttempts(0);
    setLockedOut(false);
    setPendingStudent(null);
    setIdInput("");
    setIdError("");
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SUCCESS SCREEN — shown after successful submission
  // ────────────────────────────────────────────────────────────────────────────
  if (successData) {
    const displayPurpose = successData.purpose === "Other"
      ? successData.purposeOther
      : successData.purpose;

    const studentNames = successData.students
      .map(s => `${s.studentName} (${s.class})`)
      .join(", ");

    // Fallback message (text link) — used when image sharing isn't available
    const qrUrl = `${window.location.origin}/qr/${successData.qrToken}`;
    const fallbackMessage =
      `Your visit to the school has been registered.\n\n` +
      `Visitor: ${successData.visitorName}\n` +
      `Date: ${formatDate(successData.visitDate)}\n` +
      `Student(s): ${studentNames}\n\n` +
      `Open this link to view your QR code:\n${qrUrl}\n\n` +
      `Show the QR code to staff at the gate on your visiting day.`;

    // Message used when sharing the QR image directly
    const imageShareText =
      `Your visit to the school has been registered.\n\n` +
      `Visitor: ${successData.visitorName}\n` +
      `Date: ${formatDate(successData.visitDate)}\n` +
      `Student(s): ${studentNames}\n\n` +
      `Show the attached QR code to staff at the gate on your visiting day. ` +
      `This QR is only valid on ${formatDate(successData.visitDate)}.`;

    // Format phone for WhatsApp fallback (strip leading 0, add Ghana country code)
    const rawPhone = successData.visitorPhone.replace(/\D/g, "");
    const waPhone = rawPhone.startsWith("0") ? "233" + rawPhone.slice(1) : rawPhone;
    const whatsappUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(fallbackMessage)}`;

    function canvasToBlob(canvas) {
      return new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    }

    async function downloadQR() {
      const canvas = qrWrapperRef.current?.querySelector("canvas");
      if (!canvas) return;
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `visit-qr-${successData.qrToken}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    async function handleWhatsApp() {
      const canvas = qrWrapperRef.current?.querySelector("canvas");
      if (canvas) {
        const blob = await canvasToBlob(canvas);
        const file = new File([blob], `visit-qr-${successData.qrToken}.png`, { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          try {
            await navigator.share({ files: [file], text: imageShareText });
            return;
          } catch (err) {
            if (err.name === "AbortError") return;
            // fall through to text link fallback
          }
        }
      }
      window.open(whatsappUrl, "_blank", "noopener,noreferrer");
    }

    return (
      <div style={styles.page}>
        <div style={styles.card}>

          {/* Header */}
          <div style={styles.successHeader}>
            <div style={styles.successIcon}>&#9989;</div>
            <h1 style={styles.successTitle}>Registration Complete</h1>
            <p style={styles.successSubtitle}>
              Your QR code is ready. Save it or send it to your phone below.
            </p>
          </div>

          {/* Visit summary */}
          <div style={styles.summary}>
            <SummaryRow label="Visitor"     value={successData.visitorName} />
            <SummaryRow label="Phone"       value={successData.visitorPhone} />
            <SummaryRow label="Visit Date"  value={formatDate(successData.visitDate)} />
            <SummaryRow label="Purpose"     value={displayPurpose} />
            <SummaryRow label="Student(s)"  value={studentNames} />
          </div>

          {/* QR Code */}
          <div ref={qrWrapperRef} style={styles.qrBox}>
            <QRCodeCanvas
              value={successData.qrToken}
              size={200}
              level="H"
              includeMargin={true}
            />
            <p style={styles.qrToken}>{successData.qrToken}</p>
          </div>

          {/* Action buttons */}
          <div style={styles.shareSection}>
            <p style={styles.shareTitle}>Save or Send Your QR Code</p>

            <button onClick={downloadQR} style={styles.btnDownload}>
              <span style={{ fontSize: 20 }}>&#11015;</span>
              Save QR Image
            </button>

            <button onClick={handleWhatsApp} style={styles.btnWhatsApp}>
              <span style={{ fontSize: 20 }}>&#128172;</span>
              Share via WhatsApp
            </button>

          </div>

          {/* Instructions */}
          <div style={styles.instructions}>
            <p style={styles.instructionTitle}>&#128204; Important</p>
            <ul style={styles.instructionList}>
              <li>Save the QR image or screenshot this screen — no internet needed to show it at the gate.</li>
              <li>Use the buttons above to save or share the QR to your phone.</li>
              <li>This QR is only valid on <strong>{formatDate(successData.visitDate)}</strong>.</li>
              <li>If you lose it, staff can look you up manually at the gate.</li>
            </ul>
          </div>

          <button style={styles.btnSecondary} onClick={registerAnother}>
            Register Another Visit
          </button>
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────
  // REGISTRATION FORM
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div style={styles.page}>
      <div style={styles.card}>

        {/* Header */}
        <div style={styles.formHeader}>
          <div style={{ fontSize: 40 }}>🏫</div>
          <h1 style={styles.formTitle}>Visitor Pre-Registration</h1>
          <p style={styles.formSubtitle}>
            Register before your visit to speed up gate entry
          </p>
        </div>

        <form onSubmit={handleSubmit}>

          {/* ── Section 1: Visitor Information ── */}
          <Section title="Your Information">

            <Field label="Full Name *">
              <input
                style={styles.input}
                value={visitorName}
                onChange={e => setVisitorName(e.target.value)}
                placeholder="e.g. Abena Mensah"
                required
              />
            </Field>

            <Field label="Phone Number *">
              <input
                style={styles.input}
                type="tel"
                value={visitorPhone}
                onChange={e => setVisitorPhone(e.target.value)}
                placeholder="e.g. 0244123456"
                required
              />
            </Field>

            <Field label="Relationship to Student">
              <select
                style={styles.input}
                value={relationship}
                onChange={e => setRelationship(e.target.value)}
              >
                <option value="">— Select relationship —</option>
                {RELATIONSHIP_OPTIONS.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>

          </Section>

          {/* ── Section 2: Visit Details ── */}
          <Section title="Visit Details">

            <Field label="Visit Date *">
              <input
                style={styles.input}
                type="date"
                value={visitDate}
                min={today}           // Can't pick a past date
                onChange={e => setVisitDate(e.target.value)}
                required
              />
            </Field>

            <Field label="Purpose of Visit *">
              <select
                style={styles.input}
                value={purpose}
                onChange={e => setPurpose(e.target.value)}
                required
              >
                <option value="">— Select purpose —</option>
                {PURPOSE_OPTIONS.map(p => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </Field>

            {/* Conditionally show text field when "Other" is selected */}
            {purpose === "Other" && (
              <Field label="Please describe *">
                <textarea
                  style={{ ...styles.input, resize: "vertical", minHeight: 80 }}
                  value={purposeOther}
                  onChange={e => setPurposeOther(e.target.value)}
                  placeholder="Briefly describe your reason for visiting..."
                  required
                />
              </Field>
            )}

          </Section>

          {/* ── Section 3: Student Selection ── */}
          <Section title="Student(s) to Visit">

            {/* Selected students chips */}
            {selectedStudents.length > 0 && (
              <div style={styles.chipContainer}>
                {selectedStudents.map(s => (
                  <div key={s.id} style={styles.chip}>
                    <span>🎓 {s.name} · {s.class}</span>
                    <button
                      type="button"
                      style={styles.chipRemove}
                      onClick={() => removeStudent(s.id)}
                      aria-label={`Remove ${s.name}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Lockout banner */}
            {lockedOut && (
              <div style={styles.lockoutBox}>
                Registration locked due to too many failed verification attempts.
                Please visit the school office for assistance.
              </div>
            )}

            {/* Student ID verification prompt */}
            {pendingStudent && !lockedOut && (
              <div style={styles.verifyBox}>
                <p style={styles.verifyTitle}>
                  Verify Student Identity
                </p>
                <p style={styles.verifyInfo}>
                  You selected <strong>{pendingStudent.name}</strong> ({pendingStudent.class}).
                  Please enter their Student ID to confirm.
                </p>
                <input
                  style={styles.input}
                  value={idInput}
                  onChange={e => setIdInput(e.target.value)}
                  placeholder="Enter Student ID..."
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      verifyStudentId();
                    }
                  }}
                />
                {idError && (
                  <p style={styles.verifyError}>{idError}</p>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button type="button" style={styles.btnCancel} onClick={cancelVerification}>
                    Cancel
                  </button>
                  <button type="button" style={styles.btnVerify} onClick={verifyStudentId}>
                    Verify
                  </button>
                </div>
              </div>
            )}

            {/* Search input */}
            <Field label="Search for a student">
              <div style={{ position: "relative" }}>
                <input
                  style={{
                    ...styles.input,
                    ...(lockedOut || pendingStudent ? { opacity: 0.5, pointerEvents: "none" } : {}),
                  }}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Type student name or class..."
                  autoComplete="off"
                  disabled={lockedOut || !!pendingStudent}
                />

                {/* Dropdown results */}
                {(searchResults.length > 0 || searching) && (
                  <div style={styles.dropdown}>
                    {searching ? (
                      <div style={styles.dropdownMsg}>Searching...</div>
                    ) : (
                      searchResults.map(student => (
                        <div
                          key={student.id}
                          style={styles.dropdownItem}
                          onClick={() => selectStudent(student)}
                          onMouseEnter={e => e.currentTarget.style.background = "#eff6ff"}
                          onMouseLeave={e => e.currentTarget.style.background = "#fff"}
                        >
                          <span style={{ fontWeight: 600 }}>{student.name}</span>
                          <span style={{ color: "#6b7280", fontSize: 13 }}>
                            {" "}· {student.class}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* No results message */}
                {searchQuery.trim().length >= 2 &&
                  !searching &&
                  searchResults.length === 0 && (
                  <div style={styles.dropdown}>
                    <div style={styles.dropdownMsg}>
                      No students found. Check the name or contact the school.
                    </div>
                  </div>
                )}
              </div>
            </Field>

            <p style={styles.hint}>
              💡 Search for a student, then verify their Student ID to add them.
              You can add multiple students one at a time.
            </p>

          </Section>

          {/* ── Error message ── */}
          {error && (
            <div style={styles.errorBox}>
              ⚠️ {error}
            </div>
          )}

          {/* ── Submit ── */}
          <button
            type="submit"
            style={{
              ...styles.btnPrimary,
              opacity: (submitting || lockedOut) ? 0.7 : 1,
              cursor: (submitting || lockedOut) ? "not-allowed" : "pointer",
            }}
            disabled={submitting || lockedOut}
          >
            {submitting ? "Submitting..." : "Complete Registration →"}
          </button>

        </form>
      </div>
    </div>
  );
}

// ─── Small helper components ──────────────────────────────────────────────────

// Section wrapper with a title
function Section({ title, children }) {
  return (
    <div style={sectionStyles.wrapper}>
      <h2 style={sectionStyles.title}>{title}</h2>
      <div style={sectionStyles.body}>{children}</div>
    </div>
  );
}

// Label + input wrapper
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={fieldStyles.label}>{label}</label>
      {children}
    </div>
  );
}

// Key-value row on the success screen
function SummaryRow({ label, value }) {
  return (
    <div style={summaryRowStyles.row}>
      <span style={summaryRowStyles.label}>{label}</span>
      <span style={summaryRowStyles.value}>{value}</span>
    </div>
  );
}

// Format "2025-04-05" → "Saturday, 5 April 2025"
function formatDate(dateStr) {
  if (!dateStr) return "";
  // Parse as local date (not UTC) by splitting manually
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric",
    month: "long",   year: "numeric"
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
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

  // Form header
  formHeader:   { textAlign: "center", marginBottom: 32 },
  formTitle:    { fontSize: 24, fontWeight: 700, color: "#0f172a", margin: "8px 0 4px" },
  formSubtitle: { fontSize: 14, color: "#6b7280" },

  // Input
  input: {
    width: "100%", padding: "10px 14px", fontSize: 15,
    border: "1.5px solid #d1d5db", borderRadius: 10,
    background: "#fff", color: "#0f172a",
    transition: "border-color 0.2s",
  },

  // Student chips (selected students)
  chipContainer: {
    display: "flex", flexWrap: "wrap",
    gap: 8, marginBottom: 12,
  },
  chip: {
    display: "flex", alignItems: "center", gap: 8,
    background: "#eff6ff", color: "#1d4ed8",
    border: "1px solid #bfdbfe",
    borderRadius: 999, padding: "5px 12px", fontSize: 13, fontWeight: 500,
  },
  chipRemove: {
    background: "none", border: "none",
    color: "#93c5fd", cursor: "pointer",
    fontSize: 14, padding: 0, lineHeight: 1,
  },

  // Dropdown
  dropdown: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
    background: "#fff", border: "1.5px solid #e5e7eb",
    borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
    zIndex: 100, overflow: "hidden",
  },
  dropdownItem: {
    padding: "11px 14px", cursor: "pointer",
    borderBottom: "1px solid #f3f4f6",
    fontSize: 14, transition: "background 0.1s",
    background: "#fff",
  },
  dropdownMsg: {
    padding: "12px 14px", color: "#9ca3af",
    fontSize: 13, textAlign: "center",
  },

  hint: { fontSize: 13, color: "#9ca3af", marginTop: 8 },

  // Verification prompt
  verifyBox: {
    background: "#fff7ed", border: "1.5px solid #fed7aa",
    borderRadius: 12, padding: "16px 18px", marginBottom: 16,
  },
  verifyTitle: {
    fontSize: 15, fontWeight: 700, color: "#9a3412", marginBottom: 6,
  },
  verifyInfo: {
    fontSize: 13, color: "#78350f", marginBottom: 12, lineHeight: 1.5,
  },
  verifyError: {
    color: "#dc2626", fontSize: 13, marginTop: 8, fontWeight: 500,
  },
  btnCancel: {
    padding: "8px 16px", background: "transparent", border: "1px solid #d1d5db",
    borderRadius: 8, color: "#6b7280", cursor: "pointer", fontSize: 13,
  },
  btnVerify: {
    padding: "8px 16px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
  },

  // Lockout
  lockoutBox: {
    background: "#fef2f2", border: "1.5px solid #fca5a5",
    color: "#991b1b", padding: "14px 16px", borderRadius: 10,
    fontSize: 14, fontWeight: 500, marginBottom: 16, lineHeight: 1.5,
  },

  // Error
  errorBox: {
    background: "#fef2f2", border: "1px solid #fca5a5",
    color: "#dc2626", padding: "10px 14px",
    borderRadius: 8, fontSize: 14, marginBottom: 16,
  },

  // Buttons
  btnPrimary: {
    width: "100%", padding: "14px", fontSize: 16, fontWeight: 700,
    background: "linear-gradient(135deg, #2563eb, #1d4ed8)",
    color: "#fff", border: "none", borderRadius: 12,
    cursor: "pointer", marginTop: 8,
    boxShadow: "0 4px 14px rgba(37,99,235,0.35)",
  },
  btnSecondary: {
    width: "100%", padding: "12px", fontSize: 15, fontWeight: 600,
    background: "#f1f5f9", color: "#475569",
    border: "none", borderRadius: 12, cursor: "pointer", marginTop: 16,
  },

  // Success screen
  successHeader:   { textAlign: "center", marginBottom: 24 },
  successIcon:     { fontSize: 52, marginBottom: 8 },
  successTitle:    { fontSize: 22, fontWeight: 700, color: "#0f172a", marginBottom: 4 },
  successSubtitle: { fontSize: 14, color: "#6b7280" },

  summary: {
    background: "#f8fafc", borderRadius: 12,
    padding: "16px 20px", marginBottom: 20,
  },

  // QR display on success screen
  qrBox: {
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

  // Share buttons
  shareSection: {
    marginBottom: 20,
  },
  shareTitle: {
    fontSize: 14, fontWeight: 700, color: "#374151",
    marginBottom: 12, textAlign: "center",
  },
  btnDownload: {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: 10, width: "100%", padding: "14px",
    fontSize: 16, fontWeight: 700,
    background: "#0f172a", color: "#fff",
    border: "none", borderRadius: 12, cursor: "pointer",
    marginBottom: 10,
    boxShadow: "0 4px 14px rgba(15,23,42,0.25)",
  },
  btnWhatsApp: {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: 10, width: "100%", padding: "14px",
    fontSize: 16, fontWeight: 700,
    background: "#25D366", color: "#fff",
    border: "none", borderRadius: 12, cursor: "pointer",
    textDecoration: "none", marginBottom: 10,
    boxShadow: "0 4px 14px rgba(37,211,102,0.35)",
  },

  instructions: {
    background: "#fffbeb", border: "1px solid #fde68a",
    borderRadius: 10, padding: "14px 18px", marginBottom: 20,
  },
  instructionTitle: { fontWeight: 700, color: "#92400e", marginBottom: 8, fontSize: 14 },
  instructionList:  { paddingLeft: 18, color: "#78350f", fontSize: 13, lineHeight: 1.8 },
};

const sectionStyles = {
  wrapper: {
    marginBottom: 28,
    borderBottom: "1px solid #f1f5f9",
    paddingBottom: 24,
  },
  title: {
    fontSize: 13, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.08em", color: "#94a3b8", marginBottom: 16,
  },
  body: {},
};

const fieldStyles = {
  label: {
    display: "block", fontSize: 14,
    fontWeight: 600, color: "#374151", marginBottom: 6,
  },
};

const summaryRowStyles = {
  row:   { display: "flex", justifyContent: "space-between", 
           padding: "7px 0", borderBottom: "1px solid #e2e8f0", fontSize: 14 },
  label: { color: "#64748b", fontWeight: 500 },
  value: { color: "#0f172a", fontWeight: 600, textAlign: "right", 
           maxWidth: "60%", wordBreak: "break-word" },
};