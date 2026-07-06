import { useState, useEffect, useCallback } from "react";
import { supabase } from "../../lib/supabaseClient";
import Spinner from "../../components/Spinner";
import { QRCodeCanvas } from "qrcode.react";
import { PURPOSE_OPTIONS as BASE_PURPOSE_OPTIONS } from "../../constants/visitOptions";

const STATUS_OPTIONS = [
  { value: "all",         label: "All Statuses" },
  { value: "registered",  label: "Not Arrived"  },
  { value: "checked_in",  label: "On Campus"    },
  { value: "checked_out", label: "Departed"     },
];

// Filter dropdown adds "All Purposes" on top of the shared, canonical list
// used everywhere a purpose is actually recorded (RegisterPage, GatePage).
const PURPOSE_OPTIONS = ["All Purposes", ...BASE_PURPOSE_OPTIONS];

const PAGE_SIZE = 50;

export default function VisitsPage() {

  // ── Filter state ───────────────────────────────────────────────────────────
  const todayStr = new Date().toISOString().split("T")[0];
  const [dateFrom, setDateFrom]   = useState(todayStr);
  const [dateTo, setDateTo]       = useState(todayStr);
  const [statusFilter, setStatus] = useState("all");
  const [purposeFilter, setPurpose] = useState("All Purposes");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState(""); // debounced value actually sent to the server

  // Debounce free-text search — date/status/purpose changes refetch
  // immediately (infrequent, deliberate actions), but typing shouldn't
  // fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // ── Data state ─────────────────────────────────────────────────────────────
  const [visits, setVisits]     = useState([]);
  const [counts, setCounts]     = useState({ total: 0, onCampus: 0, departed: 0, registered: 0 });
  const [page, setPage]         = useState(0);
  const [loading, setLoading]   = useState(false);
  const [fetched, setFetched]   = useState(false); // has a fetch been run yet?
  const [expanded, setExpanded] = useState(null);  // expanded visit ID

  // ── Fetch a page of visits matching the current filters ───────────────────
  // Filtering, pagination, and the free-text search (an OR across visits'
  // own columns and the joined visit_students' student_name) all happen
  // server-side via admin_search_visits — the whole matching set is never
  // shipped to the browser, only the requested page plus status counts.
  const fetchVisits = useCallback(async (targetPage = 0) => {
    setLoading(true);
    setFetched(false);

    try {
      const { data, error } = await supabase.rpc("admin_search_visits", {
        p_date_from: dateFrom,
        p_date_to:   dateTo,
        p_status:    statusFilter === "all" ? null : statusFilter,
        p_purpose:   purposeFilter === "All Purposes" ? null : purposeFilter,
        p_query:     searchQuery || null,
        p_limit:     PAGE_SIZE,
        p_offset:    targetPage * PAGE_SIZE,
      });

      if (error) throw error;
      setVisits(data.rows);
      setCounts({
        total: data.total, onCampus: data.on_campus,
        departed: data.departed, registered: data.not_arrived,
      });
      setPage(targetPage);

    } catch (err) {
      console.error("Failed to fetch visits:", err);
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [dateFrom, dateTo, statusFilter, purposeFilter, searchQuery]);

  // Refetch (from page 0) whenever a filter changes
  useEffect(() => {
    fetchVisits(0);
  }, [fetchVisits]);

  const rangeStart = counts.total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd    = Math.min(counts.total, page * PAGE_SIZE + visits.length);

  return (
    <div style={styles.page} className="admin-page">

      {/* ── Header ── */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Visit History</h1>
          <p style={styles.subtitle}>Search and review all visit records</p>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div style={styles.filterBar}>

        {/* Date range */}
        <div style={styles.filterGroup}>
          <label style={styles.filterLabel}>From</label>
          <input
            type="date"
            style={styles.filterInput}
            value={dateFrom}
            max={dateTo}
            onChange={e => setDateFrom(e.target.value)}
          />
        </div>

        <div style={styles.filterGroup}>
          <label style={styles.filterLabel}>To</label>
          <input
            type="date"
            style={styles.filterInput}
            value={dateTo}
            min={dateFrom}
            onChange={e => setDateTo(e.target.value)}
          />
        </div>

        {/* Status filter */}
        <div style={styles.filterGroup}>
          <label style={styles.filterLabel}>Status</label>
          <select
            style={styles.filterInput}
            value={statusFilter}
            onChange={e => setStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Purpose filter */}
        <div style={styles.filterGroup}>
          <label style={styles.filterLabel}>Purpose</label>
          <select
            style={styles.filterInput}
            value={purposeFilter}
            onChange={e => setPurpose(e.target.value)}
          >
            {PURPOSE_OPTIONS.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div style={{ ...styles.filterGroup, flex: 2 }}>
          <label style={styles.filterLabel}>Search</label>
          <input
            style={styles.filterInput}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Visitor name, phone, or student..."
          />
        </div>

        <button
          style={styles.fetchBtn}
          onClick={() => fetchVisits(0)}
          disabled={loading}
        >
          {loading ? <Spinner size={16} color="#fff" /> : "Apply"}
        </button>

      </div>

      {/* ── Summary strip ── */}
      {fetched && (
        <div style={styles.summaryStrip}>
          <SummaryPill label="Total"       value={counts.total}      color="#2563eb" />
          <SummaryPill label="On Campus"   value={counts.onCampus}   color="#16a34a" />
          <SummaryPill label="Departed"    value={counts.departed}   color="#6b7280" />
          <SummaryPill label="Not Arrived" value={counts.registered} color="#d97706" />
        </div>
      )}

      {/* ── Results ── */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 60 }}>
          <Spinner size={36} />
        </div>
      ) : !fetched ? null : visits.length === 0 ? (
        <div style={styles.emptyState}>
          <p style={{ fontSize: 40, marginBottom: 12 }}>📭</p>
          <p style={{ fontWeight: 600, color: "#374151" }}>No visits found</p>
          <p style={{ fontSize: 14, color: "#9ca3af", marginTop: 4 }}>
            Try adjusting the date range or filters
          </p>
        </div>
      ) : (
        <>
          <div style={styles.visitList}>
            {visits.map(visit => (
              <VisitCard
                key={visit.id}
                visit={visit}
                isExpanded={expanded === visit.id}
                onToggle={() =>
                  setExpanded(prev => prev === visit.id ? null : visit.id)
                }
                onForceCheckout={async () => {
                  const { error } = await supabase.rpc("admin_force_checkout", { p_visit_id: visit.id });
                  if (error) { console.error("Force checkout failed:", error); return; }
                  fetchVisits(page);
                }}
              />
            ))}
          </div>

          {/* ── Pagination ── */}
          <div style={styles.paginationBar}>
            <span style={styles.paginationLabel}>
              Showing {rangeStart}–{rangeEnd} of {counts.total}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                style={styles.pageBtn}
                onClick={() => fetchVisits(page - 1)}
                disabled={page === 0 || loading}
              >
                ← Previous
              </button>
              <button
                style={styles.pageBtn}
                onClick={() => fetchVisits(page + 1)}
                disabled={rangeEnd >= counts.total || loading}
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}

    </div>
  );
}

// ─── Visit card component ─────────────────────────────────────────────────────
// Shows a summary row; clicking expands to show full details
function VisitCard({ visit, isExpanded, onToggle, onForceCheckout }) {
  const [showQr, setShowQr] = useState(false);
  const [forcingCheckout, setForcingCheckout] = useState(false);

  const purpose = visit.purpose === "Other"
    ? visit.purpose_other : visit.purpose;

  const studentNames = visit.visit_students?.map(s => s.student_name).join(", ") || "—";
  const registeredAt = visit.registered_at  ? new Date(visit.registered_at)  : null;
  const checkedInAt  = visit.checked_in_at  ? new Date(visit.checked_in_at)  : null;
  const checkedOutAt = visit.checked_out_at ? new Date(visit.checked_out_at) : null;
  const effectiveStatus = visit.cancelled_at ? "cancelled" : visit.status;

  function fmt(date) {
    if (!date) return "—";
    return date.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit"
    });
  }

  // Duration on campus (if fully checked out)
  let duration = null;
  if (checkedInAt && checkedOutAt) {
    const mins = Math.round((checkedOutAt - checkedInAt) / 60000);
    duration = mins < 60
      ? `${mins}m`
      : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  // Resend link — same message pattern as RegisterPage's own share, just
  // reusing the visit's existing qr_token rather than generating a new one.
  const qrUrl = `${window.location.origin}/qr/${visit.qr_token}`;
  const shareMessage =
    `Hi ${visit.visitor_name}, here's your visit QR code again:\n${qrUrl}\n\n` +
    `Show this to staff at the gate on ${formatDateShort(visit.visit_date)}.`;
  const rawPhone = (visit.visitor_phone || "").replace(/\D/g, "");
  const waPhone = rawPhone.startsWith("0") ? "233" + rawPhone.slice(1) : rawPhone;
  const whatsappUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(shareMessage)}`;

  async function handleForceCheckout(e) {
    e.stopPropagation();
    if (!window.confirm(
      `Force-checkout ${visit.visitor_name}? Use this only if they left without ` +
      `being scanned out at the gate.`
    )) return;
    setForcingCheckout(true);
    try {
      await onForceCheckout();
    } finally {
      setForcingCheckout(false);
    }
  }

  return (
    <div style={{
      ...cardStyles.card,
      borderLeft: `4px solid ${statusColor(effectiveStatus)}`,
    }}>

      {/* ── Summary row (always visible) ── */}
      <div style={cardStyles.summary} onClick={onToggle}>
        <div style={cardStyles.summaryLeft}>
          <div style={cardStyles.topRow}>
            <span style={cardStyles.visitorName}>{visit.visitor_name}</span>
            <StatusBadge status={effectiveStatus} />
          </div>
          <p style={cardStyles.meta}>
            📞 {visit.visitor_phone}
            <span style={cardStyles.dot}>·</span>
            🎓 {studentNames}
            <span style={cardStyles.dot}>·</span>
            📋 {purpose}
            {visit.created_by === "gate_staff" && (
              <>
                <span style={cardStyles.dot}>·</span>
                <span style={cardStyles.walkInTag}>Walk-in</span>
              </>
            )}
          </p>
        </div>
        <div style={cardStyles.summaryRight}>
          <p style={cardStyles.dateLabel}>
            {formatDateShort(visit.visit_date)}
          </p>
          <span style={cardStyles.chevron}>
            {isExpanded ? "▲" : "▼"}
          </span>
        </div>
      </div>

      {/* ── Expanded details ── */}
      {isExpanded && (
        <div style={cardStyles.details}>
          <div style={cardStyles.detailsGrid}>

            <DetailBlock title="Visitor">
              <DetailRow label="Name"         value={visit.visitor_name} />
              <DetailRow label="Phone"        value={visit.visitor_phone} />
              <DetailRow label="Relationship" value={visit.relationship || "—"} />
            </DetailBlock>

            <DetailBlock title="Students Visited">
              {visit.visit_students?.map((s, i) => (
                <DetailRow
                  key={i}
                  label={s.class}
                  value={s.student_name}
                />
              ))}
            </DetailBlock>

            <DetailBlock title="Visit Info">
              <DetailRow label="Date"    value={formatDateShort(visit.visit_date)} />
              <DetailRow label="Purpose" value={purpose} />
              <DetailRow label="Source"
                value={visit.created_by === "gate_staff"
                  ? "Walk-in (gate staff)" : "Pre-registered"} />
              {duration && (
                <DetailRow label="Duration on campus" value={duration} />
              )}
              {visit.checked_out_by && (
                <DetailRow label="Checked out by"
                  value={visit.checked_out_by === "admin" ? "Admin (forced)" : "Gate"} />
              )}
            </DetailBlock>

            <DetailBlock title="Timestamps">
              <DetailRow label="Registered"  value={fmt(registeredAt)} />
              <DetailRow label="Checked In"  value={fmt(checkedInAt)} />
              <DetailRow label="Checked Out" value={fmt(checkedOutAt)} />
            </DetailBlock>

          </div>

          {/* ── Actions ── */}
          <div style={cardStyles.actionsRow}>
            <button
              style={cardStyles.actionButton}
              onClick={e => { e.stopPropagation(); setShowQr(prev => !prev); }}
            >
              {showQr ? "Hide QR" : "🔗 Show / Resend QR"}
            </button>

            {visit.status === "checked_in" && (
              <button
                style={{ ...cardStyles.actionButton, color: "#b91c1c", borderColor: "#fca5a5" }}
                onClick={handleForceCheckout}
                disabled={forcingCheckout}
              >
                {forcingCheckout ? "Working..." : "🚪 Force Check Out"}
              </button>
            )}
          </div>

          {showQr && (
            <div style={cardStyles.qrPanel} onClick={e => e.stopPropagation()}>
              <QRCodeCanvas value={visit.qr_token} size={140} level="H" includeMargin />
              <p style={cardStyles.qrToken}>{visit.qr_token}</p>
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={cardStyles.whatsappLink}
              >
                💬 Share via WhatsApp
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Small helper components ──────────────────────────────────────────────────

function SummaryPill({ label, value, color }) {
  return (
    <div style={pillStyles.pill}>
      <span style={{ ...pillStyles.value, color }}>{value}</span>
      <span style={pillStyles.label}>{label}</span>
    </div>
  );
}

function DetailBlock({ title, children }) {
  return (
    <div style={detailStyles.block}>
      <p style={detailStyles.title}>{title}</p>
      {children}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div style={detailStyles.row}>
      <span style={detailStyles.label}>{label}</span>
      <span style={detailStyles.value}>{value || "—"}</span>
    </div>
  );
}

function StatusBadge({ status }) {
  const config = {
    registered:  { label: "Not Arrived", bg: "#fef3c7", color: "#92400e" },
    checked_in:  { label: "On Campus",   bg: "#dcfce7", color: "#166534" },
    checked_out: { label: "Departed",    bg: "#f3f4f6", color: "#374151" },
    cancelled:   { label: "Cancelled",   bg: "#fee2e2", color: "#991b1b" },
  };
  const c = config[status] || config.registered;
  return (
    <span style={{
      padding: "3px 10px", borderRadius: 999, fontSize: 11,
      fontWeight: 700, background: c.bg, color: c.color,
    }}>
      {c.label}
    </span>
  );
}

function statusColor(status) {
  return status === "checked_in"  ? "#16a34a"
       : status === "checked_out" ? "#6b7280"
       : status === "cancelled"   ? "#dc2626"
       : "#d97706";
}

function formatDateShort(dateStr) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page:     { padding: 32, maxWidth: 1100, margin: "0 auto" },
  header:   { marginBottom: 24 },
  title:    { fontSize: 26, fontWeight: 700, color: "#0f172a" },
  subtitle: { fontSize: 14, color: "#6b7280", marginTop: 2 },

  filterBar: {
    display: "flex", flexWrap: "wrap", gap: 12,
    background: "#fff", borderRadius: 14,
    padding: "16px 20px", marginBottom: 20,
    border: "1px solid #e5e7eb",
    alignItems: "flex-end",
  },
  filterGroup: {
    display: "flex", flexDirection: "column", gap: 5, flex: 1, minWidth: 130,
  },
  filterLabel: {
    fontSize: 11, fontWeight: 700, color: "#9ca3af",
    textTransform: "uppercase", letterSpacing: "0.06em",
  },
  filterInput: {
    padding: "8px 10px", fontSize: 13, border: "1.5px solid #e5e7eb",
    borderRadius: 8, color: "#0f172a", background: "#fff",
  },
  fetchBtn: {
    padding: "8px 20px", background: "#2563eb", color: "#fff",
    border: "none", borderRadius: 8, cursor: "pointer",
    fontWeight: 700, fontSize: 14, alignSelf: "flex-end",
    display: "flex", alignItems: "center", gap: 6,
    height: 36,
  },

  summaryStrip: {
    display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap",
  },

  emptyState: {
    textAlign: "center", padding: "60px 0",
    color: "#6b7280",
  },

  visitList: { display: "flex", flexDirection: "column", gap: 8 },

  paginationBar: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    marginTop: 16, padding: "12px 4px",
  },
  paginationLabel: { fontSize: 13, color: "#6b7280" },
  pageBtn: {
    padding: "7px 14px", background: "#fff", color: "#374151",
    border: "1.5px solid #e5e7eb", borderRadius: 8, cursor: "pointer",
    fontSize: 13, fontWeight: 600,
  },
};

const cardStyles = {
  card: {
    background: "#fff", borderRadius: 12,
    border: "1px solid #e5e7eb", overflow: "hidden",
  },
  summary: {
    display: "flex", justifyContent: "space-between",
    alignItems: "flex-start", padding: "14px 18px",
    cursor: "pointer",
    transition: "background 0.15s",
  },
  summaryLeft:  { flex: 1 },
  summaryRight: { textAlign: "right", marginLeft: 16, flexShrink: 0 },
  topRow:       { display: "flex", alignItems: "center", gap: 10, marginBottom: 4 },
  visitorName:  { fontSize: 15, fontWeight: 700, color: "#0f172a" },
  meta:         { fontSize: 12, color: "#6b7280", lineHeight: 1.6 },
  dot:          { margin: "0 4px", color: "#d1d5db" },
  walkInTag:    { background: "#f3e8ff", color: "#7c3aed",
                  padding: "1px 7px", borderRadius: 999,
                  fontSize: 11, fontWeight: 700 },
  dateLabel:    { fontSize: 13, fontWeight: 600, color: "#374151" },
  chevron:      { fontSize: 10, color: "#9ca3af", marginTop: 4,
                  display: "block" },
  details: {
    borderTop: "1px solid #f1f5f9",
    padding: "16px 18px",
    background: "#fafafa",
  },
  detailsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 20,
  },
  actionsRow: {
    display: "flex", gap: 10, marginTop: 16,
    paddingTop: 16, borderTop: "1px solid #f1f5f9",
  },
  actionButton: {
    padding: "7px 14px", background: "#fff", color: "#374151",
    border: "1.5px solid #e5e7eb", borderRadius: 8, cursor: "pointer",
    fontSize: 12, fontWeight: 600,
  },
  qrPanel: {
    marginTop: 14, padding: 16, background: "#f8fafc",
    borderRadius: 12, border: "1px dashed #cbd5e1",
    display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
  },
  qrToken: {
    fontSize: 14, fontWeight: 700, letterSpacing: "0.1em",
    color: "#0f172a", fontFamily: "monospace",
  },
  whatsappLink: {
    display: "inline-block", marginTop: 4, padding: "8px 16px",
    background: "#25D366", color: "#fff", borderRadius: 8,
    fontSize: 13, fontWeight: 700, textDecoration: "none",
  },
};

const pillStyles = {
  pill: {
    background: "#fff", border: "1px solid #e5e7eb",
    borderRadius: 10, padding: "10px 16px",
    display: "flex", flexDirection: "column", alignItems: "center",
    minWidth: 90,
  },
  value: { fontSize: 22, fontWeight: 800, lineHeight: 1 },
  label: { fontSize: 12, color: "#9ca3af", marginTop: 4, fontWeight: 500 },
};

const detailStyles = {
  block: { display: "flex", flexDirection: "column", gap: 6 },
  title: { fontSize: 11, fontWeight: 700, color: "#9ca3af",
           textTransform: "uppercase", letterSpacing: "0.07em",
           marginBottom: 4 },
  row:   { display: "flex", justifyContent: "space-between",
           fontSize: 13, gap: 8 },
  label: { color: "#6b7280", flexShrink: 0 },
  value: { color: "#0f172a", fontWeight: 600, textAlign: "right",
           wordBreak: "break-word" },
};