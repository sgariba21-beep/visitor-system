import { useState, useEffect } from "react";
import { supabase } from "../lib/supabaseClient";

// This hook gives any component access to the current logged-in user.
// It returns: { user, loading }
// - user: the Supabase user object (or null if not logged in)
// - loading: true while we're still checking auth state on page load
export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Unlike Firebase, onAuthStateChange doesn't synchronously replay the
    // cached session on mount, so we fetch it explicitly first to avoid a
    // flash of "logged out" before the listener fires.
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  return { user, loading };
}
