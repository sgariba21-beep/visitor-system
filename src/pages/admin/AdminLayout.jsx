import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../../firebase";
import { useAuth } from "../../hooks/useAuth";

const navItems = [
  { to: "/admin/dashboard", label: "Dashboard", icon: "📊" },
  { to: "/admin/students",  label: "Students",  icon: "🎓" },
  { to: "/admin/visits",    label: "Visit History", icon: "📋" },
];

export default function AdminLayout() {
  const { user } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await signOut(auth);
    navigate("/login");
  }

  return (
    <div style={styles.shell}>
      {/* Sidebar */}
      <aside style={styles.sidebar}>
        <div style={styles.brand}>
          <span style={{ fontSize: 24 }}>🏫</span>
          <span style={styles.brandName}>VMS Admin</span>
        </div>

        <nav style={styles.nav}>
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
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

      {/* Main content — Outlet renders the current child page */}
      <main style={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}

const styles = {
  shell:    { display: "flex", minHeight: "100vh" },
  sidebar:  {
    width: 220, background: "#0f172a", display: "flex",
    flexDirection: "column", padding: "24px 0", flexShrink: 0,
  },
  brand:     { display: "flex", alignItems: "center", gap: 10, 
               padding: "0 20px 24px", borderBottom: "1px solid #1e293b" },
  brandName: { color: "#fff", fontWeight: 700, fontSize: 16 },
  nav:       { flex: 1, padding: "16px 12px", display: "flex", 
               flexDirection: "column", gap: 4 },
  navLink:   {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 12px", borderRadius: 8, textDecoration: "none",
    fontSize: 14, fontWeight: 500, transition: "all 0.15s",
  },
  sidebarFooter: { padding: "16px 20px", borderTop: "1px solid #1e293b" },
  emailText:     { color: "#64748b", fontSize: 12, marginBottom: 8,
                   overflow: "hidden", textOverflow: "ellipsis" },
  logoutBtn:     {
    width: "100%", padding: "8px", background: "#1e293b",
    color: "#94a3b8", border: "none", borderRadius: 6,
    cursor: "pointer", fontSize: 13,
  },
};