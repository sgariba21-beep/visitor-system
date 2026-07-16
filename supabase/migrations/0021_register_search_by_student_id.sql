-- Replaces RegisterPage's two-step "search by name, then confirm Student ID"
-- flow with a single "search by Student ID" step.
--
-- Searching by name only requires public information (a child's name is not
-- a secret), so the old flow needed a second, separate ID-confirmation step
-- to prove the visitor actually knows the student. Searching by ID directly
-- means that knowledge is required just to find the student at all, so the
-- separate confirmation step is redundant once the search itself is gated
-- on the ID.
--
-- Critically, this must NOT be a fuzzy/substring search like
-- search_active_students -- returning matches for partial ID input would
-- leak which digits are correct (and give an attacker unlimited free
-- guesses). So this function only ever matches a full (normalized) ID.
--
-- Also switches the lockout from 0013's permanent "visit the office" style
-- (locked_at, never expires on its own) to the 5-minute cooldown pattern
-- already used by login/gate-PIN lockouts (see 0019_login_lockouts) --
-- a visitor who mistypes a still-correct ID a few times shouldn't be stuck
-- until a staff member intervenes, but repeated fast guessing is still
-- throttled.

drop function if exists public.verify_student_id(text, uuid, text);

alter table public.id_verification_attempts rename column locked_at to locked_until;

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
  v_attempts     int;
  v_locked       timestamptz;
  v_max_attempts constant int := 3;
  v_cooldown     constant interval := '5 minutes';
  -- Same normalization as the old verify_student_id: ignore whitespace,
  -- dashes, and case so "STU-001", "STU 001", and "stu001" all match.
  v_norm_guess   text := lower(regexp_replace(coalesce(p_guess, ''), '[\s-]', '', 'g'));
  v_student      record;
begin
  select attempts, locked_until into v_attempts, v_locked
  from public.id_verification_attempts where session_id = p_session_id;

  if v_locked is not null and v_locked > now() then
    return jsonb_build_object('ok', false, 'locked', true, 'locked_until', v_locked);
  end if;

  -- A previous lock that has since expired starts a fresh count.
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
    insert into public.id_verification_attempts (session_id, attempts, locked_until, updated_at)
    values (p_session_id, v_attempts, now() + v_cooldown, now())
    on conflict (session_id) do update
      set attempts = v_attempts, locked_until = now() + v_cooldown, updated_at = now();
    return jsonb_build_object('ok', false, 'locked', true, 'locked_until', now() + v_cooldown);
  end if;

  insert into public.id_verification_attempts (session_id, attempts, locked_until, updated_at)
  values (p_session_id, v_attempts, null, now())
  on conflict (session_id) do update
    set attempts = v_attempts, locked_until = null, updated_at = now();

  return jsonb_build_object('ok', false, 'locked', false, 'attempts_remaining', v_max_attempts - v_attempts);
end;
$$;

grant execute on function public.search_student_by_id to anon, authenticated;
