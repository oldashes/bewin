create table if not exists stocks (
  code text primary key,
  name text,
  exchange text,
  board text,
  industry text,
  region text,
  concepts jsonb not null default '[]'::jsonb,
  listing_date date,
  updated_at timestamptz not null default now()
);

create table if not exists strategy_signals (
  id bigserial primary key,
  source text not null,
  strategy text not null,
  signal_date date not null,
  code text not null references stocks(code) on update cascade,
  name text,
  rank integer,
  rank_5 integer,
  rank_10 integer,
  rank_20 integer,
  rank_delta_20 integer,
  score numeric,
  model_score numeric,
  amount_ratio numeric,
  turnover_5 numeric,
  entry_date date,
  entry_open numeric,
  signal_close numeric,
  ret_5 numeric,
  ret_10 numeric,
  ret_20 numeric,
  best_board_type text,
  best_board_code text,
  best_board_name text,
  best_board_ret_5 numeric,
  best_board_amount_ratio numeric,
  metrics jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, strategy, signal_date, code)
);

create table if not exists import_batches (
  id bigserial primary key,
  source_file text not null,
  source text not null,
  strategy text not null,
  row_count integer not null,
  imported_at timestamptz not null default now()
);

create index if not exists idx_strategy_signals_date on strategy_signals(signal_date desc);
create index if not exists idx_strategy_signals_code_date on strategy_signals(code, signal_date desc);
create index if not exists idx_strategy_signals_source_strategy_date on strategy_signals(source, strategy, signal_date desc);
create index if not exists idx_strategy_signals_rank on strategy_signals(rank);
create index if not exists idx_stocks_name on stocks(name);
