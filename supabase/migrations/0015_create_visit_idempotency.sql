-- Gives create_visit a real idempotency key, so a retried request (the
-- offline outbox resending a walk-in whose original response was lost, or
-- a visitor re-submitting RegisterPage after a slow-connection timeout)
-- returns the visit that already exists instead of creating a duplicate.
-- check_in_visit/check_out_visit were already idempotent by construction
-- (the status='registered'/'checked_in' guard); create_visit never had an
-- equivalent, and the offline outbox replayed it verbatim with no dedup
-- key at all.

alter table public.visits add column idempotency_key uuid;

create unique index visits_idempotency_key_unique
  on public.visits (idempotency_key)
  where idempotency_key is not null;

drop function if exists public.create_visit(text,text,text,text,text,date,public.visit_status,text,jsonb,text);

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
  -- Idempotent replay: this exact attempt already succeeded (the original
  -- response was lost to a dropped connection and the caller retried, or
  -- the offline outbox resent an already-applied queued mutation) --
  -- return the existing row rather than creating a duplicate visit.
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
      -- Could be a colliding qr_token (harmless, loop with a fresh one) or
      -- a genuine concurrent request landing the same idempotency_key
      -- first -- tell those apart so a real race returns the winner's row
      -- instead of retrying forever against the same conflict.
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
