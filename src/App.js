import { BrowserRouter, Routes, Route } from "react-router-dom";
import RegisterPage   from "./pages/RegisterPage";
import GatePage       from "./pages/GatePage";
import LoginPage      from "./pages/LoginPage";
import AdminLayout    from "./pages/admin/AdminLayout";
import StudentsPage   from "./pages/admin/StudentsPage";
import DashboardPage  from "./pages/admin/DashboardPage";
import ProtectedRoute from "./components/ProtectedRoute";
import VisitsPage from "./pages/admin/VisitsPage";

console.log("APP RENDERING");

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
          <Route index element={<DashboardPage />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="students"  element={<StudentsPage />} />
          <Route path="visits"    element={<VisitsPage />} />
        </Route>

        {/* Gate (will be protected differently — PIN based) */}
        <Route path="/gate" element={<GatePage />} />
      </Routes>
    </BrowserRouter>
  );
}