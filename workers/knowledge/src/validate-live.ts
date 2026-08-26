import { Client } from 'pg';

const connectionString = process.env.QUANTANAMO_DATABASE_URL;
if (!connectionString) throw new Error('QUANTANAMO_DATABASE_URL is required');

const url = new URL(connectionString);
if (['require', 'prefer'].includes(url.searchParams.get('sslmode') || '')) url.searchParams.set('uselibpqcompat', 'true');
const client = new Client({ connectionString: url.toString() });
await client.connect();
try {
  const columns = await client.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_schema='public' and table_name='research_documents' order by ordinal_position",
  );
  const state = await client.query<{ bookmarks: number; latest_bookmark: string | null; pending_articles: number; articles: number; r2_documents: number; failed_articles: number }>(`
    select count(*)::integer as bookmarks, max(fetched_at)::text as latest_bookmark,
      (select count(*)::integer from bookmark_urls u left join articles a on a.url=coalesce(u.expanded_url,u.url) where a.id is null) as pending_articles,
      (select count(*)::integer from articles) as articles,
      (select count(*)::integer from research_documents where storage_provider='r2') as r2_documents,
      (select count(*)::integer from articles where error is not null) as failed_articles
    from bookmarks
  `);
  const projection = await client.query<{ generated_at: string; job_ids: string[]; run_count: number; latest_research_status: string | null; latest_research_outcome: string | null }>(`
    select generated_at::text,
      coalesce((select array_agg(item->>'id') from jsonb_array_elements(payload->'automations') item),array[]::text[]) as job_ids,
      jsonb_array_length(coalesce(payload->'automation_runs','[]'::jsonb)) as run_count,
      (select item->>'status' from jsonb_array_elements(payload->'automation_runs') item where item->>'automation_id'='research-orchestrator' order by item->>'started_at' desc limit 1) as latest_research_status,
      (select item->>'outcome' from jsonb_array_elements(payload->'automation_runs') item where item->>'automation_id'='research-orchestrator' order by item->>'started_at' desc limit 1) as latest_research_outcome
    from dashboard_snapshots where id='current'
  `);
  console.log(JSON.stringify({ columns: columns.rows.map((row) => row.column_name), state: state.rows[0], projection: projection.rows[0] }));
} finally {
  await client.end();
}
