-- Let a blocked user see the access change immediately in an already-open session.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'account_access'
  ) then
    alter publication supabase_realtime add table public.account_access;
  end if;
end;
$$;
