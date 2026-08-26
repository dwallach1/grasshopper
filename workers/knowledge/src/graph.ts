import type { Database } from './database';

export async function rebuildKnowledgeGraph(database: Database): Promise<{ nodes: number; edges: number }> {
  await database.execute("select pg_advisory_xact_lock(hashtextextended('quantanamo-knowledge-graph',0))");
  const nodeRows = await database.query<{ count: number }>(`
    with source_nodes as (
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
    ),
    upserted as (
      insert into graph_nodes(id,node_type,label,properties_json,created_at,updated_at)
      select id, node_type, label, properties, now(), now()
      from source_nodes
      on conflict(id) do update set node_type=excluded.node_type,label=excluded.label,
        properties_json=excluded.properties_json,updated_at=excluded.updated_at
      returning id
    )
    select count(*)::integer as count from upserted
  `);
  await database.execute(`
    with source_nodes as (
      select 'theme:' || id as id from ontology_themes where status='active'
      union all
      select 'thesis:' || id from theses
      union all
      select 'symbol:' || symbol from symbols where status <> 'blacklisted'
    )
    delete from graph_nodes gn
    where gn.node_type in ('theme', 'thesis', 'symbol')
      and not exists (select 1 from source_nodes sn where sn.id = gn.id)
  `);
  const edgeRows = await database.query<{ count: number }>(`
    with source_edges as (
      select 'symbol:' || symbol as src_id, 'theme:' || theme_id as dst_id,
             'member_of' as edge_type, confidence::double precision / 100.0 as weight,
             evidence_count, jsonb_build_object('source_count',source_count,'learned_by',learned_by) as properties
      from symbol_theme_memberships where status='active'
      union all
      select 'theme:' || id, 'thesis:' || coalesce(thesis_id,id), 'supports', 1.0, 1,
             jsonb_build_object('kind',kind)
      from ontology_themes where status='active' and thesis_id is not null
    ),
    upserted as (
      insert into graph_edges(src_id,dst_id,edge_type,weight,evidence_count,properties_json,created_at,updated_at)
      select src_id,dst_id,edge_type,weight,evidence_count,properties,now(),now()
      from source_edges
      on conflict(src_id,dst_id,edge_type) do update set weight=excluded.weight,
        evidence_count=excluded.evidence_count,properties_json=excluded.properties_json,updated_at=excluded.updated_at
      returning src_id
    )
    select count(*)::integer as count from upserted
  `);
  await database.execute(`
    with source_edges as (
      select 'symbol:' || symbol as src_id, 'theme:' || theme_id as dst_id, 'member_of' as edge_type
      from symbol_theme_memberships where status='active'
      union all
      select 'theme:' || id, 'thesis:' || coalesce(thesis_id,id), 'supports'
      from ontology_themes where status='active' and thesis_id is not null
    )
    delete from graph_edges ge
    where ge.edge_type in ('member_of', 'supports')
      and not exists (
        select 1 from source_edges se
        where se.src_id = ge.src_id and se.dst_id = ge.dst_id and se.edge_type = ge.edge_type
      )
  `);
  return { nodes: nodeRows[0]?.count ?? 0, edges: edgeRows[0]?.count ?? 0 };
}

type WeeklyEventRow = {
  id: number;
  label: string;
  event_type: string;
  event_date: string | null;
  status: string;
  source_url: string | null;
};

export async function refreshWeeklyEventMap(database: Database, now = new Date()): Promise<{ mapped: number; unresolved: number; weekStart: string }> {
  await database.execute("select pg_advisory_xact_lock(hashtextextended('quantanamo-weekly-event-map',0))");
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const mondayOffset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - mondayOffset);
  const end = new Date(day);
  end.setUTCDate(end.getUTCDate() + 6);
  const startDate = day.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const events = await database.query<WeeklyEventRow>(`
    select id,label,event_type,event_date::text,status,source_url
    from research_events where status in ('watching','scheduled','observed')
      and (event_date is null or event_date between $1::date and $2::date)
    order by event_date nulls last,id
  `, [startDate, endDate]);

  if (events.length) {
    const week = `${startDate}_to_${endDate}`;
    const nodeRows = events.map((event) => ({
      id: `event:${event.id}`,
      label: event.label,
      properties: {
        event_type: event.event_type,
        event_date: event.event_date,
        status: event.status,
        source_url: event.source_url,
        week,
      },
    }));
    await database.execute(`
      insert into graph_nodes(id,node_type,label,properties_json,created_at,updated_at)
      select id,'event',label,properties::jsonb,now(),now()
      from jsonb_to_recordset($1::jsonb) as x(id text, label text, properties jsonb)
      on conflict(id) do update set label=excluded.label,properties_json=excluded.properties_json,updated_at=now()
    `, [JSON.stringify(nodeRows)]);

    const queueRows = events.map((event) => {
      const topic = `${startDate}: verify ${event.label}`;
      return {
        priority: event.event_date ? 80 : 60,
        topic,
        reason: `Confirm date, source evidence, affected symbols, activation conditions, and invalidation for ${event.label} before the market-hours workflow.`,
      };
    });
    await database.execute(`
      with incoming as (
        select priority::smallint as priority, topic, reason
        from jsonb_to_recordset($1::jsonb) as x(priority integer, topic text, reason text)
      ),
      updated as (
        update research_queue rq
        set reason = incoming.reason, updated_at = now()
        from incoming
        where rq.topic = incoming.topic and rq.status = 'open'
        returning rq.id
      )
      insert into research_queue(priority,topic,reason,source,created_at,updated_at)
      select incoming.priority, incoming.topic, incoming.reason, 'worker_event_map', now(), now()
      from incoming
      where not exists (
        select 1 from research_queue rq where rq.topic = incoming.topic and rq.status = 'open'
      )
    `, [JSON.stringify(queueRows)]);
  }

  const unresolved = events.filter((event) => !event.event_date).length;
  return { mapped: events.length, unresolved, weekStart: startDate };
}
