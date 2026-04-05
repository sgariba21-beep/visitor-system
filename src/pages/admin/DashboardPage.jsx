import { useState, useEffect } from "react";
import { collection, query, where, onSnapshot, orderBy } from "firebase/firestore";
import { db } from "../../firebase";
import Spinner from "../../components/Spinner";

export default function DashboardPage() {

  const [visits, setVisits]   = useState([]);
  const [loading, setLoading] = useState(true);

  // Today's date string — used to scope all queries to today
  const todayStr = new Date().toISOString().split("T")[0];

  // ── Real-time listener for today's visits ─────────────────────────────────
  // onSnapshot keeps this data live — no manual refresh needed.
  // When a gate staff member checks someone in, this updates within ~1 second.
  useEffect(() => {
    const q = query(
      collection(db, "visits"),
      where("visitDate", "==", todayStr),
      orderBy("registeredAt", "desc")
    );

    // onSnapshot returns an "unsubscribe" function.
    // We return it from useEffect so React calls it on unmount,
    // stopping the listener when the admin navigates away.
    const unsubscribe = onSnapshot(q, (snap) => {
      setVisits(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, (err) => {
      console.error("Snapshot error:", err);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [todayStr]);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const total      = visits.length;
  const onCampus   = visits.filter(v => v.status === "checked_in").length;
  const checkedOut = visits.filter(v => v.status === "checked_out").length;
  const registered = visits.filter(v => v.status === "registered").length;
  const walkIns    = visits.filter(v => v.createdBy === "gate_staff").length;

  // Visits currently on campus — sorted by check-in time
  const onCampusVisits = visits
    .filter(v => v.status === "checked_in")
    .sort((a, b) => {
      const aTime = a.checkedInAt?.toDate?.() || 0;
      const bTime = b.checkedInAt?.toDate?.() || 0;
      return bTime - aTime;
    });

  // Recent activity — last 10 visits regardless of status
  const recentActivity = visits.slice(0, 10);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center",
                    alignItems: "center", height: "60vh" }}>
        <Spinner size={40} />
      </div>
    );
  }

  return (
    <div style={styles.page}>

      {/* ── Page header ── */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Dashboard</h1>
          <p style={styles.subtitle}>
            {formatDate(todayStr)} · Live updates
            <span style={styles.liveDot} title="Live" />
          </p>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div style={styles.statsGrid}>
        <StatCard
          icon="👥"
          label="Total Registered"
          value={total}
          color="#2563eb"
          bg="#eff6ff"
        />
        <StatCard
          icon="🟢"
          label="On Campus Now"
          value={onCampus}
          color="#16a34a"
          bg="#f0fdf4"
        />
        <StatCard
          icon="🏁"
          label="Checked Out"
          value={checkedOut}
          color="#6b7280"
          bg="#f9fafb"
        />
        <StatCard
          icon="⏳"
          label="Not Yet Arrived"
          value={registered}
          color="#d97706"
          bg="#fffbeb"
        />
        <StatCard
          icon="🚶"
          label="Walk-ins"
          value={walkIns}
          color="#7c3aed"
          bg="#f5f3ff"
        />
      </div>

      <div style={styles.twoCol}>

        {/* ── On Campus Now ── */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>
            🟢 On Campus Now
            <span style={styles.panelCount}>{onCampus}</span>
          </h2>

          {onCampusVisits.length === 0 ? (
            <p style={styles.emptyMsg}>No visitors currently on campus.</p>
          ) : (
            <div style={styles.visitList}>
              {onCampusVisits.map(visit => (
                <VisitRow key={visit.id} visit={visit} showTime="checkedInAt" />
              ))}
            </div>
          )}
        </div>

        {/* ── Recent Activity ── */}
        <div style={styles.panel}>
          <h2 style={styles.panelTitle}>
            🕐 Recent Activity
          </h2>

          {recentActivity.length === 0 ? (
            <p style={styles.emptyMsg}>No visits recorded today yet.</p>
          ) : (
            <div style={styles.visitList}>
              {recentActivity.map(visit => (
                <VisitRow key={visit.id} visit={visit} showTime="registeredAt" showStatus />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ─── Helper components ────────────────────────────────────────────────────────

function StatCard({ icon, label, value, color, bg }) {
  return (
    <div style={{ ...cardStyles.card, background: bg }}>
      <span style={cardStyles.icon}>{icon}</span>
      <div>
        <p style={{ ...cardStyles.value, color }}>{value}</p>
        <p style={cardStyles.label}>{label}</p>
      </div>
    </div>
  );
}

function VisitRow({ visit, showTime, showStatus = false }) {
  const timeField = visit[showTime];
  const timeStr   = timeField?.toDate
    ? timeField.toDate().toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit"
      })
    : "—";

  const studentNames = visit.students?.map(s => s.studentName).join(", ") || "—";
  const purpose = visit.purpose === "Other" ? visit.purposeOther : visit.purpose;

  return (
    <div style={rowStyles.row}>
      <div style={rowStyles.left}>
        <p style={rowStyles.name}>{visit.visitorName}</p>
        <p style={rowStyles.sub}>🎓 {studentNames}</p>
        <p style={rowStyles.sub}>📋 {purpose}</p>
      </div>
      <div style={rowStyles.right}>
        <p style={rowStyles.time}>{timeStr}</p>
        {showStatus && <StatusBadge status={visit.status} />}
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const config = {
    registered:  { label: "Not Arrived", bg: "#fef3c7", color: "#92400e" },
    checked_in:  { label: "On Campus",   bg: "#dcfce7", color: "#166534" },
    checked_out: { label: "Departed",    bg: "#f3f4f6", color: "#374151" },
  };
  const c = config[status] || config.registered;
  return (
    <span style={{
      padding: "3px 10px", borderRadius: 999, fontSize: 11,
      fontWeight: 700, background: c.bg, color: c.color,
      whiteSpace: "nowrap",
    }}>
      {c.label}
    </span>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  page:      { padding: 32, maxWidth: 1200, margin: "0 auto" },
  header:    { marginBottom: 28 },
  title:     { fontSize: 26, fontWeight: 700, color: "#0f172a" },
  subtitle:  { fontSize: 14, color: "#6b7280", marginTop: 4,
               display: "flex", alignItems: "center", gap: 8 },
  liveDot:   {
    display: "inline-block", width: 8, height: 8,
    borderRadius: "50%", background: "#16a34a",
    boxShadow: "0 0 0 2px #bbf7d0",
    animation: "pulse 2s infinite",
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 16, marginBottom: 28,
  },
  twoCol:    { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 },
  panel:     {
    background: "#fff", borderRadius: 16,
    border: "1px solid #e5e7eb",
    padding: 20, minHeight: 300,
  },
  panelTitle: {
    fontSize: 15, fontWeight: 700, color: "#0f172a",
    marginBottom: 16, display: "flex",
    alignItems: "center", justifyContent: "space-between",
  },
  panelCount: {
    background: "#f1f5f9", color: "#475569",
    borderRadius: 999, padding: "2px 10px",
    fontSize: 13, fontWeight: 700,
  },
  visitList:  { display: "flex", flexDirection: "column", gap: 1 },
  emptyMsg:   { color: "#9ca3af", fontSize: 14, textAlign: "center",
                padding: "32px 0" },
};

const cardStyles = {
  card:  {
    borderRadius: 14, padding: "18px 20px",
    display: "flex", alignItems: "center", gap: 14,
    border: "1px solid #e5e7eb",
  },
  icon:  { fontSize: 28 },
  value: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
  label: { fontSize: 12, color: "#6b7280", marginTop: 3, fontWeight: 500 },
};

const rowStyles = {
  row:   {
    display: "flex", justifyContent: "space-between",
    alignItems: "flex-start", padding: "10px 0",
    borderBottom: "1px solid #f1f5f9",
  },
  left:  { flex: 1 },
  right: { textAlign: "right", flexShrink: 0, marginLeft: 12 },
  name:  { fontSize: 14, fontWeight: 600, color: "#0f172a", marginBottom: 2 },
  sub:   { fontSize: 12, color: "#6b7280", marginBottom: 1 },
  time:  { fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 },
};