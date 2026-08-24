import type { Database } from './database';

export async function rebuildKnowledgeGraph(database: Database): Promise<{ nodes: number; edges: number }> {
  await database.execute("select pg_advisory_xact_lock(hashtextextended('thesisforge-knowledge-graph',0))");
  const nodeCount = await database.execute(`
    insert into graph_nodes(id,node_type,label,properties_json,created_at,updated_at)
    select id, node_type, label, properties, now(), now()
    from (
      select 'theme:' || id as id, 'theme' as node_type, name as label,
             jsonb_build_object('status',status,'kind',kind) as properties
      from ontology_themes where status='active'
      union all
      select 'thesis:' || id, 'thesis', name,
             jsonb_build_object('status',status,'confidence',confidence,'stance',stance)
      from theses
      union all
      select 'symbol:' || symbol, 'symbol', symbol,
             jsonb_build_object('status',status,'mention_count',mention_count)
      from symbols where status <> 'blacklisted'
    ) source
    on conflict(id) do update set node_type=excluded.node_type,label=excluded.label,
      properties_json=excluded.properties_json,updated_at=excluded.updated_at
  `);
  const edgeCount = await database.execute(`
    insert into graph_edges(src_id,dst_id,edge_type,weight,evidence_count,properties_json,created_at,updated_at)
    select src_id,dst_id,edge_type,weight,evidence_count,properties,now(),now()
    from (
      select 'symbol:' || symbol as src_id, 'theme:' || theme_id as dst_id,
             'member_of' as edge_type, confidence::double precision / 100.0 as weight,
             evidence_count, jsonb_build_object('source_count',source_count,'learned_by',learned_by) as properties
      from symbol_theme_memberships where status='active'
      union all
      select 'theme:' || id, 'thesis:' || coalesce(thesis_id,id), 'supports', 1.0, 1,
             jsonb_build_object('kind',kind)
      from ontology_themes where status='active' and thesis_id is not null
    ) source
    on conflict(src_id,dst_id,edge_type) do update set weight=excluded.weight,
      evidence_count=excluded.evidence_count,properties_json=excluded.properties_json,updated_at=excluded.updated_at
  `);
  return { nodes: nodeCount, edges: edgeCount };
}

export async function refreshWeeklyEventMap(database: Database, now = new Date()): Promise<{ mapped: number; unresolved: number; weekStart: string }> {
  await database.execute("select pg_advisory_xact_lock(hashtextextended('thesisforge-weekly-event-map',0))");
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mondayOffset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - mondayOffset);
  const end = new Date(day);
  end.setUTCDate(end.getUTCDate() + 6);
  const startDate = day.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const events = await database.query<{ id: number; label: string; event_type: string; event_date: string | null; status: string; source_url: string | null; summary: string; updated_at: string }>(`
    select id,label,event_type,event_date::text,status,source_url,summary,updated_at::text
    from research_events where status in ('watching','scheduled','observed')
      and (event_date is null or event_date between $1::date and $2::date)
    order by event_date nulls last,id
  `, [startDate, endDate]);
  let unresolved = 0;
  for (const event of events) {
    if (!event.event_date) unresolved += 1;
    await database.execute(`
      insert into graph_nodes(id,node_type,label,properties_json,created_at,updated_at)
      values($1,'event',$2,$3,now(),now())
      on conflict(id) do update set label=excluded.label,properties_json=excluded.properties_json,updated_at=now()
    `, [`event:${event.id}`, event.label, JSON.stringify({ event_type: event.event_type, event_date: event.event_date, status: event.status, source_url: event.source_url, week: `${startDate}_to_${endDate}` })]);
    const topic = `${startDate}: verify ${event.label}`;
    const reason = `Confirm date, source evidence, affected symbols, activation conditions, and invalidation for ${event.label} before the market-hours workflow.`;
    const existing = await database.query<{ id: number }>("select id from research_queue where topic=$1 and status='open'", [topic]);
    if (existing[0]) await database.execute('update research_queue set reason=$1,updated_at=now() where id=$2', [reason, existing[0].id]);
    else await database.execute("insert into research_queue(priority,topic,reason,source,created_at,updated_at) values($1,$2,$3,'worker_event_map',now(),now())", [event.event_date ? 80 : 60, topic, reason]);
  }
  return { mapped: events.length, unresolved, weekStart: startDate };
}
