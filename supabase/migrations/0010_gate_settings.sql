-- Singleton table (id is always `true`, enforced by the check constraint)
-- holding the Gate page's PIN, so it can be changed from the admin
-- Settings page instead of requiring a rebuild/redeploy to change an
-- env var. Same trust model as before: this is a convenience lock for
-- gate staff, not a real security boundary, so anon SELECT is fine (the
-- PIN was already visible in the client bundle previously).
create table public.gate_settings (
  id         boolean primary key default true check (id),
  pin        text not null default '1234' check (pin ~ '^[0-9]{4,6}$'),
  updated_at timestamptz not null default now()
);

insert into public.gate_settings (id, pin) values (true, '1234');

alter table public.gate_settings enable row level security;

-- anon: read-only, needed so the (unauthenticated) Gate page can fetch
-- and locally cache the current PIN for offline verification.
create policy gate_settings_anon_select
  on public.gate_settings for select
  to anon
  using (true);

-- authenticated (admin): can view and change it via the Settings page.
create policy gate_settings_auth_select
  on public.gate_settings for select
  to authenticated
  using (true);

create policy gate_settings_auth_update
  on public.gate_settings for update
  to authenticated
  using (true)
  with check (true);
