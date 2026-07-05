-- Two independent fixes bundled together:
--
-- 1. create_visit accepted any student_id (or none at all) with no check
--    that it actually referred to an existing, active student -- the UI
--    only ever offers active students, but nothing stopped a direct API
--    call (or a stale cached search result for a just-deactivated
--    student) from registering a visit against one that shouldn't be
--    selectable anymore.
--
-- 2. gate_list_today_visits was hardcoded to "today", so the gate's
--    manual search had no way to find a visitor whose registered date
--    didn't match the gate device's idea of today -- which is exactly
--    the case where a scanned QR gets rejected and staff are told to
--    "use manual lookup," a dead end for that specific failure. Renamed
--    to gate_list_visits and given an optional date (defaulting to
--    today, preserving the cache-warm use case unchanged).

drop function if exists public.gate_list_today_visits(text);

create or replace function public.gate_list_visits(p_pin text, p_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date date := coalesce(p_date, (now() at time zone 'Africa/Accra')::date);
begin
  if not exists (select 1 from public.gate_settings where id = true and pin = p_pin) then
    raise exception 'Incorrect gate PIN' using errcode = 'P0005';
  end if;

  return coalesce((
    select jsonb_agg(
      to_jsonb(v) || jsonb_build_object(
        'visit_students', coalesce(
          (select jsonb_agg(to_jsonb(vs)) from public.visit_students vs where vs.visit_id = v.id),
          '[]'::jsonb
        )
      )
    )
    from public.visits v
    where v.visit_date = v_date
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.gate_list_visits to anon, authenticated;

create or replace function public.create_visit(
  p_visitor_name    text,
  p_visitor_phone   text,
  p_relationship    text,
  p_purpose         text,
  p_purpose_other   text,
  p_visit_date      date,
  p_status          public.visit_status,
  p_created_by      text,
  p_students        jsonb,
  p_pin             text default null,
  p_idempotency_key uuid default null
)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit       public.visits;
  v_existing    public.visits;
  v_token       text;
  v_attempt     int := 0;
  v_now         timestamptz := now();
  v_today       date := (now() at time zone 'Africa/Accra')::date;
  v_visit_date  date;
begin
  if p_idempotency_key is not null then
    select * into v_existing from public.visits where idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      return v_existing;
    end if;
  end if;

  if p_created_by = 'gate_staff' then
    if p_pin is null or not exists (select 1 from public.gate_settings where id = true and pin = p_pin) then
      raise exception 'Incorrect gate PIN' using errcode = 'P0005';
    end if;
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

  -- Every referenced student_id must exist and still be active -- the UI
  -- only ever offers active students, but this closes the gap for a
  -- direct API call or a stale cached selection.
  if exists (
    select 1
    from jsonb_array_elements(p_students) as s
    where nullif(s->>'student_id', '') is not null
      and not exists (
        select 1 from public.students st
        where st.id = (s->>'student_id')::uuid and st.is_active = true
      )
  ) then
    raise exception 'One or more selected students are no longer active' using errcode = 'P0007';
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
        checked_in_at, created_by, idempotency_key
      ) values (
        p_visitor_name, p_visitor_phone,
        coalesce(nullif(p_relationship, ''), 'Not specified'),
        p_purpose,
        case when p_purpose = 'Other' then p_purpose_other else '' end,
        v_visit_date, p_status, v_token, v_now,
        case when p_status = 'checked_in' then v_now else null end,
        p_created_by, p_idempotency_key
      )
      returning * into v_visit;

      exit; -- insert succeeded, break out of retry loop
    exception when unique_violation then
      if p_idempotency_key is not null then
        select * into v_existing from public.visits where idempotency_key = p_idempotency_key;
        if v_existing.id is not null then
          return v_existing;
        end if;
      end if;

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
