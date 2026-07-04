create type public.visit_status as enum ('registered', 'checked_in', 'checked_out');

create table public.visits (
  id             uuid primary key default gen_random_uuid(),
  visitor_name   text not null,
  visitor_phone  text not null,
  relationship   text not null default 'Not specified',
  purpose        text not null,
  purpose_other  text not null default '',
  visit_date     date not null,
  status         public.visit_status not null default 'registered',
  qr_token       text not null,
  registered_at  timestamptz not null default now(),
  checked_in_at  timestamptz,
  checked_out_at timestamptz,
  created_by     text not null check (created_by in ('self', 'gate_staff')),
  created_at     timestamptz not null default now()
);

create unique index visits_qr_token_unique on public.visits (qr_token);
create index visits_visit_date_idx on public.visits (visit_date);
create index visits_visit_date_status_idx on public.visits (visit_date, status);
create index visits_date_registered_idx on public.visits (visit_date desc, registered_at desc);
