-- Escalates the Student ID search lockout within a single browser session
-- (tracked by the same sessionStorage-held session_id used since 0013)
-- instead of a flat 5-minute cooldown every time: 1st lockout = 1 minute,
-- 2nd = 3 minutes, 3rd = 5 minutes, 4th = 7 minutes, etc. (1 + (n-1)*2).
--
-- lockout_count only resets when the row is deleted -- i.e. on a
-- successful ID match -- so a visitor who eventually finds their correct
-- ID isn't penalized afterwards, but repeated failure cycles within the
-- same session keep getting slower to discourage sustained guessing.

alter table public.id_verification_attempts add column lockout_count int not null default 0;

create or replace function public.search_student_by_id(
  p_session_id text,
  p_guess       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts       int;
  v_locked         timestamptz;
  v_lockout_count  int;
  v_max_attempts   constant int := 3;
  v_cooldown       interval;
  -- Same normalization as before: ignore whitespace, dashes, and case so
  -- "STU-001", "STU 001", and "stu001" all match.
  v_norm_guess     text := lower(regexp_replace(coalesce(p_guess, ''), '[\s-]', '', 'g'));
  v_student        record;
begin
  select attempts, locked_until, lockout_count into v_attempts, v_locked, v_lockout_count
  from public.id_verification_attempts where session_id = p_session_id;

  if v_locked is not null and v_locked > now() then
    return jsonb_build_object('ok', false, 'locked', true, 'locked_until', v_locked);
  end if;

  -- A previous lock that has since expired starts a fresh attempt count --
  -- lockout_count is deliberately NOT reset here, so the next lockout in
  -- this session escalates further.
  if v_locked is not null and v_locked <= now() then
    v_attempts := 0;
  end if;

  if v_norm_guess = '' then
    return jsonb_build_object(
      'ok', false, 'locked', false,
      'attempts_remaining', v_max_attempts - coalesce(v_attempts, 0)
    );
  end if;

  select s.id, s.name, s.class into v_student
  from public.students s
  where s.is_active = true
    and s.student_id is not null and s.student_id <> ''
    and lower(regexp_replace(s.student_id, '[\s-]', '', 'g')) = v_norm_guess
  limit 1;

  if v_student.id is not null then
    delete from public.id_verification_attempts where session_id = p_session_id;
    return jsonb_build_object(
      'ok', true,
      'student', jsonb_build_object('id', v_student.id, 'name', v_student.name, 'class', v_student.class)
    );
  end if;

  v_attempts := coalesce(v_attempts, 0) + 1;

  if v_attempts >= v_max_attempts then
    v_lockout_count := coalesce(v_lockout_count, 0) + 1;
    v_cooldown := ((1 + (v_lockout_count - 1) * 2) || ' minutes')::interval;

    insert into public.id_verification_attempts (session_id, attempts, locked_until, lockout_count, updated_at)
    values (p_session_id, v_attempts, now() + v_cooldown, v_lockout_count, now())
    on conflict (session_id) do update
      set attempts = v_attempts, locked_until = now() + v_cooldown,
          lockout_count = v_lockout_count, updated_at = now();
    return jsonb_build_object('ok', false, 'locked', true, 'locked_until', now() + v_cooldown);
  end if;

  insert into public.id_verification_attempts (session_id, attempts, locked_until, lockout_count, updated_at)
  values (p_session_id, v_attempts, null, coalesce(v_lockout_count, 0), now())
  on conflict (session_id) do update
    set attempts = v_attempts, locked_until = null, updated_at = now();

  return jsonb_build_object('ok', false, 'locked', false, 'attempts_remaining', v_max_attempts - v_attempts);
end;
$$;

grant execute on function public.search_student_by_id to anon, authenticated;
