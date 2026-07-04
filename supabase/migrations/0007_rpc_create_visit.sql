create or replace function public.create_visit(
  p_visitor_name   text,
  p_visitor_phone  text,
  p_relationship   text,
  p_purpose        text,
  p_purpose_other  text,
  p_visit_date     date,
  p_status         public.visit_status,   -- 'registered' (RegisterPage) or 'checked_in' (walk-in)
  p_created_by     text,                  -- 'self' or 'gate_staff'
  p_students       jsonb                  -- [{"student_id": "uuid-or-null", "student_name": "...", "class": "..."}, ...]
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
