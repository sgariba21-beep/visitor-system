import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import { generateVisitToken } from "../utils/generateToken";
import {
  withOfflineTimeout, warmCache, getCachedStudents, getCachedVisits,
  updateCachedVisit, lookupVisitByToken, enqueue, flushOutbox,
  getCachedPin, refreshGatePin,
} from "../lib/offlineSync";
import { Html5Qrcode } from "html5-qrcode";
import SchoolLogo from "../components/SchoolLogo";

// ─── Constants ────────────────────────────────────────────────────────────────
const SCANNER_DIV_ID = "qr-reader"; // html5-qrcode needs a div with a known ID

export default function GatePage() {

  // ── Screen state ────────────────────────────────────────────────────────────
  // Controls which UI panel is shown
  const [screen, setScreen] = useState("pin"); // "pin"|"scanner"|"result"|"manual"

  // ── PIN state ───────────────────────────────────────────────────────────────
  const [pinInput, setPinInput]   = useState("");
  const [pinError, setPinError]   = useState("");
  // The PIN is admin-editable (gate_settings table), not a build-time
  // constant. "1234" is just a sane bootstrap default before the cached or
  // freshly-fetched value comes back — matches the table's own default.
  const [correctPin, setCorrectPin] = useState("1234");

  // ── Scanner state ───────────────────────────────────────────────────────────
  const [scannerError, setScannerError] = useState("");
  const scannerRef = useRef(null); // holds the Html5Qrcode instance

  // ── Result state ────────────────────────────────────────────────────────────
  const [visitDoc, setVisitDoc]     = useState(null);  // full visit row (+ visit_students)
  const [visitDocId, setVisitDocId] = useState(null);  // visit's id (uuid)
  const [actionLoading, setActionLoading] = useState(false);
  const [actionFeedback, setActionFeedback] = useState(null); // {type, message}

  // ── Manual lookup state ─────────────────────────────────────────────────────
  const [manualQuery, setManualQuery]       = useState("");
  const [manualResults, setManualResults]   = useState([]);
  const [manualSearching, setManualSearching] = useState(false);
  const [manualError, setManualError]       = useState("");
  const [manualMode, setManualMode]         = useState("search"); // "search" | "walkin"

  // Walk-in form state
  const [walkIn, setWalkIn] = useState({
    visitorName: "", visitorPhone: "", relationship: "",
    purpose: "", purposeOther: "",
  });
  const [walkInStudentQuery, setWalkInStudentQuery]     = useState("");
  const [walkInStudentResults, setWalkInStudentResults] = useState([]);
  const [walkInSelectedStudents, setWalkInSelectedStudents] = useState([]);
  const [walkInSearching, setWalkInSearching]           = useState(false);
  const [walkInSubmitting, setWalkInSubmitting]         = useState(false);
  const walkInSearchTimeout                             = useRef(null);

  // Online/Offline State
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState(null);

  // Cache State
  const [cacheStatus, setCacheStatus] = useState("idle"); // "idle"|"warming"|"ready"|"failed"

  // ── Today's date string ─────────────────────────────────────────────────────
  // Used to validate QR codes — must match visit's visit_date
  const todayStr = new Date().toISOString().split("T")[0]; // "2025-04-05"

  // ────────────────────────────────────────────────────────────────────────────
  // PIN LOGIC
  // ────────────────────────────────────────────────────────────────────────────

  function handlePinSubmit(e) {
    e.preventDefault();
    if (pinInput === correctPin) {
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

  // Load the current gate PIN: an immediate read from the local cache (so
  // it's available instantly, even offline), backed by a fresh fetch (so a
  // PIN an admin just changed takes effect as soon as the device is online).
  useEffect(() => {
    let cancelled = false;
    getCachedPin().then((cached) => {
      if (cached && !cancelled) setCorrectPin(cached);
    });
    refreshGatePin().then((fresh) => {
      if (fresh && !cancelled) setCorrectPin(fresh);
    });
    return () => { cancelled = true; };
  }, []);

  // ── PWA install prompt ───────────────────────────────────────────────────
  // The browser fires this event when the app is installable.
  // We save the event so we can trigger it ourselves with a button.
  useEffect(() => {
    const handler = (e) => {
      e.preventDefault(); // prevent the browser's default mini-infobar
      setInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function handleInstall() {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") setInstallPrompt(null);
  }

  // ── Online/offline detection + outbox flush triggers ────────────────────
  useEffect(() => {
    const goOnline  = () => { setIsOnline(true); flushOutbox(); };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online",  goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online",  goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Periodically retry the outbox while the gate screen is active — covers
  // connections that report "online" but are actually too flaky for the
  // live request to land.
  useEffect(() => {
    if (screen === "pin") return;
    flushOutbox();
    const interval = setInterval(() => flushOutbox(), 15000);
    return () => clearInterval(interval);
  }, [screen]);

  // ── Cache warming ────────────────────────────────────────────────────────
  // Replaces Firestore's automatic offline cache: explicitly fetches today's
  // visits and active students into the local Dexie mirror.
  useEffect(() => {
    if (screen === "pin") return;

    setCacheStatus("warming");

    const timer = setTimeout(async () => {
      const { visitsOk, studentsOk } = await warmCache(todayStr);
      if (visitsOk) console.log("Cache warmed: today's visits loaded.");
      else console.log("Visits cache warm skipped (likely offline).");
      if (studentsOk) console.log("Cache warmed: students loaded.");
      else console.log("Students cache warm skipped (likely offline).");
      setCacheStatus(visitsOk && studentsOk ? "ready" : "failed");
    }, 1500);

    return () => clearTimeout(timer);
  }, [screen, todayStr]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Look up the visit (Supabase, falling back to the Dexie cache offline)
    await lookupVisit(decodedText);
  }

  // Called on every failed scan frame — we just ignore these
  function onScanFailure() {}

  // ────────────────────────────────────────────────────────────────────────────
  // VISIT LOOKUP (shared by scanner and manual search)
  // ────────────────────────────────────────────────────────────────────────────

  async function lookupVisit(token) {
    try {
      const data = await lookupVisitByToken(token.trim().toUpperCase());

      if (!data) {
        // Token not found, live or cached
        showScanError("QR code not recognised. Ask the visitor to show their registration confirmation.");
        return;
      }

      // ── DATE VALIDATION ────────────────────────────────────────────────────
      // This is the core security check.
      // A QR registered for April 12th must NOT work on April 5th.
      if (data.visit_date !== todayStr) {
        const formatted = formatDate(data.visit_date);
        showScanError(
          `This QR code is for ${formatted}, not today. ` +
          `Use manual lookup if the visitor needs assistance.`
        );
        return;
      }

      // All checks passed — show the visit details
      setVisitDoc(data);
      setVisitDocId(data.id);
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
      if (visitDoc.status === "registered") {
        await runTransition("checked_in", "check_in", "✅ Checked in successfully. Welcome!");
      } else if (visitDoc.status === "checked_in") {
        await runTransition("checked_out", "check_out", "👋 Checked out successfully. Safe travels!");
      } else {
        // ── ALREADY CHECKED OUT ───────────────────────────────────────────────
        setActionFeedback({ type: "info", message: "This visit is already complete." });
      }
    } catch (err) {
      console.error("Action failed:", err);
      setActionFeedback({ type: "error", message: "Action failed. Check your connection." });
    } finally {
      setActionLoading(false);
    }
  }

  // Shared by check-in and check-out: optimistic update, race a short
  // timeout against the live RPC, and durably enqueue on failure so the
  // write survives a dropped connection instead of silently vanishing.
  async function runTransition(nextStatus, outboxType, successMessage) {
    const nowIso = new Date().toISOString();
    const timestampField = nextStatus === "checked_in" ? "checked_in_at" : "checked_out_at";

    // Optimistic update first — UI responds immediately even offline
    setVisitDoc(prev => ({ ...prev, status: nextStatus, [timestampField]: nowIso }));
    setActionFeedback({ type: "success", message: successMessage });
    await updateCachedVisit(visitDocId, { status: nextStatus, [timestampField]: nowIso });

    const rpcName = outboxType === "check_in" ? "check_in_visit" : "check_out_visit";
    const result = await withOfflineTimeout(supabase.rpc(rpcName, { p_qr_token: visitDoc.qr_token }));

    if (!result.ok && result.error?.code !== "P0001") {
      await enqueue(outboxType, { qrToken: visitDoc.qr_token });
      setActionFeedback({ type: "success", message: `${successMessage} (queued — will sync when online)` });
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
  // MANUAL LOOKUP FUNCTIONS
  // ────────────────────────────────────────────────────────────────────────────

  // Search visits by visitor name or phone for today's date
  async function handleManualSearch(e) {
    e.preventDefault();
    if (!manualQuery.trim()) return;

    setManualSearching(true);
    setManualError("");
    setManualResults([]);

    try {
      // Postgres/PostgREST doesn't make an OR-across-fields query any nicer
      // than Firestore did, so we still fetch today's visits and filter
      // client-side, falling back to the Dexie cache when offline.
      const remote = await withOfflineTimeout(
        supabase.from("visits").select("*, visit_students(*)").eq("visit_date", todayStr),
        2000
      );
      const all = remote.ok ? remote.data : await getCachedVisits();

      const lower = manualQuery.trim().toLowerCase();
      const results = all.filter(v =>
        v.visitor_name?.toLowerCase().includes(lower)  ||
        v.visitor_phone?.includes(manualQuery.trim())  ||
        v.visit_students?.some(s =>
          s.student_name?.toLowerCase().includes(lower)
        )
      );

      if (results.length === 0) {
        setManualError(
          "No visits found for today matching that name, phone, or student. " +
          "Use 'Walk-in Registration' below to create a new visit."
        );
      } else {
        setManualResults(results);
      }

    } catch (err) {
      console.error("Manual search failed:", err);
      setManualError("Search failed. Check your connection.");
    } finally {
      setManualSearching(false);
    }
  }

  // When staff taps a result, load it into the result screen
  function selectManualResult(visit) {
    setVisitDoc(visit);
    setVisitDocId(visit.id);
    setActionFeedback(null);
    setManualResults([]);
    setManualQuery("");
    setManualError("");
    setScreen("result");
  }

  // Reset manual panel when navigating away
  function resetManual() {
    setManualQuery("");
    setManualResults([]);
    setManualError("");
    setManualMode("search");
    setWalkIn({ visitorName: "", visitorPhone: "", relationship: "",
                purpose: "", purposeOther: "" });
    setWalkInSelectedStudents([]);
    setWalkInStudentQuery("");
    setWalkInStudentResults([]);
  }

  // ── Walk-in student search (debounced) ───────────────────────────────────────
  useEffect(() => {
    if (walkInStudentQuery.trim().length < 2) {
      setWalkInStudentResults([]);
      return;
    }
    if (walkInSearchTimeout.current) clearTimeout(walkInSearchTimeout.current);
    walkInSearchTimeout.current = setTimeout(() => {
      searchWalkInStudents(walkInStudentQuery.trim());
    }, 400);
    return () => clearTimeout(walkInSearchTimeout.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkInStudentQuery]);

  async function searchWalkInStudents(queryText) {
    setWalkInSearching(true);
    try {
      const remote = await withOfflineTimeout(
        supabase.from("students").select("*").eq("is_active", true).order("name"),
        2000
      );
      const all = remote.ok ? remote.data : await getCachedStudents();
      const lower = queryText.toLowerCase();
      const selectedIds = walkInSelectedStudents.map(s => s.id);
      setWalkInStudentResults(
        all
          .filter(s =>
            (s.name.toLowerCase().includes(lower) ||
            s.class.toLowerCase().includes(lower)) &&
            !selectedIds.includes(s.id)
          )
      );
    } catch (err) {
      console.error("Student search error:", err);
    } finally {
      setWalkInSearching(false);
    }
  }

  // ── Walk-in form submission ───────────────────────────────────────────────────
  async function handleWalkInSubmit(e) {
    e.preventDefault();

    if (walkInSelectedStudents.length === 0) {
      setManualError("Please select at least one student.");
      return;
    }
    if (walkIn.purpose === "Other" && !walkIn.purposeOther.trim()) {
      setManualError("Please describe the purpose of the visit.");
      return;
    }

    setWalkInSubmitting(true);
    setManualError("");

    try {
      const rpcArgs = {
        p_visitor_name:  walkIn.visitorName.trim(),
        p_visitor_phone: walkIn.visitorPhone.trim(),
        p_relationship:  walkIn.relationship || "Not specified",
        p_purpose:       walkIn.purpose,
        p_purpose_other: walkIn.purpose === "Other" ? walkIn.purposeOther.trim() : "",
        p_visit_date:    todayStr,
        p_status:        "checked_in", // walk-ins are checked in immediately
        p_created_by:    "gate_staff",
        p_students: walkInSelectedStudents.map(s => ({
          student_id:   s.id,
          student_name: s.name,
          class:        s.class,
        })),
      };

      const result = await withOfflineTimeout(supabase.rpc("create_visit", rpcArgs));

      let visitData;
      if (result.ok) {
        visitData = { ...result.data, visit_students: rpcArgs.p_students.map(s => ({
          student_name: s.student_name, class: s.class,
        })) };
      } else {
        // Offline (or the request failed/timed out): show a placeholder
        // immediately and let the outbox create the real row once back online.
        const now = new Date().toISOString();
        visitData = {
          id: `local-${Date.now()}`,
          visitor_name:   rpcArgs.p_visitor_name,
          visitor_phone:  rpcArgs.p_visitor_phone,
          relationship:   rpcArgs.p_relationship,
          purpose:        rpcArgs.p_purpose,
          purpose_other:  rpcArgs.p_purpose_other,
          visit_date:     rpcArgs.p_visit_date,
          status:         "checked_in",
          qr_token:       generateVisitToken(), // placeholder — server assigns the real one
          registered_at:  now,
          checked_in_at:  now,
          checked_out_at: null,
          created_by:     "gate_staff",
          visit_students: rpcArgs.p_students.map(s => ({
            student_name: s.student_name, class: s.class,
          })),
        };
        await enqueue("walk_in", { rpcArgs });
      }

      // Hand off directly to the result screen
      setVisitDoc(visitData);
      setVisitDocId(visitData.id);
      setActionFeedback({
        type: "success",
        message: result.ok
          ? "✅ Walk-in registered and checked in."
          : "✅ Walk-in checked in (queued — will sync when online).",
      });
      resetManual();
      setScreen("result");

    } catch (err) {
      console.error("Walk-in submission failed:", err);
      setManualError("Registration failed. Check your connection.");
    } finally {
      setWalkInSubmitting(false);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div style={styles.page}>
      {/* ── Offline banner ── */}
      {!isOnline && (
        <div style={styles.offlineBanner}>
          ⚠️ You are offline. Recent visit data is available from cache.
          Check-ins will sync automatically when connection returns.
        </div>
      )}

      {/* ── Cache status banner ── */}
      {isOnline && cacheStatus === "warming" && (
        <div style={{ ...styles.offlineBanner, background: "#1e3a5f", color: "#93c5fd" }}>
          ⏳ Loading offline cache — please stay connected for a moment...
        </div>
      )}
      {isOnline && cacheStatus === "ready" && (
        <div style={{ ...styles.offlineBanner, background: "#14532d", color: "#86efac" }}>
          ✅ Offline cache ready — safe to disconnect from WiFi
        </div>
      )}
      {cacheStatus === "failed" && (
        <div style={{ ...styles.offlineBanner, background: "#78350f", color: "#fef3c7" }}>
          ⚠️ Cache not loaded — stay connected or reconnect WiFi before going offline
        </div>
      )}

      {/* ── Top bar ── */}
      <div style={styles.topBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SchoolLogo crestOnly height={28} />
          <span style={styles.topBarTitle}>Gate</span>
        </div>
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

        {installPrompt && (
          <button style={styles.installBtn} onClick={handleInstall}>
            📲 Install
          </button>
        )}
      </div>

      {/* ════════════════════════════════════════════════════
          SCREEN: PIN entry
      ════════════════════════════════════════════════════ */}
      {screen === "pin" && (
        <div style={styles.centeredContent}>
          <div style={styles.pinCard}>
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
              <SchoolLogo crestOnly height={56} />
            </div>
            <h2 style={styles.pinTitle}>Gate Access</h2>
            <p style={styles.pinSubtitle}>Our Lady of Grace SHS — enter your PIN to continue</p>
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
            <h2 style={styles.visitorName}>{visitDoc.visitor_name}</h2>
            <p style={styles.visitorPhone}>📞 {visitDoc.visitor_phone}</p>
            <p style={styles.visitorRelationship}>
              {visitDoc.relationship || "Visitor"}
            </p>

            <hr style={styles.divider} />

            {/* Students being visited */}
            <p style={styles.sectionLabel}>VISITING</p>
            <div style={styles.studentList}>
              {visitDoc.visit_students?.map((s, i) => (
                <div key={i} style={styles.studentChip}>
                  🎓 {s.student_name}
                  <span style={styles.studentClass}>{s.class}</span>
                </div>
              ))}
            </div>

            {/* Purpose */}
            <p style={styles.sectionLabel} >PURPOSE</p>
            <p style={styles.purposeText}>
              {visitDoc.purpose === "Other"
                ? visitDoc.purpose_other
                : visitDoc.purpose}
            </p>

            <hr style={styles.divider} />

            {/* Timestamps */}
            <div style={styles.timestamps}>
              <TimestampRow
                label="Registered"
                value={visitDoc.registered_at}
              />
              {visitDoc.checked_in_at && (
                <TimestampRow label="Checked In"  value={visitDoc.checked_in_at} />
              )}
              {visitDoc.checked_out_at && (
                <TimestampRow label="Checked Out" value={visitDoc.checked_out_at} />
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
          SCREEN: Manual lookup + walk-in registration
      ════════════════════════════════════════════════════ */}
      {screen === "manual" && (
        <div style={styles.centeredContent}>
          <div style={styles.resultCard}>

            {/* Tab switcher */}
            <div style={styles.tabRow}>
              <button
                style={{
                  ...styles.tab,
                  borderBottom: manualMode === "search"
                    ? "2px solid #2563eb" : "2px solid transparent",
                  color: manualMode === "search" ? "#f8fafc" : "#64748b",
                }}
                onClick={() => { setManualMode("search"); setManualError(""); }}
              >
                🔍 Find Visitor
              </button>
              <button
                style={{
                  ...styles.tab,
                  borderBottom: manualMode === "walkin"
                    ? "2px solid #2563eb" : "2px solid transparent",
                  color: manualMode === "walkin" ? "#f8fafc" : "#64748b",
                }}
                onClick={() => { setManualMode("walkin"); setManualError(""); }}
              >
                ➕ Walk-in
              </button>
            </div>

            {/* ── Tab: Find existing visitor ── */}
            {manualMode === "search" && (
              <div>
                <p style={styles.manualHint}>
                  Search today's registrations by visitor name, phone number,
                  or student name.
                </p>

                <form onSubmit={handleManualSearch} style={{ marginBottom: 16 }}>
                <input
                  style={{
                    ...styles.darkInput,
                    width: "100%",
                    marginBottom: 8,
                    color: "#f8fafc",
                    caretColor: "#f8fafc",
                  }}
                  value={manualQuery}
                  onChange={e => setManualQuery(e.target.value)}
                  placeholder="Name, phone or student..."
                  autoFocus
                />
                <button
                  type="submit"
                  style={{ ...styles.btnPrimary, width: "100%" }}
                  disabled={manualSearching}
                >
                  {manualSearching ? "Searching..." : "Search"}
                </button>
              </form>

                {/* Error / no results */}
                {manualError && (
                  <div style={styles.manualError}>{manualError}</div>
                )}

                {/* Search results */}
                {manualResults.length > 0 && (
                  <div style={styles.manualResultsList}>
                    {manualResults.map(visit => (
                      <div
                        key={visit.id}
                        style={styles.manualResultItem}
                        onClick={() => selectManualResult(visit)}
                        onMouseEnter={e =>
                          e.currentTarget.style.background = "#0f172a"
                        }
                        onMouseLeave={e =>
                          e.currentTarget.style.background = "#1a2942"
                        }
                      >
                        <div style={{ display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "flex-start" }}>
                          <div>
                            <p style={styles.manualResultName}>
                              {visit.visitor_name}
                            </p>
                            <p style={styles.manualResultSub}>
                              📞 {visit.visitor_phone}
                            </p>
                            <p style={styles.manualResultSub}>
                              🎓 {visit.visit_students?.map(s => s.student_name).join(", ")}
                            </p>
                          </div>
                          <StatusBadge status={visit.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  style={{ ...styles.scanNextBtn, marginTop: 16 }}
                  onClick={() => { resetManual(); setScreen("scanner"); }}
                >
                  ← Back to Scanner
                </button>
              </div>
            )}

            {/* ── Tab: Walk-in registration ── */}
            {manualMode === "walkin" && (
              <form onSubmit={handleWalkInSubmit}>
                <p style={styles.manualHint}>
                  Register and immediately check in a visitor who did not pre-register.
                </p>

                {/* Visitor info */}
                <WalkInField label="Full Name *">
                  <input
                    style={styles.darkInput}
                    value={walkIn.visitorName}
                    onChange={e =>
                      setWalkIn(p => ({ ...p, visitorName: e.target.value }))
                    }
                    placeholder="e.g. Abena Mensah"
                    required
                  />
                </WalkInField>

                <WalkInField label="Phone Number *">
                  <input
                    style={styles.darkInput}
                    type="tel"
                    value={walkIn.visitorPhone}
                    onChange={e =>
                      setWalkIn(p => ({ ...p, visitorPhone: e.target.value }))
                    }
                    placeholder="e.g. 0244123456"
                    required
                  />
                </WalkInField>

                <WalkInField label="Relationship">
                  <select
                    style={styles.darkInput}
                    value={walkIn.relationship}
                    onChange={e =>
                      setWalkIn(p => ({ ...p, relationship: e.target.value }))
                    }
                  >
                    <option value="">— Select —</option>
                    {["Parent / Guardian","Sibling","Relative",
                      "Family Friend","Other"].map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </WalkInField>

                <WalkInField label="Purpose *">
                  <select
                    style={styles.darkInput}
                    value={walkIn.purpose}
                    onChange={e =>
                      setWalkIn(p => ({ ...p, purpose: e.target.value }))
                    }
                    required
                  >
                    <option value="">— Select —</option>
                    {["General Visit","Academic Concerns","Medical","General Visit",
                      "Financial","Pickup / Leave","Other"].map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </WalkInField>

                {walkIn.purpose === "Other" && (
                  <WalkInField label="Please describe *">
                    <textarea
                      style={{ ...styles.darkInput, minHeight: 70, resize: "vertical" }}
                      value={walkIn.purposeOther}
                      onChange={e =>
                        setWalkIn(p => ({ ...p, purposeOther: e.target.value }))
                      }
                      placeholder="Brief description..."
                    />
                  </WalkInField>
                )}

                {/* Student selection */}
                <WalkInField label="Student(s) to Visit *">

                  {/* Selected student chips */}
                  {walkInSelectedStudents.length > 0 && (
                    <div style={styles.chipContainer}>
                      {walkInSelectedStudents.map(s => (
                        <div key={s.id} style={styles.darkChip}>
                          🎓 {s.name} · {s.class}
                          <button
                            type="button"
                            style={styles.chipRemove}
                            onClick={() =>
                              setWalkInSelectedStudents(prev =>
                                prev.filter(x => x.id !== s.id)
                              )
                            }
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Student search */}
                  <div style={{ position: "relative" }}>
                    <input
                      style={styles.darkInput}
                      value={walkInStudentQuery}
                      onChange={e => setWalkInStudentQuery(e.target.value)}
                      placeholder="Search student name or class..."
                      autoComplete="off"
                    />

                    {/* Dropdown */}
                    {(walkInStudentResults.length > 0 || walkInSearching) && (
                      <div style={styles.darkDropdown}>
                        {walkInSearching ? (
                          <div style={styles.dropdownMsg}>Searching...</div>
                        ) : (
                          walkInStudentResults.map(s => (
                            <div
                              key={s.id}
                              style={styles.dropdownItem}
                              onClick={() => {
                                setWalkInSelectedStudents(prev => [...prev, s]);
                                setWalkInStudentQuery("");
                                setWalkInStudentResults([]);
                              }}
                              onMouseEnter={e =>
                                e.currentTarget.style.background = "#0f172a"
                              }
                              onMouseLeave={e =>
                                e.currentTarget.style.background = "#1e293b"
                              }
                            >
                              <span style={{ fontWeight: 600 }}>{s.name}</span>
                              <span style={{ color: "#64748b", fontSize: 13 }}>
                                {" "}· {s.class}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {walkInStudentQuery.trim().length >= 2 &&
                      !walkInSearching &&
                      walkInStudentResults.length === 0 && (
                      <div style={styles.darkDropdown}>
                        <div style={styles.dropdownMsg}>No students found.</div>
                      </div>
                    )}
                  </div>
                </WalkInField>

                {/* Error */}
                {manualError && (
                  <div style={styles.manualError}>{manualError}</div>
                )}

                {/* Submit */}
                <button
                  type="submit"
                  style={{
                    ...styles.actionBtn,
                    background: "linear-gradient(135deg, #16a34a, #15803d)",
                    marginTop: 8,
                  }}
                  disabled={walkInSubmitting}
                >
                  {walkInSubmitting
                    ? "Registering..."
                    : "✅ Register & Check In"}
                </button>

                <button
                  type="button"
                  style={{ ...styles.scanNextBtn, marginTop: 10 }}
                  onClick={() => { resetManual(); setScreen("scanner"); }}
                >
                  ← Back to Scanner
                </button>

              </form>
            )}

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

// Renders an ISO timestamp string or null gracefully
function TimestampRow({ label, value }) {
  const formatted = value
    ? new Date(value).toLocaleTimeString("en-GB", {
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

// Label wrapper for walk-in form fields
function WalkInField({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: "block", fontSize: 12, fontWeight: 700,
        color: "#64748b", textTransform: "uppercase",
        letterSpacing: "0.06em", marginBottom: 6,
      }}>
        {label}
      </label>
      {children}
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
  installBtn: {
    padding: "6px 12px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 8, cursor: "pointer",
    fontSize: 12, fontWeight: 600,
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

  // Manual lookup styles
  tabRow: {
    display: "flex", borderBottom: "1px solid #334155", marginBottom: 20,
  },
  tab: {
    flex: 1, padding: "10px", background: "transparent", border: "none",
    cursor: "pointer", fontSize: 14, fontWeight: 600,
    paddingBottom: 12, transition: "color 0.15s",
  },
  manualHint: {
    fontSize: 13, color: "#64748b", marginBottom: 16, lineHeight: 1.6,
  },
  manualError: {
    background: "#450a0a", border: "1px solid #991b1b",
    color: "#fca5a5", borderRadius: 8, padding: "10px 14px",
    fontSize: 13, marginBottom: 12, lineHeight: 1.5,
  },
  manualResultsList: {
    display: "flex", flexDirection: "column", gap: 8,
  },
  manualResultItem: {
    background: "#1a2942", borderRadius: 10, padding: "12px 14px",
    cursor: "pointer", transition: "background 0.15s",
    border: "1px solid #334155",
  },
  manualResultName: {
    fontWeight: 700, fontSize: 15, marginBottom: 3,
  },
  manualResultSub: {
    fontSize: 12, color: "#64748b", marginBottom: 2,
  },

  // Dark-themed form controls for gate page
  darkInput: {
    width: "100%", padding: "10px 12px", fontSize: 14,
    background: "#0f172a", border: "1.5px solid #334155",
    borderRadius: 8, color: "#f8fafc", caretColor: "#f8fafc",
    WebkitTextFillColor: "#f8fafc",
  },
  darkDropdown: {
    position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
    background: "#1e293b", border: "1px solid #334155",
    borderRadius: 8, zIndex: 100, overflow: "hidden",
    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  },
  dropdownItem: {
    padding: "10px 14px", cursor: "pointer", fontSize: 14,
    borderBottom: "1px solid #334155", background: "#1e293b",
    transition: "background 0.1s",
  },
  dropdownMsg: {
    padding: "12px 14px", color: "#475569",
    fontSize: 13, textAlign: "center",
  },
  chipContainer: {
    display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10,
  },
  darkChip: {
    display: "flex", alignItems: "center", gap: 8,
    background: "#0f172a", color: "#93c5fd",
    border: "1px solid #1e40af", borderRadius: 999,
    padding: "4px 10px", fontSize: 12, fontWeight: 500,
  },
  chipRemove: {
    background: "none", border: "none", color: "#475569",
    cursor: "pointer", fontSize: 13, padding: 0,
  },

  //Offline Banner
  offlineBanner: {
    background: "#78350f",
    color: "#fef3c7",
    padding: "10px 16px",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 1.5,
  },
};
