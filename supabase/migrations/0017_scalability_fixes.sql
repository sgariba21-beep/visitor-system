-- Three independent scalability fixes bundled together:
--
-- 1. VisitsPage fetched every visit in the selected date range with no
--    limit, then did status/purpose/text filtering in the browser. As
--    visit history grows across school terms with no archiving policy,
--    a wide date range would ship the whole table to an admin's tab.
--    admin_search_visits does date/status/purpose/text filtering and
--    pagination server-side in one query (the free-text OR across the
--    visits table and the joined visit_students table is awkward to
--    express through the JS query builder, so it's a plain SQL RPC).
--
-- 2. StudentsPage's CSV import inserted one row per round-trip in a
--    sequential loop -- a few hundred rows meant a few hundred HTTP
--    calls with the tab held open. bulk_import_students does the whole
--    batch in one call, skipping duplicate IDs per-row without aborting
--    the batch (same pattern as create_visit's token-collision retry).
--
-- 3. create_visit had no rate limiting, so the open, anon-callable
--    self-registration endpoint could be scripted into a spam burst that
--    directly inflates the same visits table admin_search_visits above
--    now protects against runaway growth of. A lightweight per-device
--    counter (client-supplied token, not IP-based -- there's no reverse
--    proxy here to make IP tracking meaningful) throttles registration
--    bursts without needing new infrastructure; if real abuse is ever
--    observed, a CAPTCHA is the natural next escalation, not the
--    starting point for a single-school app.

create table public.create_visit_rate_limit (
  client_key   text primary key,
  window_start timestamptz not null default now(),
  count        int not null default 1
);

-- No policies at all: only ever touched by create_visit (SECURITY DEFINER).
alter table public.create_visit_rate_limit enable row level security;

drop function if exists public.create_visit(text,text,text,text,text,date,public.visit_status,text,jsonb,text,uuid);

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
  p_idempotency_key uuid default null,
  p_client_token    text default null
)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit        public.visits;
  v_existing     public.visits;
  v_token        text;
  v_attempt      int := 0;
  v_now          timestamptz := now();
  v_today        date := (now() at time zone 'Africa/Accra')::date;
  v_visit_date   date;
  v_rl_window    timestamptz;
  v_rl_count     int;
  v_rl_key       text;
  v_rl_max       constant int := 10;
  v_rl_window_len constant interval := '10 minutes';
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
    -- Rate limit only the open, anon-callable self-registration path --
    -- walk-ins are already gated behind the gate PIN, a legitimate staff
    -- action, not something to throttle.
    v_rl_key := coalesce(p_client_token, 'unknown');

    select window_start, count into v_rl_window, v_rl_count
    from public.create_visit_rate_limit where client_key = v_rl_key;

    if v_rl_window is null then
      insert into public.create_visit_rate_limit (client_key, window_start, count)
      values (v_rl_key, v_now, 1);
    elsif v_rl_window < v_now - v_rl_window_len then
      update public.create_visit_rate_limit set window_start = v_now, count = 1 where client_key = v_rl_key;
    elsif v_rl_count >= v_rl_max then
      raise exception 'Too many registration attempts from this device. Please try again later.' using errcode = 'P0008';
    else
      update public.create_visit_rate_limit set count = count + 1 where client_key = v_rl_key;
    end if;

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

      exit;
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

-- ── admin_search_visits: server-side filtering + pagination for VisitsPage ──
create or replace function public.admin_search_visits(
  p_date_from date,
  p_date_to   date,
  p_status    text default null,
  p_purpose   text default null,
  p_query     text default null,
  p_limit     int default 50,
  p_offset    int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_query text := nullif(replace(replace(trim(coalesce(p_query, '')), '%', '\%'), '_', '\_'), '');
  v_total int;
  v_on_campus int;
  v_departed int;
  v_not_arrived int;
  v_rows jsonb;
begin
  select
    count(*),
    count(*) filter (where v.status = 'checked_in'),
    count(*) filter (where v.status = 'checked_out'),
    count(*) filter (where v.status = 'registered')
  into v_total, v_on_campus, v_departed, v_not_arrived
  from public.visits v
  where v.visit_date between p_date_from and p_date_to
    and (p_status is null or v.status::text = p_status)
    and (p_purpose is null or v.purpose = p_purpose)
    and (
      v_query is null
      or v.visitor_name ilike '%' || v_query || '%' escape '\'
      or v.visitor_phone ilike '%' || v_query || '%' escape '\'
      or exists (
        select 1 from public.visit_students vs
        where vs.visit_id = v.id and vs.student_name ilike '%' || v_query || '%' escape '\'
      )
    );

  select coalesce(jsonb_agg(row_data), '[]'::jsonb) into v_rows
  from (
    select to_jsonb(v) || jsonb_build_object(
      'visit_students', coalesce(
        (select jsonb_agg(to_jsonb(vs)) from public.visit_students vs where vs.visit_id = v.id),
        '[]'::jsonb
      )
    ) as row_data
    from public.visits v
    where v.visit_date between p_date_from and p_date_to
      and (p_status is null or v.status::text = p_status)
      and (p_purpose is null or v.purpose = p_purpose)
      and (
        v_query is null
        or v.visitor_name ilike '%' || v_query || '%' escape '\'
        or v.visitor_phone ilike '%' || v_query || '%' escape '\'
        or exists (
          select 1 from public.visit_students vs
          where vs.visit_id = v.id and vs.student_name ilike '%' || v_query || '%' escape '\'
        )
      )
    order by v.visit_date desc, v.registered_at desc
    limit p_limit offset p_offset
  ) sub;

  return jsonb_build_object(
    'total', v_total,
    'on_campus', v_on_campus,
    'departed', v_departed,
    'not_arrived', v_not_arrived,
    'rows', v_rows
  );
end;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, AND
-- Supabase's default privileges on the public schema separately grant
-- execute to anon/authenticated directly. Without both explicit revokes
-- below, the `grant ... to authenticated` above would NOT actually be
-- restrictive: anon could still call this "admin-only" RPC regardless of
-- the intended grant. (Caught by testing this migration against the live
-- anon key before shipping it.)
revoke execute on function public.admin_search_visits from public;
revoke execute on function public.admin_search_visits from anon;
grant execute on function public.admin_search_visits to authenticated;

-- ── bulk_import_students: one round trip instead of one per row ──
create or replace function public.bulk_import_students(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     jsonb;
  v_added   int := 0;
  v_skipped int := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    if coalesce(trim(v_row->>'name'), '') = '' or coalesce(trim(v_row->>'class'), '') = '' then
      continue;
    end if;

    begin
      insert into public.students (name, class, student_id)
      values (
        trim(v_row->>'name'),
        trim(v_row->>'class'),
        nullif(trim(coalesce(v_row->>'studentId', '')), '')
      );
      v_added := v_added + 1;
    exception when unique_violation then
      v_skipped := v_skipped + 1;
    end;
  end loop;

  return jsonb_build_object('added', v_added, 'skipped', v_skipped);
end;
$$;

-- Same PUBLIC- and Supabase-default gotcha as admin_search_visits above.
revoke execute on function public.bulk_import_students from public;
revoke execute on function public.bulk_import_students from anon;
grant execute on function public.bulk_import_students to authenticated;
