-- Adds a 3-attempt / 5-minute-cooldown lockout to both login surfaces.
-- Neither had any brute-force protection before this: admin login only
-- had whatever platform-level throttling Supabase Auth applies, and the
-- gate PIN had none at all beyond "you have to know the PIN" -- unlimited
-- guesses were possible against a 4-6 digit code.

-- ── Admin login: locked by email, not by device ─────────────────────────
-- Locking the account (not the caller) is deliberate -- an attacker who
-- clears local storage or switches devices shouldn't get a fresh set of
-- tries against the same admin account.
create table public.login_attempts (
  email        text primary key,
  attempts     int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- No policies at all -- only ever touched by the SECURITY DEFINER
-- functions below, never queried directly by a client.
alter table public.login_attempts enable row level security;

create or replace function public.login_attempt_status(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked timestamptz;
begin
  select locked_until into v_locked
  from public.login_attempts where email = lower(trim(p_email));

  if v_locked is not null and v_locked > now() then
    return jsonb_build_object('locked', true, 'locked_until', v_locked);
  end if;

  return jsonb_build_object('locked', false);
end;
$$;

grant execute on function public.login_attempt_status to anon, authenticated;

-- Called after every login attempt (success or failure) so the counter
-- lives entirely server-side and can't be reset by refreshing the page.
create or replace function public.record_login_result(p_email text, p_success boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text := lower(trim(p_email));
  v_attempts   int;
  v_locked     timestamptz;
  v_max        constant int := 3;
  v_cooldown   constant interval := '5 minutes';
begin
  if p_success then
    delete from public.login_attempts where email = v_email;
    return jsonb_build_object('locked', false);
  end if;

  select attempts, locked_until into v_attempts, v_locked
  from public.login_attempts where email = v_email;

  -- A previous lock that has since expired starts a fresh count.
  if v_locked is not null and v_locked <= now() then
    v_attempts := 0;
  end if;

  v_attempts := coalesce(v_attempts, 0) + 1;

  if v_attempts >= v_max then
    insert into public.login_attempts (email, attempts, locked_until, updated_at)
    values (v_email, v_attempts, now() + v_cooldown, now())
    on conflict (email) do update
      set attempts = v_attempts, locked_until = now() + v_cooldown, updated_at = now();
    return jsonb_build_object('locked', true, 'locked_until', now() + v_cooldown);
  end if;

  insert into public.login_attempts (email, attempts, locked_until, updated_at)
  values (v_email, v_attempts, null, now())
  on conflict (email) do update
    set attempts = v_attempts, locked_until = null, updated_at = now();

  return jsonb_build_object('locked', false, 'attempts_remaining', v_max - v_attempts);
end;
$$;

grant execute on function public.record_login_result to anon, authenticated;

-- ── Gate PIN: locked globally, since it's one shared secret, not an account ──
-- Locking "the PIN" rather than a per-device counter is deliberate too:
-- a per-device lock is trivially bypassed by clearing storage, which would
-- give an attacker unlimited tries against the one real secret anyway.
-- A global lock only ever blocks *new* unlock attempts -- a device that's
-- already unlocked (PIN cached from a prior session) is unaffected.
alter table public.gate_settings add column failed_pin_attempts int not null default 0;
alter table public.gate_settings add column pin_locked_until timestamptz;

drop function if exists public.verify_gate_pin(text);

create or replace function public.verify_gate_pin(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked    timestamptz;
  v_attempts  int;
  v_correct   boolean;
  v_max       constant int := 3;
  v_cooldown  constant interval := '5 minutes';
begin
  select pin_locked_until, failed_pin_attempts, (pin = p_pin)
  into v_locked, v_attempts, v_correct
  from public.gate_settings where id = true;

  if v_locked is not null and v_locked > now() then
    return jsonb_build_object('ok', false, 'locked', true, 'locked_until', v_locked);
  end if;

  -- Cooldown expired -- this attempt starts a fresh count.
  if v_locked is not null and v_locked <= now() then
    v_attempts := 0;
  end if;

  if v_correct then
    update public.gate_settings set failed_pin_attempts = 0, pin_locked_until = null where id = true;
    return jsonb_build_object('ok', true, 'locked', false);
  end if;

  v_attempts := v_attempts + 1;

  if v_attempts >= v_max then
    update public.gate_settings
      set failed_pin_attempts = v_attempts, pin_locked_until = now() + v_cooldown
      where id = true;
    return jsonb_build_object('ok', false, 'locked', true, 'locked_until', now() + v_cooldown);
  end if;

  update public.gate_settings set failed_pin_attempts = v_attempts, pin_locked_until = null where id = true;
  return jsonb_build_object('ok', false, 'locked', false, 'attempts_remaining', v_max - v_attempts);
end;
$$;

grant execute on function public.verify_gate_pin to anon, authenticated;
