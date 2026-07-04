import { useState, useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../hooks/useAuth";

const navItems = [
  { to: "/admin/dashboard", label: "Dashboard",     icon: "📊" },
  { to: "/admin/students",  label: "Students",      icon: "🎓" },
  { to: "/admin/visits",    label: "Visit History", icon: "📋" },
];

// ─── Reactive media query hook ────────────────────────────────────────────────
// Returns true/false and updates whenever the window is resized.
// This is the correct way to do JS-driven responsive layouts in React.
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    // initialise synchronously so the first render is already correct
    window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql     = window.matchMedia(query);
    const handler = (e) => setMatches(e.matches);

    // Modern API
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export default function AdminLayout() {
  const { user }   = useAuth();
  const navigate   = useNavigate();
  const isMobile   = useMediaQuery("(max-width: 767px)");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close sidebar whenever we switch from mobile to desktop
  // (e.g. user rotates device or resizes browser)
  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  async function handleLogout() {
    await supabase.auth.signOut();
    navigate("/login");
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  return (
    <div style={styles.shell(isMobile)}>

      {/* ── Mobile top bar ── */}
      {isMobile && (
        <div style={styles.mobileTopBar}>
          <button
            style={styles.hamburger}
            onClick={() => setSidebarOpen(prev => !prev)}
            aria-label="Toggle menu"
          >
            {sidebarOpen ? "✕" : "☰"}
          </button>
          <span style={styles.mobileBrand}>🏫 VMS Admin</span>
          <button style={styles.mobileLogout} onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      )}

      {/* ── Overlay (mobile only) ── */}
      {isMobile && sidebarOpen && (
        <div style={styles.overlay} onClick={closeSidebar} />
      )}

      {/* ── Sidebar ── */}
      <aside style={styles.sidebar(isMobile, sidebarOpen)}>

        {/* Desktop brand header */}
        {!isMobile && (
          <div style={styles.brand}>
            <span style={{ fontSize: 24 }}>🏫</span>
            <span style={styles.brandName}>VMS Admin</span>
          </div>
        )}

        <nav style={styles.nav}>
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={closeSidebar}
              style={({ isActive }) => ({
                ...styles.navLink,
                background: isActive ? "#2563eb" : "transparent",
                color:      isActive ? "#fff"    : "#94a3b8",
              })}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div style={styles.sidebarFooter}>
          <p style={styles.emailText}>{user?.email}</p>
          <button style={styles.logoutBtn} onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main style={styles.main}>
        <Outlet />
      </main>

    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
// Styles that depend on isMobile are now functions rather than static objects.
// They're called at render time with the current value, so they're always correct.
const styles = {

  shell: (isMobile) => ({
    display: "flex",
    minHeight: "100vh",
    flexDirection: isMobile ? "column" : "row",
  }),

  mobileTopBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    background: "#0f172a",
    borderBottom: "1px solid #1e293b",
    position: "sticky",
    top: 0,
    zIndex: 200,
    flexShrink: 0,
  },
  hamburger: {
    background: "none", border: "none",
    color: "#fff", fontSize: 22,
    cursor: "pointer", padding: "4px 8px",
    lineHeight: 1,
  },
  mobileBrand: {
    color: "#fff", fontWeight: 700, fontSize: 16,
  },
  mobileLogout: {
    background: "#1e293b", border: "none",
    color: "#94a3b8", fontSize: 13,
    padding: "6px 12px", borderRadius: 6,
    cursor: "pointer",
  },

  overlay: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 299,
  },

  sidebar: (isMobile, sidebarOpen) => ({
    width: 220,
    background: "#0f172a",
    display: "flex",
    flexDirection: "column",
    padding: "24px 0",
    flexShrink: 0,
    // Mobile: fixed overlay that slides in from the left
    // Desktop: normal flow, always visible
    ...(isMobile ? {
      position: "fixed",
      top: 0, left: 0, bottom: 0,
      zIndex: 300,
      transform: sidebarOpen ? "translateX(0)" : "translateX(-100%)",
      transition: "transform 0.25s ease",
      paddingTop: 16,
    } : {
      position: "relative",
      transform: "none",
    }),
  }),

  brand: {
    display: "flex",
    alignItems: "center", gap: 10,
    padding: "0 20px 24px",
    borderBottom: "1px solid #1e293b",
  },
  brandName: { color: "#fff", fontWeight: 700, fontSize: 16 },

  nav: {
    flex: 1, padding: "16px 12px",
    display: "flex", flexDirection: "column", gap: 4,
  },
  navLink: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 12px", borderRadius: 8,
    textDecoration: "none", fontSize: 14, fontWeight: 500,
    transition: "all 0.15s",
  },

  sidebarFooter: {
    padding: "16px 20px",
    borderTop: "1px solid #1e293b",
  },
  emailText: {
    color: "#64748b", fontSize: 12, marginBottom: 8,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  logoutBtn: {
    width: "100%", padding: "8px",
    background: "#1e293b", color: "#94a3b8",
    border: "none", borderRadius: 6,
    cursor: "pointer", fontSize: 13,
  },

  main: {
    flex: 1,
    overflowX: "hidden",
    minWidth: 0,
  },
};