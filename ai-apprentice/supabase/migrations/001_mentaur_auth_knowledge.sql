-- Mentaur: authenticated teacher/learner accounts + persistent knowledge base.
-- Run this in the Supabase SQL editor (or `supabase db push`).

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null check (role in ('teacher','learner')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if coalesce(new.raw_user_meta_data ->> 'role', '') not in ('teacher','learner') then
    raise exception 'A valid account role is required';
  end if;

  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120),
    new.raw_user_meta_data ->> 'role'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create table if not exists public.learning_sessions (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'Mentaur session',
  summary text not null default '',
  status text not null default 'active' check (status in ('active','complete')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists learning_sessions_teacher_idx on public.learning_sessions(teacher_id, started_at desc);

create table if not exists public.session_participants (
  session_id uuid not null references public.learning_sessions(id) on delete cascade,
  learner_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (session_id, learner_id)
);
create index if not exists session_participants_learner_idx on public.session_participants(learner_id, joined_at desc);

create table if not exists public.session_archives (
  session_id uuid primary key references public.learning_sessions(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.learning_sessions(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  source_key text not null,
  kind text not null,
  title text not null default '',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  search_document tsvector generated always as (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, source_key)
);
create index if not exists knowledge_chunks_search_idx on public.knowledge_chunks using gin(search_document);
create index if not exists knowledge_chunks_teacher_idx on public.knowledge_chunks(teacher_id, updated_at desc);
create index if not exists knowledge_chunks_session_idx on public.knowledge_chunks(session_id);

alter table public.profiles enable row level security;
alter table public.learning_sessions enable row level security;
alter table public.session_participants enable row level security;
alter table public.session_archives enable row level security;
alter table public.knowledge_chunks enable row level security;

-- Profiles: authenticated users can read their own profile. No client-side role updates.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select to authenticated
using (id = auth.uid());

-- Sessions: a teacher sees their own sessions; a learner sees sessions they joined.
drop policy if exists sessions_select_related on public.learning_sessions;
create policy sessions_select_related on public.learning_sessions for select to authenticated
using (
  teacher_id = auth.uid()
  or exists (
    select 1 from public.session_participants sp
    where sp.session_id = id and sp.learner_id = auth.uid()
  )
);

-- Participant rows are visible to the participant and owning teacher.
drop policy if exists participants_select_related on public.session_participants;
create policy participants_select_related on public.session_participants for select to authenticated
using (
  learner_id = auth.uid()
  or exists (
    select 1 from public.learning_sessions s
    where s.id = session_id and s.teacher_id = auth.uid()
  )
);

-- Raw archives are intentionally teacher-only. Learners retrieve curated/searchable chunks.
drop policy if exists archives_teacher_select on public.session_archives;
create policy archives_teacher_select on public.session_archives for select to authenticated
using (teacher_id = auth.uid());

-- Search chunks are visible to their teacher and learners who actually joined that session.
drop policy if exists chunks_select_related on public.knowledge_chunks;
create policy chunks_select_related on public.knowledge_chunks for select to authenticated
using (
  teacher_id = auth.uid()
  or exists (
    select 1 from public.session_participants sp
    where sp.session_id = knowledge_chunks.session_id and sp.learner_id = auth.uid()
  )
);

-- Called only by the server with the service-role key. p_learner_id is taken from
-- the verified HttpOnly-cookie session, never from a browser-selected role.
create or replace function public.search_learner_knowledge(
  p_learner_id uuid,
  p_query text,
  p_limit int default 6
)
returns table (
  id uuid,
  session_id uuid,
  teacher_id uuid,
  teacher_name text,
  session_title text,
  session_started_at timestamptz,
  kind text,
  title text,
  content text,
  rank real,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (
    select websearch_to_tsquery('english', nullif(trim(p_query), '')) as query
  )
  select
    kc.id,
    kc.session_id,
    kc.teacher_id,
    coalesce(p.full_name, 'Teacher') as teacher_name,
    s.title as session_title,
    s.started_at as session_started_at,
    kc.kind,
    kc.title,
    kc.content,
    ts_rank_cd(kc.search_document, q.query) as rank,
    kc.updated_at
  from public.knowledge_chunks kc
  join public.session_participants sp
    on sp.session_id = kc.session_id and sp.learner_id = p_learner_id
  join public.learning_sessions s on s.id = kc.session_id
  join public.profiles p on p.id = kc.teacher_id
  cross join q
  where q.query is not null and kc.search_document @@ q.query
  order by ts_rank_cd(kc.search_document, q.query) desc, kc.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 6), 8));
$$;

revoke all on function public.search_learner_knowledge(uuid,text,int) from public, anon, authenticated;
grant execute on function public.search_learner_knowledge(uuid,text,int) to service_role;
