alter table public.visits enable row level security;
alter table public.visit_students enable row level security;

-- anon: SELECT is needed for QrPage (lookup by qr_token, any day) and Gate
-- (today's visits, token lookup, manual search). No row-level restriction
-- beyond "no auth" -- matches today's fully-open Firestore reads.
create policy visits_anon_select
  on public.visits for select
  to anon
  using (true);

create policy visit_students_anon_select
  on public.visit_students for select
  to anon
  using (true);

-- anon: NO direct INSERT/UPDATE/DELETE policy on visits or visit_students.
-- All anon mutations go through the create_visit / check_in_visit / check_out_visit
-- SECURITY DEFINER RPCs (see 0007, 0008), which bypass RLS internally and are
-- narrow-by-construction. This is deliberately more restrictive than a raw
-- anon UPDATE grant would be.

-- authenticated (admin): full CRUD for VisitsPage / future admin tooling
create policy visits_auth_select on public.visits for select to authenticated using (true);
create policy visits_auth_insert on public.visits for insert to authenticated with check (true);
create policy visits_auth_update on public.visits for update to authenticated using (true) with check (true);
create policy visits_auth_delete on public.visits for delete to authenticated using (true);

create policy visit_students_auth_select on public.visit_students for select to authenticated using (true);
create policy visit_students_auth_insert on public.visit_students for insert to authenticated with check (true);
create policy visit_students_auth_update on public.visit_students for update to authenticated using (true) with check (true);
create policy visit_students_auth_delete on public.visit_students for delete to authenticated using (true);
