import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY,
  {
    auth: {
      // Admin login sessions live in sessionStorage instead of the default
      // localStorage, so closing the tab (or browser) signs the admin out
      // automatically instead of the session silently surviving
      // indefinitely. Only affects the logged-in admin session — /gate,
      // /, and /qr never have a Supabase Auth session to persist.
      storage: window.sessionStorage,
    },
  }
);
