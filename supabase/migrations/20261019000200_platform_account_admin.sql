create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.account_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'blocked')),
  reason text,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
alter table public.account_access enable row level security;
revoke all on public.platform_admins, public.account_access from public, anon, authenticated;
grant select on public.account_access to authenticated;
grant all on public.platform_admins, public.account_access to service_role;

create policy account_access_read_own on public.account_access
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function private.account_is_active(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.account_access a
    where a.user_id = p_user_id and a.status = 'active'
  );
$$;
revoke all on function private.account_is_active(uuid) from public, anon;
grant execute on function private.account_is_active(uuid) to authenticated;

create or replace function private.add_account_access_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.account_access (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

insert into public.account_access (user_id)
select id from auth.users
on conflict (user_id) do nothing;

create trigger on_auth_user_created_add_account_access
after insert on auth.users
for each row execute function private.add_account_access_for_new_user();

insert into public.platform_admins (user_id)
select id from auth.users
where id = '8cdc98a7-1090-453a-98b8-41297958e020'
on conflict (user_id) do nothing;

alter table public.organizations drop constraint organizations_created_by_fkey;
alter table public.organizations
  add constraint organizations_created_by_fkey
  foreign key (created_by) references auth.users (id) on delete cascade;

create or replace function private.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.account_is_active((select auth.uid()))) and exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.can_manage_org(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.account_is_active((select auth.uid()))) and exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function private.can_manage_competition(p_competition_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.account_is_active((select auth.uid()))) and exists (
    select 1
    from public.competitions c
    join public.organization_members m on m.organization_id = c.organization_id
    where c.id = p_competition_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.create_organization(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  if (select auth.uid()) is null or not (select private.account_is_active((select auth.uid()))) then
    raise exception 'Account access is disabled';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Organization name must be between 1 and 120 characters';
  end if;

  insert into public.organizations (name, created_by)
  values (trim(p_name), (select auth.uid()))
  returning id into v_organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_organization_id, (select auth.uid()), 'owner');
  return v_organization_id;
end;
$$;
