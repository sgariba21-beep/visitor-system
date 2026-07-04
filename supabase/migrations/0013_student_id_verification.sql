-- Moves student ID "verification" server-side.
--
-- Previously RegisterPage fetched full student rows (select("*")) to power
-- its search dropdown, which handed the real student_id to the browser
-- before the visitor had "verified" anything -- the verification step then
-- just compared typed input against that already-known value in JS, and
-- the 3-attempt lockout was plain React state, reset by a page refresh.
-- The control provided no real protection against a stranger registering
-- to visit a child they don't actually know.
--
-- Fix: anon can no longer read students directly at all. Search returns
-- only id/name/class/has_student_id (never the ID itself), and the actual
-- comparison + attempt counting happens in verify_student_id, tracked by a
-- client-held session id that survives a page refresh (sessionStorage).

drop policy students_anon_select_active on public.students;

create table public.id_verification_attempts (
  session_id text primary key,
  attempts   int not null default 0,
  locked_at  timestamptz,
  updated_at timestamptz not null default now()
);

-- No anon/authenticated policies at all: only ever touched by the
-- SECURITY DEFINER function below, never queried directly by a client.
alter table public.id_verification_attempts enable row level security;

create or replace function public.search_active_students(p_query text default '')
returns table(id uuid, name text, class text, has_student_id boolean)
language sql
security definer
set search_path = public
stable
as $$
  select s.id, s.name, s.class, (s.student_id is not null and s.student_id <> '')
  from public.students s
  where s.is_active = true
    and (
      p_query = '' or
      s.name ilike '%' || replace(replace(p_query, '%', '\%'), '_', '\_') || '%' escape '\' or
      s.class ilike '%' || replace(replace(p_query, '%', '\%'), '_', '\_') || '%' escape '\'
    )
  order by s.name;
$$;

grant execute on function public.search_active_students to anon, authenticated;

create or replace function public.verify_student_id(
  p_session_id      text,
  p_student_row_id  uuid,
  p_guess           text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actual      text;
  v_attempts    int;
  v_locked      timestamptz;
  v_max_attempts constant int := 3;
  -- Normalize away whitespace/dashes so "STU-001", "STU 001", and
  -- "stu001" are all treated as the same ID -- the common false-failure
  -- from a visitor typing the ID slightly differently than it's stored.
  v_norm_guess  text := lower(regexp_replace(coalesce(p_guess, ''), '[\s-]', '', 'g'));
begin
  select attempts, locked_at into v_attempts, v_locked
  from public.id_verification_attempts where session_id = p_session_id;

  if v_locked is not null then
    return jsonb_build_object('ok', false, 'locked', true, 'attempts_remaining', 0);
  end if;

  select student_id into v_actual from public.students where id = p_student_row_id;

  if v_actual is not null and lower(regexp_replace(v_actual, '[\s-]', '', 'g')) = v_norm_guess then
    delete from public.id_verification_attempts where session_id = p_session_id;
    return jsonb_build_object('ok', true, 'locked', false, 'attempts_remaining', v_max_attempts);
  end if;

  insert into public.id_verification_attempts (session_id, attempts, updated_at)
  values (p_session_id, 1, now())
  on conflict (session_id) do update
    set attempts = id_verification_attempts.attempts + 1,
        updated_at = now();

  select attempts into v_attempts from public.id_verification_attempts where session_id = p_session_id;

  if v_attempts >= v_max_attempts then
    update public.id_verification_attempts set locked_at = now() where session_id = p_session_id;
    return jsonb_build_object('ok', false, 'locked', true, 'attempts_remaining', 0);
  end if;

  return jsonb_build_object('ok', false, 'locked', false, 'attempts_remaining', v_max_attempts - v_attempts);
end;
$$;

grant execute on function public.verify_student_id to anon, authenticated;
