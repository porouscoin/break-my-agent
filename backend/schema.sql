-- Break my agent: Supabase schema. Run once in the SQL editor.
-- Only the backend (service role key) touches these tables; RLS with no
-- policies means the public anon key can read or write nothing.

create table if not exists players (
  id uuid primary key,
  nickname text,
  created_at timestamptz not null default now()
);

create table if not exists attempts (
  id bigint generated always as identity primary key,
  player_id uuid references players(id) on delete cascade,
  level int not null,
  model text not null,
  message text not null,
  blocked_by text,
  cost_usd numeric(12, 8) not null default 0,
  tokens int not null default 0,
  trace jsonb,
  created_at timestamptz not null default now()
);
create index if not exists attempts_created_at on attempts (created_at);
create index if not exists attempts_player on attempts (player_id);

create table if not exists wins (
  player_id uuid references players(id) on delete cascade,
  level int not null,
  model text not null,
  messages_used int not null,
  created_at timestamptz not null default now(),
  primary key (player_id, level)
);

create or replace view leaderboard with (security_invoker = true) as
select
  coalesce(p.nickname, 'anonymous') as nickname,
  max(w.level) as top_level,
  count(*) as levels_solved,
  sum(w.messages_used) as messages_used,
  max(w.created_at) as last_win
from wins w
join players p on p.id = w.player_id
group by p.id, p.nickname
order by top_level desc, messages_used asc, last_win asc;

alter table players enable row level security;
alter table attempts enable row level security;
alter table wins enable row level security;

-- Visitor state and rate-limit events, so the backend itself can be stateless.
create table if not exists sessions (
  player_id uuid primary key references players(id) on delete cascade,
  histories jsonb not null default '{}',
  planted_emails jsonb not null default '[]',
  planted_docs jsonb not null default '[]',
  messages_per_level jsonb not null default '{}',
  last_model jsonb not null default '{}',
  quests jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
alter table sessions add column if not exists quests jsonb not null default '[]';

create table if not exists events (
  id bigint generated always as identity primary key,
  kind text not null,
  key text not null,
  created_at timestamptz not null default now()
);
create index if not exists events_lookup on events (kind, key, created_at);

alter table sessions enable row level security;
alter table events enable row level security;

-- Counts events for one key over several windows (in seconds), newest first.
create or replace function bma_count_events(p_kind text, p_key text, p_windows int[])
returns int[]
language sql stable
set search_path = public
as $$
  select array_agg(c order by ord)
  from (
    select w.ord, (
      select count(*)::int from events e
      where e.kind = p_kind and e.key = p_key
        and e.created_at > now() - make_interval(secs => w.secs)
    ) as c
    from unnest(p_windows) with ordinality as w(secs, ord)
  ) t;
$$;

create or replace function bma_spent_today()
returns numeric
language sql stable
set search_path = public
as $$
  select coalesce(sum(cost_usd), 0) from attempts
  where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
$$;

-- Only the backend (service role) may call these.
revoke execute on function bma_count_events(text, text, int[]) from public, anon, authenticated;
revoke execute on function bma_spent_today() from public, anon, authenticated;
