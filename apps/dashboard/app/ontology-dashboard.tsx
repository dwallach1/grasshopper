'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';

type Thesis={id:string;name:string;summary:string;stance:string;confidence:number;status:string;variant_perception:string|null;falsifier:string|null;symbols:string[]};
type Cycle={id:number;external_key:string;thesis_id:string;thesis_name:string;hypothesis:string;preregistered_outcome:string;preregistered_at:string;stage:string;status:string;iteration:number;market_regime:string};
type Test={id:number;external_key:string;cycle_id:number;cycle_key:string;thesis_id:string;variant_label:string;status:string;total_return:number|null;max_drawdown:number|null;deflated_sharpe:number|null;cost_multiplier:number;stress_regime:string|null;failure_reason:string|null;autopsy:string|null};
type Scenario={id:number;test_id:number;test_key:string;scenario_key:string;market_regime:string;cost_multiplier:number;outcome:string;metric_value:number|null;breach_type:string|null};
type AgentRun={id:number;cycle_id:number;cycle_key:string;agent_role:string;independence_group:string;price_blinded:number;status:string;summary:string};
type Lesson={id:number;cycle_id:number;test_id:number;thesis_id:string;lesson_type:string;summary:string;market_regime:string;incorporated:number};
type RiskControl={id:number;control_key:string;scope:string;control_type:string;threshold_json:string;enforcement_level:string;status:string;updated_at?:string};
type Relation={src_thesis_id:string;dst_thesis_id:string;relation_type:string;strength:number;rationale:string};
type Prediction={id:number|string;thesis_id:string;statement:string;target_date:string|null;probability:number;status:string};
type Insight={id:number|string;title:string;summary:string;insight_type:string;novelty:number;confidence:number};
type EventRecord={id:number;label:string;event_date:string|null;decision:string;rationale:string|null;participation_trigger:string|null};
type TradeProposal={id:number;thesis_id:string|null;symbol:string;side:string;notional:number;order_type:string;status:string;rationale:string;created_at:string;reviewed_at:string|null;broker_alerts:string|null};
type AccountState={observed_at:string;account_label:string;total_value:number;equity_value:number;cash:number;buying_power:number;source:string};
type TradePolicy={sizing?:{max_single_trade_percent_of_portfolio_value?:number;standing_cash_target_percent?:number;tactical_swing_sleeve?:{target_percent_of_portfolio_value?:number;target_positions?:number;max_percent_per_position?:number}}};
type RunReport={id:number;run_type:string;started_at:string;completed_at:string|null;status:string;headline:string;summary:string;insights:string[];learnings:string[];actions:string[];metrics:Record<string,string|number>};
type Automation={id:string;name:string;prompt:string;kind:string;status:string;rrule:string;model:string|null;reasoning_effort:string|null;next_run_at:string|null;last_run_at:string|null;indexed_at:string;run_count:number;passed_count:number;failed_count:number};
type AutomationRun={thread_id:string;automation_id:string;automation_name:string;status:string;outcome:'running'|'passed'|'failed'|'cancelled'|'unknown';started_at:string;completed_at:string|null;duration_ms:number|null;title:string|null;summary:string|null;final_output:string|null;findings:string[];learnings:string[];explored:string[];actions:string[];timeline:{at:string|null;text:string}[];error_text:string|null;tokens_used:number|null};
type OntologyTheme={id:string;thesis_id:string|null;kind:string;name:string;description:string;status:string;match_threshold:number;auto_promote_sources:number;term_count?:number;symbol_count?:number};
type OntologyCandidate={id:number;candidate_type:string;candidate_key:string;proposed_theme_id:string|null;proposed_label:string;proposed_description:string;score:number;evidence_count:number;source_count:number;status:string;first_seen_at:string;last_seen_at:string;review_note:string|null};
type OntologySymbol={symbol:string;status:string;mention_count:number;source_count:number;first_seen_at:string;last_seen_at:string};
type OntologyAction={id:number;actor_id:string;entity_type:string;entity_key:string;action:string;created_at:string};
export type Snapshot={generated_at:string;trade_policy?:TradePolicy;run_reports?:RunReport[];automations?:Automation[];automation_runs?:AutomationRun[];ontology_themes?:OntologyTheme[];ontology_candidates?:OntologyCandidate[];ontology_symbols?:OntologySymbol[];ontology_actions?:OntologyAction[];theses:Thesis[];cycles:Cycle[];tests:Test[];test_scenarios:Scenario[];agent_runs:AgentRun[];lessons:Lesson[];risk_controls:RiskControl[];relations:Relation[];predictions:Prediction[];insights:Insight[];events:EventRecord[];account_state?:AccountState|null;trade_proposals?:TradeProposal[];financial_data?:{network_requests:number;cache_hits:number;records:number;tickers:number;datasets:number};counts:{sources:number;symbols:number;open_research:number;tests_killed:number;tests_survived:number;scenario_cells:number}};

const SNAPSHOT_POLL_MS=60_000;
const ROBINHOOD_MAX_AGE_MS=300_000;
const stages=['research','code','backtest','live','postmortem','fine-tune'];
const positions=new Map<string,[number,number]>(Object.entries({ai_power_nuclear:[18,35],neocloud_compute:[45,20],semis_photonics:[73,32],software_ai_apps:[79,70],quantum:[52,80],crypto:[25,72],defense_drones_space:[10,58],biotech_royalty:[48,50]}));
const clean=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ');
const variantDescriptions=new Map(Object.entries({
  'power-breadth-v4':'Waits for strength across several power beneficiaries before entering.',
  'fast-entry-v3':'Uses a shorter confirmation window to enter sooner; more sensitive to false starts.',
  'equal-weight-event':'Equal-weights neocloud names around a catalyst instead of concentrating in the highest-beta name.',
  'levered-beta':'Amplifies the basket’s market exposure; designed to reveal financing and correlation risk.',
  'earnings-drift':'Looks for strength that persists after an earnings report rather than trading the first reaction.',
  'breakout-v5':'Enters after price and volume clear a prior range; depends heavily on momentum liquidity.',
}));
const regimeDescriptions=new Map(Object.entries({
  base:'Ordinary market conditions with the strategy’s standard assumptions.',
  rate_shock:'Fast rise in yields and discount rates; long-duration equities reprice lower.',
  liquidity_crunch:'Funding and market depth contract; spreads widen and financing-sensitive names suffer.',
  earnings_gap:'A position gaps sharply after results, bypassing the intended exit price.',
  crowded_unwind:'Many investors exit the same factor at once, increasing correlation and slippage.',
  sideways_chop:'No durable trend; repeated entries create small losses and transaction costs.',
}));
const currencyFormatter=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
const numberFormatter=new Intl.NumberFormat('en-US');
const clockFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
const dateOnlyFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'});
const shortDateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const fullDateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'});
const timeFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',second:'2-digit'});
const formatCurrency=(value:number)=>currencyFormatter.format(value);
const formatNumber=(value:number)=>numberFormatter.format(value);
const formatDateTime=(timestamp:string)=>`${fullDateFormatter.format(new Date(timestamp))} ET`;
const formatShortDateTime=(timestamp:string)=>shortDateFormatter.format(new Date(timestamp));
const formatEventTime=(timestamp:string)=>timeFormatter.format(new Date(timestamp));
const formatDateOnly=(timestamp:string)=>dateOnlyFormatter.format(new Date(timestamp));
const toTitle=(value:string|undefined)=>clean(value||'').replace(/\b\w/g,letter=>letter.toUpperCase());

export function OntologyDashboard({initialData}:{initialData:Snapshot}){
  const router=useRouter();
  const [clock,setClock]=useState('');
  const [now,setNow]=useState<number|null>(null);
  const [selectedCycleId,setSelectedCycleId]=useState(initialData.cycles[0]?.id);
  const [selectedTestId,setSelectedTestId]=useState(initialData.tests[0]?.id);
  const [selectedScenarioId,setSelectedScenarioId]=useState(initialData.test_scenarios[0]?.id);
  const [surface,setSurface]=useState<'home'|'automations'|'runs'|'cycles'|'memory'|'ontology'|'risk'>('home');
  useEffect(()=>{const tick=()=>{const current=new Date();setNow(current.getTime());setClock(clockFormatter.format(current))};tick();const id=window.setInterval(tick,1000);return()=>window.clearInterval(id)},[]);
  useEffect(()=>{const id=window.setInterval(()=>router.refresh(),SNAPSHOT_POLL_MS);return()=>window.clearInterval(id)},[router]);
  const activeCycle=initialData.cycles.find(c=>c.id===selectedCycleId)||initialData.cycles[0];
  const activeTest=initialData.tests.find(t=>t.id===selectedTestId)||initialData.tests[0];
  const scenarioCounts=useMemo(()=>initialData.test_scenarios.reduce<Record<string,number>>((a,s)=>({...a,[s.outcome]:(a[s.outcome]||0)+1}),{}),[initialData.test_scenarios]);
  const killRate=Math.round((scenarioCounts.killed||0)/Math.max(1,initialData.counts.scenario_cells)*100);
  const readyCount=(initialData.trade_proposals||[]).filter(p=>p.status==='ready_for_review').length;

  function selectCycle(cycle:Cycle){setSelectedCycleId(cycle.id);const test=initialData.tests.find(t=>t.cycle_id===cycle.id);if(test){setSelectedTestId(test.id);const scenario=initialData.test_scenarios.find(s=>s.test_id===test.id);if(scenario)setSelectedScenarioId(scenario.id)}}

  return <main className="terminal-shell" id="main-content">
    <a className="skip-link" href="#main-content">Skip to dashboard</a>
    <header className="command-bar">
      <div className="desk-id"><b>TF</b><span>ThesisForge<small>Research desk</small></span></div>
      <nav className="desk-tabs" aria-label="Workspace">
        <button className={surface==='home'?'active':''} onClick={()=>setSurface('home')}>Overview</button>
        <button className={surface==='automations'?'active':''} onClick={()=>setSurface('automations')}>Automations</button>
        <button className={surface==='runs'?'active':''} onClick={()=>setSurface('runs')}>Runs</button>
        <button className={surface==='cycles'?'active':''} onClick={()=>setSurface('cycles')}>Cycles</button>
        <button className={surface==='memory'?'active':''} onClick={()=>setSurface('memory')}>Memory</button>
        <button className={surface==='ontology'?'active':''} onClick={()=>setSurface('ontology')}>Ontology</button>
        <button className={surface==='risk'?'active':''} onClick={()=>setSurface('risk')}>Risk</button>
      </nav>
      <div className="run-state" aria-label="Workspace summary"><span>Automations <b>{initialData.automations?.length||0}</b></span><span>Kill rate <b className="red">{killRate}%</b></span><span>Ready <b className="amber">{readyCount}</b></span></div>
      <div className="clock"><b>{clock||'--:--:--'}</b><span>New York · live from Supabase</span></div>
    </header>
    <FreshnessBar publishedAt={initialData.generated_at} robinhoodAt={initialData.account_state?.observed_at} now={now} onRefresh={()=>router.refresh()}/>

    <section className="page-shell">
      {surface==='home'&&<HomeSurface data={initialData} activeThesisId={activeCycle?.thesis_id}/>}
      {surface==='automations'&&<AutomationsSurface data={initialData}/>}
      {surface==='runs'&&<RunsSurface data={initialData}/>}
      {surface==='cycles'&&<CyclesSurface data={initialData} activeCycle={activeCycle} activeTest={activeTest} selectedScenarioId={selectedScenarioId} onCycle={selectCycle} onTest={(test)=>{setSelectedTestId(test.id);const scenario=initialData.test_scenarios.find(s=>s.test_id===test.id);if(scenario)setSelectedScenarioId(scenario.id)}} onScenario={setSelectedScenarioId}/>}
      {surface==='memory'&&<MemorySurface data={initialData}/>}
      {surface==='ontology'&&<OntologyManager data={initialData}/>}
      {surface==='risk'&&<RiskSurface data={initialData}/>}
    </section>

    <footer><span>ThesisForge research desk</span><span>Preregistered tests · retained failures · cached evidence</span><span>{formatNumber(initialData.financial_data?.network_requests||0)} API calls / {formatNumber(initialData.financial_data?.datasets||0)} datasets / {formatNumber(initialData.financial_data?.tickers||0)} enriched</span></footer>
  </main>
}

function formatAge(timestamp:string|undefined,now:number|null){
  if(!timestamp||now===null)return 'Unknown';
  const elapsed=Math.max(0,now-new Date(timestamp).getTime());
  if(elapsed<60_000)return `${Math.floor(elapsed/1000)}s ago`;
  if(elapsed<3_600_000)return `${Math.floor(elapsed/60_000)}m ago`;
  if(elapsed<86_400_000)return `${Math.floor(elapsed/3_600_000)}h ago`;
  return `${Math.floor(elapsed/86_400_000)}d ago`;
}

function FreshnessBar({publishedAt,robinhoodAt,now,onRefresh}:{publishedAt:string;robinhoodAt?:string;now:number|null;onRefresh:()=>void}){
  const [refreshing,setRefreshing]=useState(false);
  const [refreshError,setRefreshError]=useState<string|null>(null);
  const robinhoodAge=!robinhoodAt||now===null?null:Math.max(0,now-new Date(robinhoodAt).getTime());
  const robinhoodTone=robinhoodAge===null?'unknown':robinhoodAge<=ROBINHOOD_MAX_AGE_MS?'fresh':robinhoodAge<=3_600_000?'aging':'stale';

  async function refreshRobinhood(){
    if(refreshing)return;
    setRefreshing(true);
    setRefreshError(null);
    try{
      const response=await fetch('/api/broker/refresh',{method:'POST'});
      const RefreshErrorSchema=z.object({error:z.string().optional()}).passthrough();
      const parsed=RefreshErrorSchema.safeParse(await response.json().catch(()=>({})));
      if(!response.ok)throw new Error(parsed.success&&parsed.data.error?parsed.data.error:`Refresh failed (${response.status})`);
      onRefresh();
    }catch(error){
      setRefreshError(error instanceof Error?error.message:'Refresh failed');
    }finally{
      setRefreshing(false);
    }
  }

  return <section className="freshness-bar" aria-label="Data freshness">
    <div><b className="fresh"><i/>Supabase</b><span>Live</span><small>Last publish {formatAge(publishedAt,now)}</small></div>
    <div>
      <b className={robinhoodTone}><i/>Robinhood</b>
      <span>Account {formatAge(robinhoodAt,now)}</span>
      <small>{robinhoodAt?'Workflows update on run · 5m trade limit':'No account snapshot'}</small>
      <button type="button" className="freshness-refresh" disabled={refreshing} onClick={()=>void refreshRobinhood()}>
        {refreshing?'Refreshing…':'Refresh'}
      </button>
    </div>
    <p>{refreshError?refreshError:'UI polls every 60s. Broker account only updates on workflow runs or manual refresh.'}</p>
  </section>
}

function HomeSurface({data,activeThesisId}:{data:Snapshot;activeThesisId?:string}){
  const ready=(data.trade_proposals||[]).filter(p=>p.status==='ready_for_review');
  const planned=ready.reduce((sum,p)=>sum+p.notional,0);
  const portfolioValue=data.account_state?.total_value||0;
  const buyingPower=data.account_state?.buying_power||0;
  const maxSinglePercent=data.trade_policy?.sizing?.max_single_trade_percent_of_portfolio_value||0;
  const tacticalPercent=data.trade_policy?.sizing?.tactical_swing_sleeve?.target_percent_of_portfolio_value||0;
  const tacticalPositions=data.trade_policy?.sizing?.tactical_swing_sleeve?.target_positions||0;
  const tacticalTarget=portfolioValue*tacticalPercent/100;
  const BrokerAlertsSchema=z.object({gates:z.array(z.string()).optional()}).passthrough();
  const alerts=(proposal:TradeProposal)=>{
    try{
      const parsed=BrokerAlertsSchema.safeParse(JSON.parse(proposal.broker_alerts||'{}'));
      return parsed.success?parsed.data.gates||[]:[];
    }catch{return [];}
  };
  const proposalGates=(proposal:TradeProposal)=>{const gates=alerts(proposal);return gates.length?gates:['Awaiting recorded quote, evidence, portfolio-risk, and execution gates.']};
  const isDangerGate=(gates:string[])=>gates.some(gate=>/cancel|fail|invalid|reject|stop|weak/i.test(gate));
  return <>
    <div className="home-command-grid">
      <section className="home-graph-pane"><SignalGraph data={data} activeThesisId={activeThesisId}/></section>
      <aside className="run-console" aria-label="Next market session">
        <div className="run-console-head"><span>Next regular session</span><b>Dynamic Re-Screen</b><strong>{ready.length} reviews ready</strong></div>
        <div className="capital-readout"><span>Account · {data.account_state?.account_label||'Awaiting live refresh'}</span><b>{formatCurrency(buyingPower)}</b><small>Buying power</small></div>
        <div className="deployment-meter"><i style={{width:`${portfolioValue?Math.min(100,Math.round(planned/portfolioValue*100)):0}%`}}/><span><b>{formatCurrency(planned)}</b> Current queue</span><span><b>{maxSinglePercent}%</b> Max / trade</span></div>
        <div className="session-sequence"><div><b>09:30</b><span>Observe open</span></div><div><b>09:45</b><span>Refresh quotes</span></div><div><b>09:46+</b><span>Review gates</span></div></div>
        <p className="authorization-note"><b>Execution guardrails</b> Ready means sizing and evidence are prepared. Placement still requires fresh prices, passing gates, and an open US regular market session.</p>
      </aside>
    </div>
    <div className="home-run-grid">
      <section><div className="panel-title"><b>Deployment queue</b><span>{maxSinglePercent}% max per trade · {tacticalPercent}% tactical sleeve</span><strong>{formatCurrency(planned)} / {formatCurrency(portfolioValue)}</strong></div>{ready.length?ready.map((p,index)=>{const gates=proposalGates(p);return <article className="review-row" key={p.id}><div className="review-rank">{String(index+1).padStart(2,'0')}</div><div className="review-symbol"><b>{p.symbol}</b><span>{portfolioValue?`${(p.notional/portfolioValue*100).toFixed(1)}% of equity`:'Equity refresh required'}</span></div><div><p>{p.rationale}</p><ul>{gates.map(g=><li key={g}>{g}</li>)}</ul></div><strong>Ready<br/>for review</strong></article>}):<div className="empty-state"><h2>No Ready Proposals</h2><p>The next workflow run will screen the live ontology and publish only candidates that pass every gate.</p></div>}</section>
      <aside className="watch-console"><div className="panel-title"><b>Decision gates</b><span>Live proposals only</span></div>{ready.length?ready.map(proposal=>{const gates=proposalGates(proposal);return <div className={`gate-line ${isDangerGate(gates)?'danger':''}`} key={proposal.id}><b>{proposal.symbol}</b><p>{gates.join(' · ')}</p></div>}):<div className="gate-line"><b>—</b><p>No ticker is selected until current evidence, account state, and execution checks produce a ready proposal.</p></div>}<div className="reserve-box"><span>Tactical swing sleeve target</span><b>{formatCurrency(tacticalTarget)}</b><p>{tacticalPercent}% of fresh portfolio value across up to {tacticalPositions} catalyst-driven positions. Unused buying power remains transient until a candidate passes every gate.</p></div></aside>
    </div>
  </>;
}

function RunsSurface({data}:{data:Snapshot}){
  const reports=data.run_reports||[];
  if(!reports.length)return <div className="empty-state"><h2>No Run Reports Yet</h2><p>Scheduled workers will publish a recap after completing their next investigation.</p></div>;
  return <section className="run-ledger"><div className="run-ledger-hero"><div><span>Runs</span><h1>What changed, not just what ran</h1><p>Every recap separates genuinely new insight from confirmations, risk findings, and next actions.</p></div><div><b>{reports.length}</b><span>Recent runs</span><strong>{toTitle(reports[0].status)}</strong></div></div>{reports.map((report,index)=><article className={`run-report ${index===0?'latest':''}`} key={report.id}><header><div><span>{formatDateTime(report.started_at)} · {toTitle(report.run_type)}</span><h2>{report.headline}</h2><p>{report.summary}</p></div><strong>{toTitle(report.status)}</strong></header><div className="run-report-columns"><RunReportColumn label="New insights" items={report.insights}/><RunReportColumn label="Learnings / risks" items={report.learnings}/><RunReportColumn label="Actions" items={report.actions}/></div>{Object.keys(report.metrics||{}).length>0&&<footer className="run-metrics">{Object.entries(report.metrics).map(([key,value])=><span key={key}>{toTitle(key)} <b>{String(value)}</b></span>)}</footer>}</article>)}</section>;
}

function RunReportColumn({label,items}:{label:string;items:string[]}){return <section><b>{label}</b>{items.length?<ul>{items.map((item,index)=><li key={`${label}-${index}`}>{item}</li>)}</ul>:<p>None recorded.</p>}</section>}

function formatDuration(milliseconds:number|null){
  if(milliseconds==null)return 'In progress';
  const seconds=Math.round(milliseconds/1000);
  if(seconds<60)return `${seconds}s`;
  const minutes=Math.floor(seconds/60),remaining=seconds%60;
  return minutes<60?`${minutes}m ${remaining}s`:`${Math.floor(minutes/60)}h ${minutes%60}m`;
}

function describeSchedule(rrule:string){
  const parts=new Map(rrule.replace(/^RRULE:/,'').split(';').map(part=>{const [key,value]=part.split('=');return [key,value] as const}));
  const dayNames=new Map(Object.entries({MO:'Mon',TU:'Tue',WE:'Wed',TH:'Thu',FR:'Fri',SA:'Sat',SU:'Sun'}));
  const days=(parts.get('BYDAY')||'').split(',').filter(Boolean).map(day=>dayNames.get(day)||day).join(' · ');
  const hours=(parts.get('BYHOUR')||'').split(',').filter(Boolean).map(hour=>`${hour.padStart(2,'0')}:${(parts.get('BYMINUTE')||'0').padStart(2,'0')}`).join(' / ');
  return [days||toTitle(parts.get('FREQ')||'scheduled'),hours].filter(Boolean).join(' · ');
}

function AutomationsSurface({data}:{data:Snapshot}){
  const automations=data.automations||[];
  const runs=data.automation_runs||[];
  const [automationId,setAutomationId]=useState(automations[0]?.id||'all');
  const filtered=automationId==='all'?runs:runs.filter(run=>run.automation_id===automationId);
  const [runId,setRunId]=useState(filtered[0]?.thread_id||runs[0]?.thread_id);
  const selected=filtered.find(run=>run.thread_id===runId)||filtered[0];
  const passed=runs.filter(run=>run.outcome==='passed').length;
  const failed=runs.filter(run=>run.outcome==='failed').length;
  const durations=runs.flatMap(run=>run.duration_ms===null?[]:[run.duration_ms]);
  const average=durations.length?Math.round(durations.reduce((sum,value)=>sum+value,0)/durations.length):null;
  const chooseAutomation=(id:string)=>{setAutomationId(id);const next=id==='all'?runs[0]:runs.find(run=>run.automation_id===id);setRunId(next?.thread_id||'')};
  if(!automations.length)return <div className="empty-state"><h2>No Worker Jobs Published</h2><p>Worker runs appear here after the next event-driven dashboard refresh.</p></div>;
  return <section className="automation-ledger">
    <div className="automation-hero"><div><span>Scheduled operations</span><h1>Worker observability</h1><p>Every scheduled job and execution, with runtime health plus the evidence, decisions, and durable learning it left behind.</p></div><div className="automation-kpis"><span><b>{automations.length}</b> Jobs</span><span className="green"><b>{passed}</b> Passed</span><span className="red"><b>{failed}</b> Failed</span><span><b>{formatDuration(average)}</b> Avg</span></div></div>
    <div className="automation-layout">
      <aside className="automation-list"><button className={automationId==='all'?'active':''} onClick={()=>chooseAutomation('all')}><span>Portfolio view</span><b>All automations</b><small>{runs.length} indexed runs</small></button>{automations.map(job=><button className={automationId===job.id?'active':''} key={job.id} onClick={()=>chooseAutomation(job.id)}><span>{toTitle(job.status)} · {job.model||'Default model'}</span><b>{job.name}</b><small>{describeSchedule(job.rrule)}</small><i>{job.passed_count} pass / {job.failed_count} fail</i></button>)}</aside>
      <section className="automation-runs"><div className="automation-table-head"><span>Start</span><span>Automation</span><span>Outcome</span><span>Duration</span><span>Summary</span></div>{filtered.length?filtered.map(run=><button key={run.thread_id} className={`${run.outcome} ${selected?.thread_id===run.thread_id?'active':''}`} onClick={()=>setRunId(run.thread_id)}><span>{formatShortDateTime(run.started_at)}</span><b>{run.automation_name}</b><strong>{toTitle(run.outcome)}</strong><span>{formatDuration(run.duration_ms)}</span><p>{run.summary||run.title||'No run summary recorded.'}</p></button>):<div className="automation-empty">No runs for this automation yet</div>}
      </section>
    </div>
    {selected&&<AutomationRunDetail run={selected}/>}
  </section>;
}

function AutomationRunDetail({run}:{run:AutomationRun}){
  const sections=[['Findings',run.findings],['Learned',run.learnings],['Explored',run.explored],['Actions',run.actions]] as const;
  return <article className="automation-detail"><header><div><span>Run dossier · {run.thread_id}</span><h2>{run.title||run.automation_name}</h2><p>{run.summary||'No concise summary was recorded.'}</p></div><div><strong className={run.outcome==='passed'?'green':run.outcome==='failed'?'red':'amber'}>{toTitle(run.outcome)}</strong><b>{formatDuration(run.duration_ms)}</b><span>{run.tokens_used?formatNumber(run.tokens_used):'—'} tokens</span></div></header><div className="automation-findings">{sections.map(([label,items])=><section key={label}><b>{label}</b>{items.length?<ul>{items.map((item,index)=><li key={index}>{item}</li>)}</ul>:<p>Nothing separately classified.</p>}</section>)}</div>{run.timeline.length>0&&<details className="automation-timeline"><summary>Investigation trail · {run.timeline.length} checkpoints</summary>{run.timeline.map((event,index)=><div key={index}><span>{event.at?formatEventTime(event.at):`0${index+1}`}</span><p>{event.text}</p></div>)}</details>}{run.final_output&&<details className="automation-output"><summary>Full final report</summary><pre>{run.final_output}</pre></details>}{run.error_text&&<pre className="automation-error">{run.error_text}</pre>}</article>;
}

function SignalGraph({data,activeThesisId}:{data:Snapshot;activeThesisId?:string}){return <><div className="panel-title"><b>Signal canvas</b><span>Live ontology links, thesis confidence, and shared dependencies</span><strong>Active map</strong></div><div className="signal-graph"><div className="canvas-toolbar"><span>Ontology nodes</span><b>{data.theses.length} nodes · {data.relations.length} edges</b></div>{data.relations.map(r=>{const a=positions.get(r.src_thesis_id),b=positions.get(r.dst_thesis_id);if(!a||!b)return null;const dx=b[0]-a[0],dy=b[1]-a[1],w=Math.sqrt(dx*dx+(dy/1.8)**2),angle=Math.atan2(dy/1.8,dx)*180/Math.PI;return <i className="graph-line" key={r.src_thesis_id+r.dst_thesis_id} title={`${toTitle(r.relation_type)} / ${Math.round(r.strength*100)}`} style={{left:`${a[0]}%`,top:`${a[1]}%`,width:`${w}%`,transform:`rotate(${angle}deg)`,opacity:Math.max(.28,r.strength)}}/>})}{data.theses.map(t=>{const position=positions.get(t.id);return <article key={t.id} className={`signal-node ${t.stance} ${t.id===activeThesisId?'active':''}`} style={{left:`${position?.[0]||50}%`,top:`${position?.[1]||50}%`}} title={t.summary}><span>{t.confidence}</span><b>{t.name.replace(' basket','').replace('AI ','')}</b><small>{t.symbols.slice(0,3).join(' · ')||'No symbols'}</small></article>})}<div className="cluster-label c1">Power / compute</div><div className="cluster-label c2">Risk budget</div><div className="graph-scanline"/></div><div className="graph-log"><b>Recent edges</b>{data.relations.slice(0,3).map((r,i)=><span key={r.rationale}>Edge {i+1} · {toTitle(r.relation_type)} · {r.rationale}</span>)}</div><div className="graph-stats"><span>Nodes <b>{data.theses.length}</b></span><span>Edges <b>{data.relations.length}</b></span><span>Sources <b>{formatNumber(data.counts.sources)}</b></span><span>Symbols <b>{formatNumber(data.counts.symbols)}</b></span><span>Bridges <b>{data.relations.filter(r=>r.strength<.7).length}</b></span></div></>}

function CyclesSurface({data,activeCycle,activeTest,selectedScenarioId,onCycle,onTest,onScenario}:{data:Snapshot;activeCycle?:Cycle;activeTest?:Test;selectedScenarioId?:number;onCycle:(cycle:Cycle)=>void;onTest:(test:Test)=>void;onScenario:(id:number)=>void}){
  if(!activeCycle||!activeTest){
    return <div className="empty-state"><h2>No research cycles yet</h2><p>Once the orchestrator writes a cycle and test into the snapshot, this page will show the active thesis, variants, and scenario wall for that cycle.</p></div>;
  }
  const activeThesis=data.theses.find(t=>t.id===activeCycle.thesis_id)||data.theses[0];
  const tests=data.tests.filter(t=>t.cycle_id===activeCycle.id);
  const scenarios=data.test_scenarios.filter(s=>s.test_id===activeTest.id);
  const selected=scenarios.find(s=>s.id===selectedScenarioId)||scenarios[0];
  const regimes=[...new Set(scenarios.map(s=>s.market_regime))];
  return <>
    <section className="strategy-pipeline"><div className="panel-title"><b>Research cycles</b><span>Each cycle moves through one controlled pipeline</span><strong>{data.cycles.filter(c=>c.status!=='killed').length} active</strong></div><div className="pipeline-row">{stages.map((stage,i)=>{const count=data.cycles.filter(c=>c.stage===stage).length;return <div key={stage} className={`pipeline-stage ${activeCycle.stage===stage?'active':''}`}><i>0{i+1}</i><b>{toTitle(stage)}</b><span>{count||'—'} {count===1?'cycle':'cycles'}</span><small>{stage==='research'?'form the hypothesis':stage==='code'?'define exact rules':stage==='backtest'?'stress every variant':stage==='live'?'monitor only approved rules':stage==='postmortem'?'explain the failure':'update the world model'}</small></div>})}</div></section>
    <div className="cycle-workspace">
      <aside className="cycle-navigator"><div className="panel-title"><b>Select a cycle</b><span>No hidden filter</span></div>{data.cycles.map(c=><button key={c.id} onClick={()=>onCycle(c)} className={c.id===activeCycle.id?'active':''}><span>{toTitle(c.stage)} · Rev {c.iteration}</span><b>{c.thesis_name}</b><small>{toTitle(c.status)} · {toTitle(c.market_regime)}</small></button>)}</aside>
      <section className="cycle-main">
        <div className="cycle-brief"><div><span>Hypothesis</span><h1>{activeCycle.hypothesis}</h1></div><div><span>Success was defined as</span><p>{activeCycle.preregistered_outcome}</p></div><div><span>Invalidated if</span><p>{activeThesis?.falsifier||'No falsifier is recorded for this thesis yet.'}</p></div></div>
        <div className="variant-strip"><div className="variant-intro"><b>Strategy variants</b><span>Different implementations of this cycle’s hypothesis</span></div>{tests.map(t=><button key={t.id} onClick={()=>onTest(t)} className={`${t.status} ${t.id===activeTest.id?'active':''}`}><span>{toTitle(t.status)}</span><b>{t.variant_label}</b><p>{variantDescriptions.get(t.variant_label)||'A distinct implementation of the cycle hypothesis.'}</p></button>)}</div>
        <section className="kill-wall"><div className="panel-title"><b>Scenario wall · {scenarios.length} scenarios for {activeTest.variant_label}</b><span><i className="survived"/> Passed <i className="queued"/> Not run <i className="killed"/> Failed</span><strong>{data.counts.scenario_cells} archived cells</strong></div><div className="wall-explainer"><p><b>Variant</b>The trading rules being tested. You selected <strong>{activeTest.variant_label}</strong>.</p><p><b>Scenario</b>One market regime at either normal cost or doubled transaction cost.</p></div><div className="scenario-table"><div className="scenario-head"><span>Market condition</span><span>Standard cost · 1×</span><span>Stressed cost · 2×</span></div>{regimes.map(regime=><div className="scenario-row" key={regime}><div><b>{toTitle(regime)}</b><p>{regimeDescriptions.get(regime)}</p></div>{[1,2].map(cost=>{const scenario=scenarios.find(s=>s.market_regime===regime&&s.cost_multiplier===cost);return scenario?<button key={scenario.id} onClick={()=>onScenario(scenario.id)} className={`${scenario.outcome} ${selected?.id===scenario.id?'active':''}`}><span>{toTitle(scenario.outcome)}</span><b>{scenario.metric_value==null?'Not run':`${scenario.metric_value>0?'+':''}${scenario.metric_value}%`}</b><small>{scenario.breach_type?toTitle(scenario.breach_type):'inside limits'}</small></button>:<div key={cost}/>} )}</div>)}</div>{selected&&<div className="scenario-detail"><div><span>Selected scenario</span><b>{toTitle(selected.market_regime)} · {selected.cost_multiplier}× cost</b><p>{regimeDescriptions.get(selected.market_regime)}</p></div><div><span>Result</span><b className={selected.outcome==='killed'?'red':selected.outcome==='survived'?'green':'amber'}>{toTitle(selected.outcome)}</b><p>{selected.metric_value==null?'Waiting for this test to run.':`Modeled return: ${selected.metric_value}%. ${selected.breach_type?`Failed because it triggered ${clean(selected.breach_type)}.`:'All hard limits remained intact.'}`}</p></div><div><span>Variant autopsy</span><p>{activeTest.autopsy||'No autopsy yet; this variant has not completed testing.'}</p></div></div>}</section>
      </section>
    </div>
  </>;
}

function MemorySurface({data}:{data:Snapshot}){
  if(!data.lessons.length&&!data.insights.length&&!data.predictions.length){
    return <div className="empty-state"><h2>No memory recorded yet</h2><p>Lessons, insights, and preregistered predictions appear here after research cycles complete and write into the snapshot.</p></div>;
  }
  return <><div className="panel-title"><b>Persistent world model</b><span>What failed, where, and why</span><strong>{data.lessons.filter(l=>!l.incorporated).length} open loops</strong></div><div className="insight-grid">{data.insights.map(i=><article key={i.id}><span>{toTitle(i.insight_type)} · Conf {i.confidence}</span><h3>{i.title}</h3><p>{i.summary}</p><b>{i.novelty} novelty</b></article>)}</div><div className="memory-table"><div className="table-head"><span>Lesson</span><span>Thesis</span><span>Regime</span><span>State</span></div>{data.lessons.map(l=><div className="table-row" key={l.id}><p><b>{toTitle(l.lesson_type)}</b>{l.summary}</p><span>{data.theses.find(t=>t.id===l.thesis_id)?.name}</span><span>{toTitle(l.market_regime)}</span><b className={l.incorporated?'green':'amber'}>{l.incorporated?'In model':'Pending'}</b></div>)}</div><div className="memory-lower"><section><div className="panel-title"><b>Preregistered predictions</b><span>No moving goalposts</span></div>{data.predictions.map(p=><div className="prediction-row" key={p.id}><b>{p.probability}%</b><p>{p.statement}</p><span>{p.target_date||'TBD'} · {toTitle(p.status)}</span></div>)}</section><section><div className="panel-title"><b>Critic output</b><span>Behavioral patterns</span></div>{data.agent_runs.filter(a=>['critic','postmortem'].includes(a.agent_role)).map(a=><div className="critic-row" key={a.id}><b>{toTitle(a.agent_role)}</b><p>{a.summary}</p></div>)}</section></div></>}

function OntologyManager({data}:{data:Snapshot}){
  const [themes,setThemes]=useState(data.ontology_themes||[]);
  const [symbols,setSymbols]=useState(data.ontology_symbols||[]);
  const [actions,setActions]=useState(data.ontology_actions||[]);
  const [tab,setTab]=useState<'themes'|'symbols'|'evidence'>('themes');
  const [query,setQuery]=useState('');
  const [pending,setPending]=useState('');
  const [notice,setNotice]=useState('');
  const candidates=data.ontology_candidates||[];
  const filteredThemes=themes.filter(theme=>`${theme.name} ${theme.id} ${theme.description} ${theme.status}`.toLowerCase().includes(query.toLowerCase()));
  const filteredSymbols=symbols.filter(symbol=>`${symbol.symbol} ${symbol.status}`.toLowerCase().includes(query.toLowerCase()));
  const activeCount=themes.filter(theme=>theme.status==='active').length;
  const blockedCount=themes.filter(theme=>theme.status==='blacklisted').length+symbols.filter(symbol=>symbol.status==='blacklisted').length;

  async function manage(entityType:'theme'|'symbol',entityKey:string,action:string){
    const operation=`${entityType}:${entityKey}:${action}`;
    setPending(operation);setNotice('');
    try{
      const response=await fetch('/api/ontology/manage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entity_type:entityType,entity_key:entityKey,action})});
      const ManageResponseSchema=z.object({
        error:z.string().optional(),
        entity:z.union([
          z.object({id:z.string(),status:z.string()}).passthrough(),
          z.object({symbol:z.string(),status:z.string()}).passthrough(),
        ]).optional(),
      }).passthrough();
      const result=ManageResponseSchema.safeParse(await response.json());
      if(!response.ok||!result.success||!result.data.entity)throw new Error(result.success?result.data.error||'Ontology action failed':'Ontology action failed');
      const entity=result.data.entity;
      if(entityType==='theme'&&'id' in entity)setThemes(current=>current.map(item=>item.id===entityKey?{...item,...entity}:item));
      else if(entityType==='symbol'&&'symbol' in entity)setSymbols(current=>current.map(item=>item.symbol===entityKey?{...item,...entity}:item));
      else throw new Error('Ontology action returned the wrong entity type');
      setActions(current=>[{id:Date.now(),actor_id:'you',entity_type:entityType,entity_key:entityKey,action,created_at:new Date().toISOString()},...current]);
      setNotice(`${clean(action)} applied to ${entityKey}.`);
    }catch(error){setNotice(error instanceof Error?error.message:'Ontology action failed');}
    finally{setPending('');}
  }
  const controls=(type:'theme'|'symbol',key:string,status:string)=>{
    const items:{action:string;label:string;danger?:boolean}[]=status==='blacklisted'
      ?[{action:'restore',label:'Restore'}]
      :[
        ...(status!=='active'&&status!=='verified'?[{action:'promote',label:'Promote'}]:[]),
        ...(status==='active'||status==='verified'?[{action:'demote',label:'Demote'}]:[]),
        {action:'blacklist',label:'Blacklist',danger:true},
      ];
    return <div className="ontology-controls">{items.map(item=><button className={item.danger?'danger':''} disabled={Boolean(pending)} key={item.action} onClick={()=>manage(type,key,item.action)}>{pending===`${type}:${key}:${item.action}`?'Working…':item.label}</button>)}</div>;
  };

  return <section className="ontology-manager">
    <div className="ontology-hero"><div><span>Knowledge layer</span><h1>Autonomous by default. Governable at any time.</h1><p>Independent evidence creates vocabulary, memberships, and entirely new themes. This console changes direction when you want it to; it is never a required approval queue.</p></div><div className="ontology-kpis"><span><b>{activeCount}</b>Active themes</span><span><b>{candidates.filter(candidate=>candidate.status==='pending').length}</b>Learning signals</span><span><b>{blockedCount}</b>Hard stops</span></div></div>
    <div className="ontology-toolbar"><div role="tablist" aria-label="Ontology manager views"><button className={tab==='themes'?'active':''} onClick={()=>setTab('themes')}>Themes</button><button className={tab==='symbols'?'active':''} onClick={()=>setTab('symbols')}>Symbols</button><button className={tab==='evidence'?'active':''} onClick={()=>setTab('evidence')}>Evidence + history</button></div>{tab!=='evidence'&&<input aria-label={`Search ${tab}`} placeholder={`Search ${tab}`} value={query} onChange={event=>setQuery(event.target.value)}/>}<span className={notice.toLowerCase().includes('failed')||notice.toLowerCase().includes('required')?'error':''} aria-live="polite">{notice}</span></div>
    {tab==='themes'&&<div className="ontology-theme-grid">{filteredThemes.map(theme=><article className={`ontology-card ${theme.status}`} key={theme.id}><header><div><span>{toTitle(theme.kind)} · {theme.id}</span><h2>{theme.name}</h2></div><b>{toTitle(theme.status)}</b></header><p>{theme.description||'Emerging source cluster; description will deepen with evidence.'}</p><dl><div><dt>Activation</dt><dd>{theme.auto_promote_sources} sources</dd></div><div><dt>Match floor</dt><dd>{theme.match_threshold}</dd></div><div><dt>Vocabulary</dt><dd>{theme.term_count??'Live'}</dd></div><div><dt>Symbols</dt><dd>{theme.symbol_count??'Live'}</dd></div></dl>{controls('theme',theme.id,theme.status)}</article>)}</div>}
    {tab==='symbols'&&<div className="ontology-symbol-table"><div className="ontology-table-head"><span>Symbol</span><span>State</span><span>Independent sources</span><span>Mentions</span><span>Last seen</span><span>Override</span></div>{filteredSymbols.map(symbol=><div className={`ontology-symbol-row ${symbol.status}`} key={symbol.symbol}><b>{symbol.symbol}</b><span>{toTitle(symbol.status)}</span><span>{symbol.source_count}</span><span>{symbol.mention_count}</span><span>{symbol.last_seen_at?formatDateOnly(symbol.last_seen_at):'—'}</span>{controls('symbol',symbol.symbol,symbol.status)}</div>)}</div>}
    {tab==='evidence'&&<div className="ontology-evidence-layout"><section><div className="panel-title"><b>Live evidence queue</b><span>Observable, not blocking</span><strong>{candidates.length} signals</strong></div>{candidates.slice(0,40).map(candidate=><article className="candidate-row" key={candidate.id}><div><span>{toTitle(candidate.candidate_type)} · {toTitle(candidate.status)}</span><b>{candidate.proposed_label}</b><p>{candidate.proposed_description}</p></div><strong>{candidate.score}<small>Score</small></strong><strong>{candidate.source_count}<small>Sources</small></strong></article>)}</section><aside><div className="panel-title"><b>Manager history</b><span>Every override audited</span></div>{actions.length?actions.slice(0,40).map(action=><div className="ontology-action" key={action.id}><b>{toTitle(action.action)}</b><span>{toTitle(action.entity_type)} · {action.entity_key}</span><small>{formatDateTime(action.created_at)}</small></div>):<p className="ontology-no-actions">No overrides yet. The learner is operating autonomously.</p>}</aside></div>}
  </section>;
}

function RiskSurface({data}:{data:Snapshot}){
  const purpose=new Map(Object.entries({max_drawdown:'Stop adding risk when portfolio drawdown reaches the configured ceiling.',max_notional:'Prevent one thesis from consuming too much portfolio equity.',minimum_liquidity:'Reject trades whose spread is too wide for controlled execution.',transaction_cost_stress:'Require every backtest survivor to remain viable after costs are doubled.'}));
  const applied=new Map(Object.entries({max_drawdown:'Before sizing or adding exposure',max_notional:'Before an order may be approved',minimum_liquidity:'At the execution gate',transaction_cost_stress:'Automatically in the scenario matrix'}));
  const RiskThresholdSchema=z.object({
    percent:z.number().optional(),
    percent_of_portfolio_value:z.number().optional(),
    percent_of_equity:z.number().optional(),
    max_spread_bps:z.number().optional(),
    multiplier:z.number().optional(),
  }).passthrough();
  const value=(control:RiskControl)=>{
    try{
      const threshold=RiskThresholdSchema.safeParse(JSON.parse(control.threshold_json));
      if(!threshold.success)return '—';
      const t=threshold.data;
      return t.percent!=null?`${t.percent}%`:t.percent_of_portfolio_value!=null?`${t.percent_of_portfolio_value}% of portfolio`:t.percent_of_equity!=null?`${t.percent_of_equity}% of equity`:t.max_spread_bps!=null?`${t.max_spread_bps} bps`:t.multiplier!=null?`${t.multiplier}× cost`:'—';
    }catch{return '—';}
  };
  return <><div className="risk-status"><div><span>Current reality</span><h1>1 control runs automatically</h1><p>The doubled-cost breaker is active in backtests. The portfolio, thesis-sizing, and liquidity limits are defined policies but are not yet wired to broker execution.</p></div><div><b>Thresholds</b><strong>Manually configured</strong><span>They change when the research configuration changes, not from model output.</span></div></div><div className="panel-title"><b>Risk controls</b><span>Defined in code and never overridden by a thesis</span><strong>{data.risk_controls.length} policies</strong></div><div className="risk-grid ergonomic">{data.risk_controls.map(r=>{const automated=r.control_type==='transaction_cost_stress';return <article key={r.id}><span>{toTitle(r.scope)}</span><h2>{toTitle(r.control_type)}</h2><strong>{value(r)}</strong><p>{purpose.get(r.control_type)}</p><dl><div><dt>Applied</dt><dd>{applied.get(r.control_type)}</dd></div><div><dt>Automation</dt><dd className={automated?'green':'amber'}>{automated?'Runs in backtest':'Policy only'}</dd></div><div><dt>Updated</dt><dd>Manual config</dd></div></dl></article>})}</div><div className="risk-lower single"><section><div className="panel-title"><b>Breaker evidence</b><span>Adversarial tests that actually ran</span></div>{data.agent_runs.filter(a=>a.agent_role==='breaker').map(a=><div className="breaker-row" key={a.id}><b>2× transaction costs</b><p>{a.summary}</p><span>Independence group {a.independence_group}</span></div>)}</section></div></>;
}
