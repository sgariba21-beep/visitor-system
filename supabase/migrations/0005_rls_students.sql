alter table public.students enable row level security;

-- anon: read only active students (Register search, Gate cache warm/search)
create policy students_anon_select_active
  on public.students for select
  to anon
  using (is_active = true);

-- authenticated (admin): full read/write for StudentsPage
create policy students_auth_select_all
  on public.students for select
  to authenticated
  using (true);

create policy students_auth_insert
  on public.students for insert
  to authenticated
  with check (true);

create policy students_auth_update
  on public.students for update
  to authenticated
  using (true)
  with check (true);

create policy students_auth_delete
  on public.students for delete
  to authenticated
  using (true);
