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

create table if not exists strategy_feature_events (
  id bigserial primary key,
  source text not null,
  feature_set text not null,
  signal_date date not null,
  code text not null references stocks(code) on update cascade,
  name text,
  rank integer,
  rank_5 integer,
  rank_10 integer,
  rank_20 integer,
  rank_delta_20 integer,
  median_5 numeric,
  median_prev_5 numeric,
  median_prev_10 numeric,
  prev_5 numeric,
  prev_10 numeric,
  amount_ratio numeric,
  turnover_5 numeric,
  entry_date date,
  entry_open numeric,
  signal_close numeric,
  ret_5 numeric,
  ret_10 numeric,
  ret_20 numeric,
  board_count integer,
  has_strong_board boolean,
  has_strong_industry boolean,
  has_strong_concept boolean,
  best_board_type text,
  best_board_code text,
  best_board_name text,
  best_board_ret_5 numeric,
  best_board_ret_10 numeric,
  best_board_amount_ratio numeric,
  best_board_score_rank_pct numeric,
  score numeric,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, feature_set, signal_date, code)
);

create table if not exists strategy_configs (
  id text primary key,
  source text not null default 'em',
  name text not null,
  description text,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists import_batches (
  id bigserial primary key,
  source_file text not null,
  source text not null,
  strategy text not null,
  row_count integer not null,
  imported_at timestamptz not null default now()
);

create table if not exists stock_daily_bars (
  code text not null references stocks(code) on update cascade,
  trade_date date not null,
  market text,
  open numeric,
  close numeric,
  high numeric,
  low numeric,
  volume numeric,
  amount numeric,
  amplitude numeric,
  pct numeric,
  change numeric,
  turnover numeric,
  source text not null default 'eastmoney',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (code, trade_date)
);

create table if not exists popularity_snapshots (
  id bigserial primary key,
  source text not null,
  category text not null,
  metric text not null,
  snapshot_date date not null,
  snapshot_key text not null,
  snapshot_time timestamptz,
  code text not null,
  name text,
  market text,
  rank integer,
  rank_change integer,
  heat_value numeric,
  pct numeric,
  price numeric,
  float_market_value numeric,
  main_tag text,
  raw jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, category, metric, snapshot_key, code)
);

create table if not exists sync_runs (
  id bigserial primary key,
  job_name text not null,
  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  selected_count integer not null default 0,
  success_count integer not null default 0,
  failed_count integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  error text
);

create index if not exists idx_strategy_signals_date on strategy_signals(signal_date desc);
create index if not exists idx_strategy_signals_code_date on strategy_signals(code, signal_date desc);
create index if not exists idx_strategy_signals_source_strategy_date on strategy_signals(source, strategy, signal_date desc);
create index if not exists idx_strategy_signals_rank on strategy_signals(rank);
create index if not exists idx_strategy_feature_events_source_date on strategy_feature_events(source, feature_set, signal_date desc);
create index if not exists idx_strategy_feature_events_rank on strategy_feature_events(source, feature_set, rank);
create index if not exists idx_strategy_feature_events_code_date on strategy_feature_events(source, code, signal_date desc);
create index if not exists idx_strategy_configs_source_updated on strategy_configs(source, updated_at desc);
create index if not exists idx_stocks_name on stocks(name);
create index if not exists idx_stock_daily_bars_date on stock_daily_bars(trade_date desc);
create index if not exists idx_stock_daily_bars_updated on stock_daily_bars(updated_at);
create index if not exists idx_popularity_snapshots_source_date on popularity_snapshots(source, category, metric, snapshot_date desc);
create index if not exists idx_popularity_snapshots_code_date on popularity_snapshots(source, code, snapshot_date desc);
create index if not exists idx_popularity_snapshots_time on popularity_snapshots(snapshot_time desc);
create index if not exists idx_sync_runs_job_started on sync_runs(job_name, started_at desc);
