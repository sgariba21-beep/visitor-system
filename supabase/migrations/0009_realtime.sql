-- Enables Supabase Realtime change events on visits, used by the admin
-- dashboard's live "on campus now" view.
alter publication supabase_realtime add table public.visits;
