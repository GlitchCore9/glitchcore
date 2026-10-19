create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 160),
  min_score integer not null default 1 check (min_score between 0 and 100),
  max_score integer not null default 5 check (max_score between 1 and 100 and max_score > min_score),
  status text not null default 'draft' check (status in ('draft', 'open', 'paused', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  position integer not null check (position > 0),
  unique (competition_id, position) deferrable initially deferred,
  unique (id, competition_id)
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions (id) on delete cascade,
  surname text not null check (length(trim(surname)) between 1 and 120),
  given_name text not null check (length(trim(given_name)) between 1 and 120),
  age integer not null check (age between 1 and 120),
  position integer not null check (position > 0),
  unique (competition_id, position) deferrable initially deferred,
  unique (id, competition_id)
);

create table public.judges (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  token_hash text not null unique,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (id, competition_id)
);

create table public.votes (
  competition_id uuid not null references public.competitions (id) on delete cascade,
  judge_id uuid not null,
  participant_id uuid not null,
  category_id uuid not null,
  score integer not null check (score between 0 and 100),
  created_at timestamptz not null default now(),
  primary key (judge_id, participant_id, category_id),
  foreign key (judge_id, competition_id) references public.judges (id, competition_id) on delete cascade,
  foreign key (participant_id, competition_id) references public.participants (id, competition_id) on delete cascade,
  foreign key (category_id, competition_id) references public.categories (id, competition_id) on delete cascade
);

create index competitions_org_id_idx on public.competitions (organization_id);
create index judges_competition_id_idx on public.judges (competition_id);
create index votes_competition_id_idx on public.votes (competition_id);

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.competitions enable row level security;
alter table public.categories enable row level security;
alter table public.participants enable row level security;
alter table public.judges enable row level security;
alter table public.votes enable row level security;

revoke all on public.organizations, public.organization_members, public.competitions,
  public.categories, public.participants, public.judges, public.votes from anon, authenticated;
grant select, insert, update, delete on public.organizations, public.organization_members,
  public.competitions, public.categories, public.participants, public.judges, public.votes to authenticated;
grant all on public.organizations, public.organization_members, public.competitions,
  public.categories, public.participants, public.judges, public.votes to service_role;

create index organization_members_user_id_idx on public.organization_members (user_id);
create index categories_competition_position_idx on public.categories (competition_id, position);
create index participants_competition_position_idx on public.participants (competition_id, position);

create or replace function private.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
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
  select exists (
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
  select exists (
    select 1
    from public.competitions c
    join public.organization_members m on m.organization_id = c.organization_id
    where c.id = p_competition_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

revoke all on function private.is_org_member(uuid) from public, anon;
revoke all on function private.can_manage_org(uuid) from public, anon;
revoke all on function private.can_manage_competition(uuid) from public, anon;
grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.can_manage_org(uuid) to authenticated;
grant execute on function private.can_manage_competition(uuid) to authenticated;

create or replace function public.create_organization(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
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

create policy organizations_read on public.organizations
  for select to authenticated using ((select private.is_org_member(id)));
create policy organizations_create on public.organizations
  for insert to authenticated with check (created_by = (select auth.uid()));
create policy organizations_update on public.organizations
  for update to authenticated using ((select private.can_manage_org(id)))
  with check ((select private.can_manage_org(id)));
create policy organizations_delete on public.organizations
  for delete to authenticated using ((select private.can_manage_org(id)));

create policy organization_members_read on public.organization_members
  for select to authenticated using ((select private.is_org_member(organization_id)));
create policy organization_members_add on public.organization_members
  for insert to authenticated with check ((select private.can_manage_org(organization_id)) and role <> 'owner');
create policy organization_members_update on public.organization_members
  for update to authenticated using ((select private.can_manage_org(organization_id)) and role <> 'owner')
  with check ((select private.can_manage_org(organization_id)) and role <> 'owner');
create policy organization_members_remove on public.organization_members
  for delete to authenticated using ((select private.can_manage_org(organization_id)) and role <> 'owner');

create policy competitions_read on public.competitions
  for select to authenticated using ((select private.can_manage_org(organization_id)));
create policy competitions_create on public.competitions
  for insert to authenticated with check ((select private.can_manage_org(organization_id)));
create policy competitions_update on public.competitions
  for update to authenticated using ((select private.can_manage_org(organization_id)))
  with check ((select private.can_manage_org(organization_id)));
create policy competitions_delete on public.competitions
  for delete to authenticated using ((select private.can_manage_org(organization_id)));

create policy categories_manage on public.categories
  for all to authenticated using ((select private.can_manage_competition(competition_id)))
  with check ((select private.can_manage_competition(competition_id)));
create policy participants_manage on public.participants
  for all to authenticated using ((select private.can_manage_competition(competition_id)))
  with check ((select private.can_manage_competition(competition_id)));
create policy judges_manage on public.judges
  for all to authenticated using ((select private.can_manage_competition(competition_id)))
  with check ((select private.can_manage_competition(competition_id)));
create policy votes_manage on public.votes
  for all to authenticated using ((select private.can_manage_competition(competition_id)))
  with check ((select private.can_manage_competition(competition_id)));

create or replace function public.create_judge_link(p_competition_id uuid, p_name text, p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_judge_id uuid;
begin
  if not (select private.can_manage_competition(p_competition_id)) then
    raise exception 'Competition access denied';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'Judge name must be between 1 and 120 characters';
  end if;
  if length(coalesce(p_token, '')) < 32 then raise exception 'Judge token is invalid'; end if;

  insert into public.judges (competition_id, name, token_hash)
  values (p_competition_id, trim(p_name), encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex'))
  returning id into v_judge_id;
  return v_judge_id;
end;
$$;

create or replace function public.rotate_judge_link(p_judge_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_competition_id uuid;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  select j.competition_id into v_competition_id
  from public.judges j where j.id = p_judge_id for update;
  if v_competition_id is null or not (select private.can_manage_competition(v_competition_id)) then
    raise exception 'Judge access denied';
  end if;

  delete from public.votes where judge_id = p_judge_id;
  update public.judges
  set token_hash = encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'), submitted_at = null
  where id = p_judge_id;
  return v_token;
end;
$$;

create or replace function public.save_competition_setup(
  p_competition_id uuid,
  p_title text,
  p_min_score integer,
  p_max_score integer,
  p_status text,
  p_categories jsonb,
  p_participants jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.can_manage_competition(p_competition_id)) then
    raise exception 'Competition access denied';
  end if;
  if length(trim(coalesce(p_title, ''))) not between 1 and 160 then
    raise exception 'Title must be between 1 and 160 characters';
  end if;
  if p_min_score is null or p_max_score is null or p_min_score < 0 or p_max_score > 100 or p_max_score <= p_min_score then
    raise exception 'Invalid score range';
  end if;
  if p_status not in ('draft', 'open', 'paused', 'closed') then raise exception 'Invalid status'; end if;
  if jsonb_typeof(p_categories) <> 'array' or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'Categories and participants must be arrays';
  end if;

  set constraints all deferred;
  update public.competitions
  set title = trim(p_title), min_score = p_min_score, max_score = p_max_score,
      status = p_status, updated_at = now()
  where id = p_competition_id;

  if exists (
    select 1 from jsonb_to_recordset(p_categories) as item(id uuid, name text, position integer)
    where item.id is null or item.position is null or item.position < 1
      or length(trim(coalesce(item.name, ''))) not between 1 and 120
  ) or exists (
    select position from jsonb_to_recordset(p_categories) as item(id uuid, name text, position integer)
    group by position having count(*) > 1
  ) then raise exception 'Invalid category list'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_participants) as item(id uuid, surname text, given_name text, age integer, position integer)
    where item.id is null or item.position is null or item.position < 1
      or length(trim(coalesce(item.surname, ''))) not between 1 and 120
      or length(trim(coalesce(item.given_name, ''))) not between 1 and 120
      or item.age is null or item.age not between 1 and 120
  ) or exists (
    select position from jsonb_to_recordset(p_participants) as item(id uuid, surname text, given_name text, age integer, position integer)
    group by position having count(*) > 1
  ) then raise exception 'Invalid participant list'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_categories) as item(id uuid, name text, position integer)
    join public.categories existing on existing.id = item.id
    where existing.competition_id <> p_competition_id
  ) or exists (
    select 1 from jsonb_to_recordset(p_participants) as item(id uuid, surname text, given_name text, age integer, position integer)
    join public.participants existing on existing.id = item.id
    where existing.competition_id <> p_competition_id
  ) then raise exception 'An item belongs to another competition'; end if;

  delete from public.categories existing
  where existing.competition_id = p_competition_id
    and not exists (select 1 from jsonb_to_recordset(p_categories) as item(id uuid) where item.id = existing.id);
  delete from public.participants existing
  where existing.competition_id = p_competition_id
    and not exists (select 1 from jsonb_to_recordset(p_participants) as item(id uuid) where item.id = existing.id);

  insert into public.categories (id, competition_id, name, position)
  select item.id, p_competition_id, trim(item.name), item.position
  from jsonb_to_recordset(p_categories) as item(id uuid, name text, position integer)
  on conflict (id) do update set name = excluded.name, position = excluded.position;

  insert into public.participants (id, competition_id, surname, given_name, age, position)
  select item.id, p_competition_id, trim(item.surname), trim(item.given_name), item.age, item.position
  from jsonb_to_recordset(p_participants) as item(id uuid, surname text, given_name text, age integer, position integer)
  on conflict (id) do update set surname = excluded.surname, given_name = excluded.given_name,
    age = excluded.age, position = excluded.position;
end;
$$;

create or replace function public.read_judge_ballot(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ballot jsonb;
begin
  select jsonb_build_object(
    'judge', jsonb_build_object('id', j.id, 'name', j.name, 'submitted', j.submitted_at is not null),
    'competition', jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status, 'min_score', c.min_score, 'max_score', c.max_score),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'surname', p.surname, 'name', p.given_name, 'age', p.age) order by p.position)
      from public.participants p where p.competition_id = c.id
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', cat.id, 'name', cat.name) order by cat.position)
      from public.categories cat where cat.competition_id = c.id
    ), '[]'::jsonb),
    'scores', coalesce((
      select jsonb_agg(jsonb_build_object('participant_id', v.participant_id, 'category_id', v.category_id, 'score', v.score))
      from public.votes v where v.judge_id = j.id
    ), '[]'::jsonb)
  ) into v_ballot
  from public.judges j
  join public.competitions c on c.id = j.competition_id
  where j.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex');

  if v_ballot is null then raise exception 'Invalid judge link'; end if;
  return v_ballot;
end;
$$;

create or replace function public.save_judge_score(p_token text, p_participant_id uuid, p_category_id uuid, p_score integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_judge_id uuid;
  v_competition_id uuid;
  v_status text;
  v_min_score integer;
  v_max_score integer;
  v_submitted_at timestamptz;
begin
  select j.id, c.id, c.status, c.min_score, c.max_score, j.submitted_at
  into v_judge_id, v_competition_id, v_status, v_min_score, v_max_score, v_submitted_at
  from public.judges j
  join public.competitions c on c.id = j.competition_id
  where j.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
  for update of j, c;

  if v_judge_id is null then raise exception 'Invalid judge link'; end if;
  if v_status <> 'open' then raise exception 'Voting is not open'; end if;
  if v_submitted_at is not null then raise exception 'Ballot was already submitted'; end if;
  if p_score is null or p_score < v_min_score or p_score > v_max_score then raise exception 'Score outside allowed range'; end if;
  if not exists (select 1 from public.participants p where p.id = p_participant_id and p.competition_id = v_competition_id)
    or not exists (select 1 from public.categories cat where cat.id = p_category_id and cat.competition_id = v_competition_id)
  then raise exception 'Invalid ballot item'; end if;

  insert into public.votes (competition_id, judge_id, participant_id, category_id, score)
  values (v_competition_id, v_judge_id, p_participant_id, p_category_id, p_score)
  on conflict (judge_id, participant_id, category_id) do update set score = excluded.score;
end;
$$;

create or replace function public.submit_judge_ballot(p_token text, p_scores jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_judge_id uuid;
  v_competition_id uuid;
  v_status text;
  v_min_score integer;
  v_max_score integer;
  v_submitted_at timestamptz;
  v_expected_count integer;
  v_received_count integer;
begin
  select j.id, c.id, c.status, c.min_score, c.max_score, j.submitted_at
  into v_judge_id, v_competition_id, v_status, v_min_score, v_max_score, v_submitted_at
  from public.judges j
  join public.competitions c on c.id = j.competition_id
  where j.token_hash = encode(extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'), 'hex')
  for update of j, c;

  if v_judge_id is null then raise exception 'Invalid judge link'; end if;
  if v_status <> 'open' then raise exception 'Voting is not open'; end if;
  if v_submitted_at is not null then raise exception 'Ballot was already submitted'; end if;
  if jsonb_typeof(p_scores) <> 'array' then raise exception 'Scores must be an array'; end if;

  select count(*) into v_expected_count
  from public.participants p cross join public.categories cat
  where p.competition_id = v_competition_id and cat.competition_id = v_competition_id;
  if v_expected_count = 0 then raise exception 'Contest has no ballot items'; end if;

  select count(*) into v_received_count
  from jsonb_to_recordset(p_scores) as s(participant_id uuid, category_id uuid, score integer);
  if v_received_count <> v_expected_count then raise exception 'Every participant and category must be scored'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_scores) as s(participant_id uuid, category_id uuid, score integer)
    where s.participant_id is null or s.category_id is null or s.score is null
      or s.score < v_min_score or s.score > v_max_score
      or not exists (select 1 from public.participants p where p.id = s.participant_id and p.competition_id = v_competition_id)
      or not exists (select 1 from public.categories cat where cat.id = s.category_id and cat.competition_id = v_competition_id)
  ) then raise exception 'Invalid ballot item'; end if;

  if (select count(*) from (
    select distinct s.participant_id, s.category_id
    from jsonb_to_recordset(p_scores) as s(participant_id uuid, category_id uuid, score integer)
  ) unique_scores) <> v_expected_count then
    raise exception 'Duplicate ballot item';
  end if;

  insert into public.votes (competition_id, judge_id, participant_id, category_id, score)
  select v_competition_id, v_judge_id, s.participant_id, s.category_id, s.score
  from jsonb_to_recordset(p_scores) as s(participant_id uuid, category_id uuid, score integer)
  on conflict (judge_id, participant_id, category_id) do update set score = excluded.score;

  update public.judges set submitted_at = now() where id = v_judge_id;
end;
$$;

revoke all on function public.create_organization(text) from public, anon;
revoke all on function public.create_judge_link(uuid, text, text) from public, anon;
revoke all on function public.rotate_judge_link(uuid) from public, anon;
revoke all on function public.save_competition_setup(uuid, text, integer, integer, text, jsonb, jsonb) from public, anon;
revoke all on function public.read_judge_ballot(text) from public, anon, authenticated;
revoke all on function public.save_judge_score(text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.submit_judge_ballot(text, jsonb) from public, anon, authenticated;

grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.create_judge_link(uuid, text, text) to authenticated;
grant execute on function public.rotate_judge_link(uuid) to authenticated;
grant execute on function public.save_competition_setup(uuid, text, integer, integer, text, jsonb, jsonb) to authenticated;
grant execute on function public.read_judge_ballot(text) to anon, authenticated;
grant execute on function public.save_judge_score(text, uuid, uuid, integer) to anon, authenticated;
grant execute on function public.submit_judge_ballot(text, jsonb) to anon, authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['votes', 'judges', 'competitions', 'categories', 'participants'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    exception
      when duplicate_object or undefined_object then null;
    end;
  end loop;
end;
$$;
