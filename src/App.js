import { BrowserRouter, Routes, Route } from "react-router-dom";
import RegisterPage   from "./pages/RegisterPage";
import GatePage       from "./pages/GatePage";
import LoginPage      from "./pages/LoginPage";
import AdminLayout    from "./pages/admin/AdminLayout";
import StudentsPage   from "./pages/admin/StudentsPage";
import DashboardPage  from "./pages/admin/DashboardPage";
import ProtectedRoute from "./components/ProtectedRoute";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route path="/"      element={<RegisterPage />} />
        <Route path="/login" element={<LoginPage />} />

        {/* Protected admin routes */}
        <Route path="/admin" element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }>
          <Route path="students"  element={<StudentsPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
        </Route>

        {/* Gate (will be protected differently — PIN based) */}
        <Route path="/gate" element={<GatePage />} />
      </Routes>
    </BrowserRouter>
  );
}