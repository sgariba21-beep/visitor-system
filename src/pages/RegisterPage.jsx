import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import { QRCodeCanvas } from "qrcode.react";
import SchoolLogo from "../components/SchoolLogo";
import { PURPOSE_OPTIONS, RELATIONSHIP_OPTIONS } from "../constants/visitOptions";

// A stable per-device identifier (not per-tab-session — localStorage, not
// sessionStorage) so create_visit's rate limiter can throttle a spam burst
// of registrations from one device without needing IP tracking or new
// infrastructure. Trivially reset by clearing browser storage — this is a
// lightweight deterrent sized to a single school's actual threat model,
// not a defense against a determined distributed attacker.
function getClientToken() {
  let token = localStorage.getItem("registration_client_token");
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem("registration_client_token", token);
  }
  return token;
}

export default function RegisterPage() {

  // ── Form field state ────────────────────────────────────────────────────────
  const [visitorName, setVisitorName]   = useState("");
  const [visitorPhone, setVisitorPhone] = useState("");
  const [relationship, setRelationship] = useState("");
  const [visitDate, setVisitDate]       = useState("");
  const [purpose, setPurpose]           = useState("");
  const [purposeOther, setPurposeOther] = useState(""); // shown only when purpose = "Other"

  // ── Student search state ────────────────────────────────────────────────────
  const [selectedStudents, setSelectedStudents] = useState([]); // array of student objects
  const qrWrapperRef                          = useRef(null);   // for QR canvas image export

  // ── Student ID search state ─────────────────────────────────────────────────
  // Students are looked up directly by Student ID (never by name) — knowing
  // the ID is itself the proof the visitor is entitled to add that student,
  // so there's no separate confirmation step. The actual comparison and
  // attempt counting happen server-side (see search_student_by_id) — this
  // component never sees or searches by the real student_id. sessionId is
  // stable across a page refresh (sessionStorage) so a lockout can't be
  // trivially reset by reloading the page.
  const [idInput, setIdInput]               = useState("");    // what the visitor typed
  const [idError, setIdError]               = useState("");    // per-attempt error message
  const [verifying, setVerifying]           = useState(false); // search in flight
  const [lockedUntil, setLockedUntil]       = useState(null);  // Date or null
  const [lockRemaining, setLockRemaining]   = useState(0);     // seconds left
  const lockedOut = !!lockedUntil;
  const verificationSessionId = useRef(null);
  if (!verificationSessionId.current) {
    let sid = sessionStorage.getItem("id_verify_session");
    if (!sid) {
      sid = crypto.randomUUID();
      sessionStorage.setItem("id_verify_session", sid);
    }
    verificationSessionId.current = sid;
  }

  // Live countdown while ID search is locked out. Cooldown length is set
  // server-side and escalates within this browser session (1 min, 3 min,
  // 5 min, ... — see search_student_by_id), so it isn't hardcoded here.
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

  // ── Page state ──────────────────────────────────────────────────────────────
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState("");
  const [successData, setSuccessData] = useState(null); // holds visit doc after submission

  // ── "Manage my registration" (lost QR / cancel) ─────────────────────────────
  // Self-service lookup by phone + date — the only fallback previously
  // advertised was "staff can look you up at the gate," which requires
  // already being there. find_my_visit/cancel_visit both require knowing
  // the exact phone number already on file, so this isn't a broad lookup.
  const [showManage, setShowManage]     = useState(false);
  const [managePhone, setManagePhone]   = useState("");
  const [manageDate, setManageDate]     = useState("");
  const [manageResults, setManageResults] = useState(null); // null = not searched yet
  const [manageSearching, setManageSearching] = useState(false);
  const [manageError, setManageError]   = useState("");
  const [cancellingId, setCancellingId] = useState(null);
  const [manageQrFor, setManageQrFor]   = useState(null); // visit id currently showing its QR

  // Stable per-attempt key so a retried submission (e.g. the first request
  // actually landed but the response was lost on a slow connection) returns
  // the same visit instead of creating a duplicate — see create_visit's
  // p_idempotency_key. Only regenerated when starting a genuinely new
  // registration (registerAnother), never on a retry of the same attempt.
  const idempotencyKey = useRef(null);
  if (!idempotencyKey.current) {
    idempotencyKey.current = crypto.randomUUID();
  }

  // ── Date boundaries ─────────────────────────────────────────────────────────
  // Parents can only pick today or a future date
  const today = new Date().toISOString().split("T")[0]; // "2025-04-05"

  // ── Find a student by ID and add them ───────────────────────────────────────
  // The comparison and attempt count live entirely server-side (see
  // search_student_by_id) — this page never learns or searches by the real
  // student_id, and a match is only ever exact (never a fuzzy/partial one),
  // so there's no way to narrow down a guess result-by-result.
  async function findStudentById(e) {
    e?.preventDefault();
    if (lockedOut || verifying) return;

    const guess = idInput.trim();
    if (!guess) return;

    setVerifying(true);
    setIdError("");

    try {
      const { data, error } = await supabase.rpc("search_student_by_id", {
        p_session_id: verificationSessionId.current,
        p_guess: guess,
      });
      if (error) throw error;

      if (data.ok) {
        const student = data.student;
        setSelectedStudents(prev =>
          prev.some(s => s.id === student.id) ? prev : [...prev, student]
        );
        setIdInput("");
        setIdError("");
      } else if (data.locked) {
        setLockedUntil(new Date(data.locked_until));
        setIdInput("");
        setIdError("");
      } else {
        setIdError(`No student found with that ID. ${data.attempts_remaining} attempt(s) remaining.`);
      }
    } catch (err) {
      console.error("Student ID search failed:", err);
      setIdError("Could not search right now. Check your connection and try again.");
    } finally {
      setVerifying(false);
    }
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
        p_idempotency_key: idempotencyKey.current,
        p_client_token: getClientToken(),
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
      if (err?.code === "P0006" || err?.code === "P0008") {
        setError(err.message); // date validity, or rate-limit message
      } else {
        setError("Registration failed. Please check your connection and try again.");
      }
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
    setSuccessData(null);
    setError("");
    // Note: lockedUntil is intentionally left as-is — it reflects the
    // server-tracked verification session, which "register another"
    // doesn't reset (the same real lockout still applies).
    setIdInput("");
    setIdError("");
    // A fresh registration needs a fresh idempotency key — reusing the
    // previous one would make create_visit think this is a retry of the
    // last (already-completed) registration and just hand that back.
    idempotencyKey.current = crypto.randomUUID();
  }

  // ── Manage my registration ──────────────────────────────────────────────────
  async function handleManageSearch(e) {
    e.preventDefault();
    if (!managePhone.trim() || !manageDate) return;

    setManageSearching(true);
    setManageError("");
    setManageResults(null);
    setManageQrFor(null);

    try {
      const { data, error: rpcError } = await supabase.rpc("find_my_visit", {
        p_visitor_phone: managePhone.trim(),
        p_visit_date: manageDate,
      });
      if (rpcError) throw rpcError;

      if (!data || data.length === 0) {
        setManageError("No registration found for that phone number and date.");
      } else {
        setManageResults(data);
      }
    } catch (err) {
      console.error("Lookup failed:", err);
      setManageError("Could not look up your registration. Check your connection and try again.");
    } finally {
      setManageSearching(false);
    }
  }

  async function handleCancelVisit(visit) {
    if (!window.confirm(
      `Cancel your registration for ${formatDate(visit.visit_date)}? This can't be undone.`
    )) return;

    setCancellingId(visit.id);
    try {
      const { data, error: rpcError } = await supabase.rpc("cancel_visit", {
        p_visit_id: visit.id,
        p_visitor_phone: managePhone.trim(),
      });
      if (rpcError) throw rpcError;
      // cancel_visit returns the plain visits row (no joined visit_students,
      // unlike find_my_visit) — merge so the student names stay displayed.
      setManageResults(prev => prev.map(v => v.id === visit.id ? { ...v, ...data } : v));
    } catch (err) {
      console.error("Cancel failed:", err);
      setManageError("Could not cancel your registration. Please try again or contact the school.");
    } finally {
      setCancellingId(null);
    }
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
          <SchoolLogo height={44} style={{ margin: "0 auto 8px" }} />
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
                Too many attempts. Try again in{" "}
                {Math.floor(lockRemaining / 60)}:{String(lockRemaining % 60).padStart(2, "0")}.
              </div>
            )}

            {/* Student ID lookup */}
            {!lockedOut && (
              <Field label="Student ID *">
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    style={styles.input}
                    value={idInput}
                    onChange={e => setIdInput(e.target.value)}
                    placeholder="Enter Student ID..."
                    autoComplete="off"
                    disabled={verifying}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        findStudentById();
                      }
                    }}
                  />
                  <button
                    type="button"
                    style={{ ...styles.btnVerify, opacity: (verifying || !idInput.trim()) ? 0.6 : 1 }}
                    onClick={findStudentById}
                    disabled={verifying || !idInput.trim()}
                  >
                    {verifying ? "Searching..." : "Add"}
                  </button>
                </div>
                {idError && (
                  <p style={styles.verifyError}>{idError}</p>
                )}
              </Field>
            )}

            <p style={styles.hint}>
              💡 Enter the Student ID given to you by the school to add a student.
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

        {/* ── Manage an existing registration (lost QR / cancel) ── */}
        <div style={styles.manageSection}>
          <button
            type="button"
            style={styles.manageToggle}
            onClick={() => setShowManage(prev => !prev)}
          >
            {showManage ? "▲ Hide" : "▼"} Already registered? Find your QR code or cancel a visit
          </button>

          {showManage && (
            <div style={styles.managePanel}>
              <form onSubmit={handleManageSearch} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  style={{ ...styles.input, flex: 1, minWidth: 160 }}
                  type="tel"
                  value={managePhone}
                  onChange={e => setManagePhone(e.target.value)}
                  placeholder="Phone number used to register"
                  required
                />
                <input
                  style={{ ...styles.input, flex: 1, minWidth: 140 }}
                  type="date"
                  value={manageDate}
                  onChange={e => setManageDate(e.target.value)}
                  required
                />
                <button
                  type="submit"
                  style={{ ...styles.btnPrimary, marginTop: 0, width: "auto", padding: "10px 20px" }}
                  disabled={manageSearching}
                >
                  {manageSearching ? "Searching..." : "Find"}
                </button>
              </form>

              {manageError && <p style={styles.manageError}>{manageError}</p>}

              {manageResults?.map(visit => (
                <div key={visit.id} style={styles.manageResult}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <p style={styles.manageResultTitle}>
                        {visit.visit_students?.map(s => s.student_name).join(", ") || "—"}
                      </p>
                      <p style={styles.manageResultSub}>
                        {formatDate(visit.visit_date)} · {
                          visit.cancelled_at ? "Cancelled"
                          : visit.status === "registered" ? "Not yet arrived"
                          : visit.status === "checked_in" ? "On campus"
                          : "Departed"
                        }
                      </p>
                    </div>
                  </div>

                  {!visit.cancelled_at && visit.status === "registered" && (
                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        style={styles.manageActionBtn}
                        onClick={() => setManageQrFor(prev => prev === visit.id ? null : visit.id)}
                      >
                        {manageQrFor === visit.id ? "Hide QR" : "Show QR"}
                      </button>
                      <button
                        type="button"
                        style={{ ...styles.manageActionBtn, color: "#dc2626", borderColor: "#fca5a5" }}
                        onClick={() => handleCancelVisit(visit)}
                        disabled={cancellingId === visit.id}
                      >
                        {cancellingId === visit.id ? "Cancelling..." : "Cancel this visit"}
                      </button>
                    </div>
                  )}

                  {manageQrFor === visit.id && (
                    <div style={{ ...styles.qrBox, marginTop: 12, padding: 16 }}>
                      <QRCodeCanvas value={visit.qr_token} size={160} level="H" includeMargin />
                      <p style={styles.qrToken}>{visit.qr_token}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
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

  hint: { fontSize: 13, color: "#9ca3af", marginTop: 8 },

  verifyError: {
    color: "#dc2626", fontSize: 13, marginTop: 8, fontWeight: 500,
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

  // "Manage my registration" (lost QR / cancel)
  manageSection: { marginTop: 20, borderTop: "1px solid #f1f5f9", paddingTop: 16 },
  manageToggle: {
    width: "100%", textAlign: "left", background: "none", border: "none",
    color: "#2563eb", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: 0,
  },
  managePanel: { marginTop: 14 },
  manageError: {
    background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626",
    padding: "10px 14px", borderRadius: 8, fontSize: 13, marginTop: 10,
  },
  manageResult: {
    background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10,
    padding: "12px 14px", marginTop: 10,
  },
  manageResultTitle: { fontSize: 14, fontWeight: 700, color: "#0f172a" },
  manageResultSub: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  manageActionBtn: {
    padding: "6px 12px", background: "#fff", color: "#374151",
    border: "1.5px solid #d1d5db", borderRadius: 8, cursor: "pointer",
    fontSize: 12, fontWeight: 600,
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