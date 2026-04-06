import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../../firebase";
import { useAuth } from "../../hooks/useAuth";

const navItems = [
  { to: "/admin/dashboard", label: "Dashboard",     icon: "📊" },
  { to: "/admin/students",  label: "Students",      icon: "🎓" },
  { to: "/admin/visits",    label: "Visit History", icon: "📋" },
];

export default function AdminLayout() {
  const { user }      = useAuth();
  const navigate      = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function handleLogout() {
    await signOut(auth);
    navigate("/login");
  }

  function closeSidebar() {
    setSidebarOpen(false);
  }

  return (
    <div style={styles.shell}>

      {/* ── Mobile top bar (hidden on desktop) ── */}
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

      {/* ── Overlay (mobile only — tap outside to close sidebar) ── */}
      {sidebarOpen && (
        <div style={styles.overlay} onClick={closeSidebar} />
      )}

      {/* ── Sidebar ── */}
      <aside style={{
        ...styles.sidebar,
        // On mobile: slide in/out. On desktop: always visible.
        transform: sidebarOpen
          ? "translateX(0)"
          : "translateX(-100%)",
      }}>
        {/* Desktop brand (hidden on mobile — mobile has top bar) */}
        <div style={styles.brand}>
          <span style={{ fontSize: 24 }}>🏫</span>
          <span style={styles.brandName}>VMS Admin</span>
        </div>

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
// We detect mobile vs desktop using a CSS custom property approach.
// The breakpoint is 768px.
const isMobile = window.innerWidth < 768;

const styles = {
  shell: {
    display: "flex",
    minHeight: "100vh",
    // On mobile, stack vertically. On desktop, side by side.
    flexDirection: isMobile ? "column" : "row",
  },

  // ── Mobile top bar ──────────────────────────────────────────────────────────
  mobileTopBar: {
    display: isMobile ? "flex" : "none",
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

  // ── Overlay ─────────────────────────────────────────────────────────────────
  overlay: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 299,
    display: isMobile ? "block" : "none",
  },

  // ── Sidebar ─────────────────────────────────────────────────────────────────
  sidebar: {
    width: 220,
    background: "#0f172a",
    display: "flex",
    flexDirection: "column",
    padding: "24px 0",
    flexShrink: 0,
    // Desktop: normal flow. Mobile: fixed overlay that slides in.
    ...(isMobile ? {
      position: "fixed",
      top: 0, left: 0, bottom: 0,
      zIndex: 300,
      transition: "transform 0.25s ease",
      paddingTop: 16,
    } : {
      // Desktop: always visible, no transform needed
      transform: "none !important",
    }),
  },

  brand: {
    display: isMobile ? "none" : "flex",
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

  // ── Main content ─────────────────────────────────────────────────────────────
  main: {
    flex: 1,
    overflowX: "hidden",
    // On mobile, take full width. On desktop, sit beside sidebar.
    minWidth: 0,
  },
};