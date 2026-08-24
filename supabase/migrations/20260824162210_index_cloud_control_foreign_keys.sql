create index idx_position_episodes_symbol on public.position_episodes(symbol);
create index idx_trade_intents_trade_proposal on public.trade_intents(trade_proposal_id)
  where trade_proposal_id is not null;
create index idx_trade_intents_position_episode on public.trade_intents(position_episode_id)
  where position_episode_id is not null;
create index idx_trade_intents_symbol on public.trade_intents(symbol);
create index idx_trade_intents_account_snapshot on public.trade_intents(account_snapshot_id)
  where account_snapshot_id is not null;
;
