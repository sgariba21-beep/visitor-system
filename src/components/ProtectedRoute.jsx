import { Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import Spinner from "./Spinner";

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  // Still checking auth state — show nothing yet
  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", 
                    alignItems: "center", height: "100vh" }}>
        <Spinner size={40} />
      </div>
    );
  }

  // Not logged in — redirect to login page
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Logged in — render the actual page
  return children;
}