create or replace function public.check_in_visit(p_qr_token text)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits;
begin
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

create or replace function public.check_out_visit(p_qr_token text)
returns public.visits
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits;
begin
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
