import { createBrowserSupabase } from './supabase-browser';

const LEDGER_WATCH = [
  'portfolio_exposure',
  'account_snapshots',
  'trade_intents',
  'trade_proposals',
  'thesis_symbols',
  'broker_fills',
  'theses',
] as const;

/** Operator-only. The public snapshot client never imports this module. */
export function subscribeDeskRefresh(onChange: () => void): () => void {
  const supabase = createBrowserSupabase();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bounce = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(onChange, 400);
  };
  let channel = supabase.channel('desk-ledger');
  for (const table of LEDGER_WATCH) {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, bounce);
  }
  void channel.subscribe();
  return () => {
    if (timer !== null) clearTimeout(timer);
    void supabase.removeChannel(channel);
  };
}
