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
