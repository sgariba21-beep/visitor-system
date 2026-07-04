-- Narrows anon read access on visits/visit_students.
--
-- Previously visits_anon_select / visit_students_anon_select granted
-- `using (true)` -- any anon caller (i.e. anyone with the public anon key,
-- which ships in the client bundle) could read every visitor's name, phone
-- number, purpose, and QR token for every day the system has ever run, via
-- a direct PostgREST call, with no filtering required at all.
--
-- Fix: anon can no longer SELECT these tables directly. Every legitimate
-- anon read pattern is replaced with a narrow, purpose-built RPC:
--   - get_visit_by_token: a single visit by its exact QR token (used by
--     the visitor's own QR page, and by the gate's scan lookup). The
--     token itself is the capability here -- this exposes nothing beyond
--     what someone who already holds that one token could already see.
--   - gate_list_today_visits: today's full visit list, for the gate's
--     offline cache warm and manual search. This *is* a broad listing of
--     every visitor's PII for the day, so it's gated behind the gate PIN.

drop policy visits_anon_select on public.visits;
drop policy visit_students_anon_select on public.visit_students;

create or replace function public.get_visit_by_token(p_qr_token text)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select to_jsonb(v) || jsonb_build_object(
    'visit_students', coalesce(
      (select jsonb_agg(to_jsonb(vs)) from public.visit_students vs where vs.visit_id = v.id),
      '[]'::jsonb
    )
  )
  from public.visits v
  where v.qr_token = p_qr_token;
$$;

grant execute on function public.get_visit_by_token to anon, authenticated;

create or replace function public.gate_list_today_visits(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    -- Institution-local "today", computed server-side rather than trusting
    -- whatever date string the client happens to send. Step 4 applies the
    -- same convention to the mutating RPCs (check_in_visit/create_visit).
    where v.visit_date = (now() at time zone 'Africa/Accra')::date
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.gate_list_today_visits to anon, authenticated;
