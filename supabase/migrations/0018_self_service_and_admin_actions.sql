-- Closes three friction gaps identified in review:
--
-- 1. A parent who loses their QR (or needs to cancel) had no self-service
--    path — the only advertised fallback was "staff can look you up
--    manually," which requires already being at the gate. find_my_visit
--    lets a parent look up their own registration by phone + visit date
--    (both must already be known, so this isn't a broad lookup), and
--    cancel_visit lets them cancel a not-yet-arrived registration the
--    same way, verified against that same phone number.
--
-- 2. Gate staff had no way to force-close a visit nobody remembered to
--    check out, short of going into the Supabase dashboard directly.
--    admin_force_checkout gives admin a real button for this.
--
-- 3. Admin had no way to help a parent who lost their QR before they
--    arrive — VisitsPage will gain a "show/resend QR" action reusing the
--    visit's existing qr_token.

alter table public.visits add column cancelled_at timestamptz;
alter table public.visits add column checked_out_by text;

-- ── check_in_visit: also reject a cancelled registration ──
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

  if v_existing.cancelled_at is not null then
    raise exception 'This visit was cancelled by the visitor' using errcode = 'P0004';
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
    raise exception 'Visit already checked in or checked out' using errcode = 'P0001';
  end if;

  return v_visit;
end;
$$;

grant execute on function public.check_in_visit to anon, authenticated;

-- ── check_out_visit: tag a normal gate checkout distinctly from a forced one ──
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
  set status = 'checked_out', checked_out_at = now(), checked_out_by = 'gate'
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

grant execute on function public.check_out_visit to anon, authenticated;

-- ── find_my_visit: a parent's self-service lookup by phone + date ──
-- Requires knowing both the exact phone number on file and the visit
-- date, same trust level as get_visit_by_token's "you already hold the
-- capability" pattern — this is not a broad, guessable listing.
create or replace function public.find_my_visit(p_visitor_phone text, p_visit_date date)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    jsonb_agg(
      to_jsonb(v) || jsonb_build_object(
        'visit_students', coalesce(
          (select jsonb_agg(to_jsonb(vs)) from public.visit_students vs where vs.visit_id = v.id),
          '[]'::jsonb
        )
      )
      order by v.registered_at desc
    ),
    '[]'::jsonb
  )
  from public.visits v
  where v.visitor_phone = p_visitor_phone and v.visit_date = p_visit_date;
$$;

grant execute on function public.find_my_visit to anon, authenticated;

-- ── cancel_visit: self-service cancel, gated by the same phone number ──
create or replace function public.cancel_visit(p_visit_id uuid, p_visitor_phone text)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits;
begin
  update public.visits
  set cancelled_at = now()
  where id = p_visit_id
    and visitor_phone = p_visitor_phone
    and status = 'registered'
    and cancelled_at is null
  returning * into v_visit;

  if v_visit.id is null then
    raise exception 'Visit not found, already cancelled, or already arrived' using errcode = 'P0009';
  end if;

  return v_visit;
end;
$$;

grant execute on function public.cancel_visit to anon, authenticated;

-- ── admin_force_checkout: close a stale checked_in visit nobody scanned out ──
create or replace function public.admin_force_checkout(p_visit_id uuid)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits;
begin
  update public.visits
  set status = 'checked_out', checked_out_at = now(), checked_out_by = 'admin'
  where id = p_visit_id and status = 'checked_in'
  returning * into v_visit;

  if v_visit.id is null then
    raise exception 'Visit is not currently checked in' using errcode = 'P0001';
  end if;

  return v_visit;
end;
$$;

-- Admin-only -- see 0017's note: both Postgres's PUBLIC-execute default
-- and Supabase's own default privileges (which grant anon/authenticated
-- directly) have to be revoked, or this "admin-only" RPC stays callable
-- by anon regardless of the grant below.
revoke execute on function public.admin_force_checkout from public;
revoke execute on function public.admin_force_checkout from anon;
grant execute on function public.admin_force_checkout to authenticated;
