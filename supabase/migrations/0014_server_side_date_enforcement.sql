-- Moves "valid only on the visit's calendar day" server-side.
--
-- Previously this was checked only in GatePage.jsx by comparing the
-- visit's stored date against `new Date().toISOString().split("T")[0]`
-- computed on whatever device happened to be running the gate app --
-- never verified by the database. Anyone calling check_in_visit directly
-- (or a device with a wrong clock/timezone) could check in a visit on a
-- day it was never valid for. create_visit similarly never validated that
-- p_visit_date was reasonable at all.
--
-- Fix: check_in_visit now requires the visit's date to match "today" as
-- computed by the database itself (Africa/Accra, the institution's own
-- timezone -- not any client's clock), with a distinct errcode so the
-- gate UI can show an accurate message instead of a generic failure.
-- create_visit rejects an implausible p_visit_date for advance
-- registrations, and -- since a walk-in is by definition happening right
-- now -- ignores whatever date a gate device's client-side clock sends
-- and stamps the server's own "today" instead, removing any clock-skew
-- failure mode for walk-ins entirely.

create or replace function public.check_in_visit(p_qr_token text, p_pin text)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit    public.visits;
  v_existing public.visits;
  v_today    date := (now() at time zone 'Africa/Accra')::date;
begin
  if not exists (select 1 from public.gate_settings where id = true and pin = p_pin) then
    raise exception 'Incorrect gate PIN' using errcode = 'P0005';
  end if;

  select * into v_existing from public.visits where qr_token = p_qr_token;

  if v_existing.id is null then
    raise exception 'No visit found for token %', p_qr_token using errcode = 'P0002';
  end if;

  if v_existing.status <> 'registered' then
    raise exception 'Visit already checked in or checked out' using errcode = 'P0001';
  end if;

  if v_existing.visit_date <> v_today then
    raise exception 'Visit is scheduled for a different date' using errcode = 'P0003';
  end if;

  update public.visits
  set status = 'checked_in', checked_in_at = now()
  where qr_token = p_qr_token
    and status = 'registered'
  returning * into v_visit;

  if v_visit.id is null then
    -- Lost a race with a concurrent check-in of the same code between the
    -- checks above and this update -- report it accurately either way.
    raise exception 'Visit already checked in or checked out' using errcode = 'P0001';
  end if;

  return v_visit;
end;
$$;

grant execute on function public.check_in_visit to anon, authenticated;

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
  v_visit       public.visits;
  v_token       text;
  v_attempt     int := 0;
  v_now         timestamptz := now();
  v_today       date := (now() at time zone 'Africa/Accra')::date;
  v_visit_date  date;
begin
  if p_created_by = 'gate_staff' then
    if p_pin is null or not exists (select 1 from public.gate_settings where id = true and pin = p_pin) then
      raise exception 'Incorrect gate PIN' using errcode = 'P0005';
    end if;
    -- A walk-in is happening right now, at the gate -- use the server's
    -- own clock rather than trusting whatever date a client sent, so a
    -- gate device with a wrong clock/timezone can never fail (or falsely
    -- succeed) a walk-in over a date disagreement.
    v_visit_date := v_today;
  else
    v_visit_date := p_visit_date;
    if v_visit_date < v_today then
      raise exception 'Visit date cannot be in the past' using errcode = 'P0006';
    end if;
    if v_visit_date > v_today + 365 then
      raise exception 'Visit date is too far in the future' using errcode = 'P0006';
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
        v_visit_date, p_status, v_token, v_now,
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
