create table public.visit_students (
  id           uuid primary key default gen_random_uuid(),
  visit_id     uuid not null references public.visits(id) on delete cascade,
  student_id   uuid references public.students(id) on delete set null,
  student_name text not null,   -- denormalized snapshot, survives student deletion
  class        text not null,   -- denormalized snapshot, survives student deletion
  created_at   timestamptz not null default now()
);

create index visit_students_visit_id_idx on public.visit_students (visit_id);
create index visit_students_student_id_idx on public.visit_students (student_id);
