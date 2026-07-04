-- Hardens the gate PIN.
--
-- Previously: gate_settings.pin was anon-readable directly (`using (true)`),
-- and create_visit / check_in_visit / check_out_visit executed with no PIN
-- check at all inside the function. That made the /gate PIN screen a pure
-- client-side UI gate -- anyone with the anon key could bypass it entirely
-- by calling the RPCs directly, or simply read the real PIN out of the
-- table without ever needing to guess it.
--
-- Fix: anon can no longer read the pin column. Every gate-originated
-- mutation now carries the PIN and checks it live, server-side, on each
-- call -- so a PIN rotation takes effect on the very next action from any
-- device, with no session/token bookkeeping to invalidate.

drop policy gate_settings_anon_select on public.gate_settings;

-- Lightweight immediate-feedback check for the PIN entry screen. Returns
-- only true/false -- the stored PIN itself is never sent back to the client.
-- The client caches the PIN locally only after this confirms it correct,
-- which is how offline PIN re-entry keeps working (see src/lib/offlineSync.js).
create or replace function public.verify_gate_pin(p_pin text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.gate_settings where id = true and pin = p_pin);
$$;

grant execute on function public.verify_gate_pin to anon, authenticated;

-- ── check_in_visit / check_out_visit: add a required p_pin, checked live ──
drop function if exists public.check_in_visit(text);
drop function if exists public.check_out_visit(text);

create or replace function public.check_in_visit(p_qr_token text, p_pin text)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits;
begin
  if not exists (select 1 from public.gate_settings where id = true and pin = p_pin) then
    raise exception 'Incorrect gate PIN' using errcode = 'P0005';
  end if;

  update public.visits
  set status = 'checked_in', checked_in_at = now()
  where qr_token = p_qr_token
    and status = 'registered'
  returning * into v_visit;

  if v_visit.id is null then
    if exists (select 1 from public.visits where qr_token = p_qr_token) then
      raise exception 'Visit already checked in or checked out' using errcode = 'P0001';
    else
      raise exception 'No visit found for token %', p_qr_token using errcode = 'P0002';
    end if;
  end if;

  return v_visit;
end;
$$;

create or replace function public.check_out_visit(p_qr_token text, p_pin text)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits;
begin
  if not exists (select 1 from public.gate_settings where id = true and pin = p_pin) then
    raise exception 'Incorrect gate PIN' using errcode = 'P0005';
  end if;

  update public.visits
  set status = 'checked_out', checked_out_at = now()
  where qr_token = p_qr_token
    and status = 'checked_in'
  returning * into v_visit;

  if v_visit.id is null then
    if exists (select 1 from public.visits where qr_token = p_qr_token) then
      raise exception 'Visit is not currently checked in' using errcode = 'P0001';
    else
      raise exception 'No visit found for token %', p_qr_token using errcode = 'P0002';
    end if;
  end if;

  return v_visit;
end;
$$;

grant execute on function public.check_in_visit to anon, authenticated;
grant execute on function public.check_out_visit to anon, authenticated;

-- ── create_visit: PIN required only for gate-staff-created walk-ins ──
-- Self-registration (p_created_by = 'self', from the public RegisterPage)
-- stays PIN-free, since it was never a gate-only action.
drop function if exists public.create_visit(text,text,text,text,text,date,public.visit_status,text,jsonb);

create or replace function public.create_visit(
  p_visitor_name   text,
  p_visitor_phone  text,
  p_relationship   text,
  p_purpose        text,
  p_purpose_other  text,
  p_visit_date     date,
  p_status         public.visit_status,
  p_created_by     text,
  p_students       jsonb,
  p_pin            text default null
)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit      public.visits;
  v_token      text;
  v_attempt    int := 0;
  v_now        timestamptz := now();
begin
  if p_created_by = 'gate_staff' then
    if p_pin is null or not exists (select 1 from public.gate_settings where id = true and pin = p_pin) then
      raise exception 'Incorrect gate PIN' using errcode = 'P0005';
    end if;
  end if;

  if jsonb_array_length(p_students) = 0 then
    raise exception 'At least one student is required';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_token := 'VIS-' || (
      select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
             (floor(random() * 32) + 1)::int, 1), '')
      from generate_series(1, 6)
    );

    begin
      insert into public.visits (
        visitor_name, visitor_phone, relationship, purpose, purpose_other,
        visit_date, status, qr_token, registered_at,
        checked_in_at, created_by
      ) values (
        p_visitor_name, p_visitor_phone,
        coalesce(nullif(p_relationship, ''), 'Not specified'),
        p_purpose,
        case when p_purpose = 'Other' then p_purpose_other else '' end,
        p_visit_date, p_status, v_token, v_now,
        case when p_status = 'checked_in' then v_now else null end,
        p_created_by
      )
      returning * into v_visit;

      exit; -- insert succeeded, break out of retry loop
    exception when unique_violation then
      if v_attempt >= 5 then
        raise exception 'Could not generate a unique QR token after % attempts', v_attempt;
      end if;
      -- loop again with a freshly generated token
    end;
  end loop;

  insert into public.visit_students (visit_id, student_id, student_name, class)
  select
    v_visit.id,
    nullif(s->>'student_id', '')::uuid,
    s->>'student_name',
    s->>'class'
  from jsonb_array_elements(p_students) as s;

  return v_visit;
end;
$$;

grant execute on function public.create_visit to anon, authenticated;
