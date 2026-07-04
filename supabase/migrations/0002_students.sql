create table public.students (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  class        text not null,
  student_id   citext,                         -- nullable: legacy rows without an ID
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Case-insensitive uniqueness, only enforced when student_id is present.
-- A partial unique index (not a table constraint) so multiple NULL/blank IDs are allowed,
-- matching the app's existing tolerance for students without an assigned ID.
create unique index students_student_id_unique_ci
  on public.students (student_id)
  where student_id is not null and student_id <> '';

create index students_is_active_name_idx on public.students (is_active, name);
