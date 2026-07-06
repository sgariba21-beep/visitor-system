-- Previously any student could be hard-deleted regardless of visit
-- history — visit_students.student_id's `on delete set null` meant the
-- delete always succeeded and just orphaned the FK, relying on the
-- denormalized student_name/class snapshot to keep old visit records
-- readable. That's still a reasonable *fallback*, but it meant "permanently
-- delete" and "this student has been visited before" were never actually
-- connected: an admin could wipe a student who has real visit history with
-- no warning beyond a confirm() dialog, when deactivation (is_active =
-- false) is what they should be doing instead.
--
-- Enforced as a trigger (not just app-level logic) so it holds regardless
-- of caller — a raw SQL delete is blocked exactly the same as one from the
-- admin UI.

create or replace function public.prevent_delete_student_with_visits()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.visit_students where student_id = old.id) then
    raise exception 'Cannot permanently delete % — they have visit history. Deactivate instead.', old.name
      using errcode = 'P0010';
  end if;
  return old;
end;
$$;

create trigger trg_prevent_delete_student_with_visits
  before delete on public.students
  for each row
  execute function public.prevent_delete_student_with_visits();
