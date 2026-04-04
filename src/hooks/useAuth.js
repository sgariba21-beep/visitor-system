import { useState, useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "../firebase";

// This hook gives any component access to the current logged-in user.
// It returns: { user, loading }
// - user: the Firebase user object (or null if not logged in)
// - loading: true while Firebase is still checking auth state on page load
export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // onAuthStateChanged fires whenever login state changes.
    // It also fires once on mount to tell us the current state.
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });

    // Cleanup: stop listening when the component unmounts
    return () => unsubscribe();
  }, []);

  return { user, loading };
}