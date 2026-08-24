'use client';

import { useEffect, useMemo, useState } from 'react';

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
type RunReport={id:number;run_type:string;started_at:string;completed_at:string|null;status:string;headline:string;summary:string;insights:string[];learnings:string[];actions:string[];metrics:Record<string,string|number>};
type Automation={id:string;name:string;prompt:string;kind:string;status:string;rrule:string;model:string|null;reasoning_effort:string|null;next_run_at:string|null;last_run_at:string|null;indexed_at:string;run_count:number;passed_count:number;failed_count:number};
type AutomationRun={thread_id:string;automation_id:string;automation_name:string;status:string;outcome:'running'|'passed'|'failed'|'cancelled'|'unknown';started_at:string;completed_at:string|null;duration_ms:number|null;title:string|null;summary:string|null;final_output:string|null;findings:string[];learnings:string[];explored:string[];actions:string[];timeline:{at:string|null;text:string}[];error_text:string|null;tokens_used:number|null};
export type Snapshot={generated_at:string;run_reports?:RunReport[];automations?:Automation[];automation_runs?:AutomationRun[];theses:Thesis[];cycles:Cycle[];tests:Test[];test_scenarios:Scenario[];agent_runs:AgentRun[];lessons:Lesson[];risk_controls:RiskControl[];relations:Relation[];predictions:Prediction[];insights:Insight[];events:EventRecord[];account_state?:AccountState|null;trade_proposals?:TradeProposal[];financial_data?:{network_requests:number;cache_hits:number;records:number;tickers:number;datasets:number};counts:{sources:number;symbols:number;open_research:number;tests_killed:number;tests_survived:number;scenario_cells:number}};

const stages=['research','code','backtest','live','postmortem','fine-tune'];
const positions:Record<string,[number,number]>={ai_power_nuclear:[18,35],neocloud_compute:[45,20],semis_photonics:[73,32],software_ai_apps:[79,70],quantum:[52,80],crypto:[25,72],defense_drones_space:[10,58],biotech_royalty:[48,50]};
const clean=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ');
const variantDescriptions:Record<string,string>={
  'power-breadth-v4':'Waits for strength across several power beneficiaries before entering.',
  'fast-entry-v3':'Uses a shorter confirmation window to enter sooner; more sensitive to false starts.',
  'equal-weight-event':'Equal-weights neocloud names around a catalyst instead of concentrating in the highest-beta name.',
  'levered-beta':'Amplifies the basket’s market exposure; designed to reveal financing and correlation risk.',
  'earnings-drift':'Looks for strength that persists after an earnings report rather than trading the first reaction.',
  'breakout-v5':'Enters after price and volume clear a prior range; depends heavily on momentum liquidity.',
};
const regimeDescriptions:Record<string,string>={
  base:'Ordinary market conditions with the strategy’s standard assumptions.',
  rate_shock:'Fast rise in yields and discount rates; long-duration equities reprice lower.',
  liquidity_crunch:'Funding and market depth contract; spreads widen and financing-sensitive names suffer.',
  earnings_gap:'A position gaps sharply after results, bypassing the intended exit price.',
  crowded_unwind:'Many investors exit the same factor at once, increasing correlation and slippage.',
  sideways_chop:'No durable trend; repeated entries create small losses and transaction costs.',
};

export function OntologyDashboard({initialData}:{initialData:Snapshot}){
  const [clock,setClock]=useState('');
  const [selectedCycleId,setSelectedCycleId]=useState(initialData.cycles[0]?.id);
  const [selectedTestId,setSelectedTestId]=useState(initialData.tests[0]?.id);
  const [selectedScenarioId,setSelectedScenarioId]=useState(initialData.test_scenarios[0]?.id);
  const [surface,setSurface]=useState<'home'|'automations'|'runs'|'cycles'|'memory'|'risk'>('home');
  useEffect(()=>{const tick=()=>setClock(new Date().toLocaleTimeString('en-US',{hour12:false,timeZone:'America/New_York'}));tick();const id=window.setInterval(tick,1000);return()=>window.clearInterval(id)},[]);
  const activeCycle=initialData.cycles.find(c=>c.id===selectedCycleId)||initialData.cycles[0];
  const activeTest=initialData.tests.find(t=>t.id===selectedTestId)||initialData.tests[0];
  const scenarioCounts=useMemo(()=>initialData.test_scenarios.reduce<Record<string,number>>((a,s)=>({...a,[s.outcome]:(a[s.outcome]||0)+1}),{}),[initialData.test_scenarios]);
  const killRate=Math.round((scenarioCounts.killed||0)/Math.max(1,initialData.counts.scenario_cells)*100);
  const readyCount=(initialData.trade_proposals||[]).filter(p=>p.status==='ready_for_review').length;

  function selectCycle(cycle:Cycle){setSelectedCycleId(cycle.id);const test=initialData.tests.find(t=>t.cycle_id===cycle.id);if(test){setSelectedTestId(test.id);const scenario=initialData.test_scenarios.find(s=>s.test_id===test.id);if(scenario)setSelectedScenarioId(scenario.id)}}

  return <main className="terminal-shell">
    <header className="command-bar"><div className="desk-id"><b>TF</b><span>THESISFORGE<small>ONTOLOGY / RESEARCH DESK</small></span></div><nav className="desk-tabs" aria-label="Workspace"><button className={surface==='home'?'active':''} onClick={()=>setSurface('home')}>HOME</button><button className={surface==='automations'?'active':''} onClick={()=>setSurface('automations')}>AUTOMATIONS</button><button className={surface==='runs'?'active':''} onClick={()=>setSurface('runs')}>RUNS</button><button className={surface==='cycles'?'active':''} onClick={()=>setSurface('cycles')}>CYCLES</button><button className={surface==='memory'?'active':''} onClick={()=>setSurface('memory')}>MEMORY</button><button className={surface==='risk'?'active':''} onClick={()=>setSurface('risk')}>RISK</button></nav><div className="run-state"><span>JOBS <b>{initialData.automations?.length||0}</b></span><span>KILL RATE <b className="red">{killRate}%</b></span><span>READY <b className="amber">{readyCount}</b></span></div><div className="clock"><b>{clock||'--:--:--'}</b><span>NEW YORK · DATA {new Date(initialData.generated_at).toISOString().slice(11,16)}Z</span></div></header>

    <section className="page-shell">
      {surface==='home'&&<HomeSurface data={initialData} activeThesisId={activeCycle?.thesis_id}/>}
      {surface==='automations'&&<AutomationsSurface data={initialData}/>}
      {surface==='runs'&&<RunsSurface data={initialData}/>}
      {surface==='cycles'&&<CyclesSurface data={initialData} activeCycle={activeCycle} activeTest={activeTest} selectedScenarioId={selectedScenarioId} onCycle={selectCycle} onTest={(test)=>{setSelectedTestId(test.id);const scenario=initialData.test_scenarios.find(s=>s.test_id===test.id);if(scenario)setSelectedScenarioId(scenario.id)}} onScenario={setSelectedScenarioId}/>}
      {surface==='memory'&&<MemorySurface data={initialData}/>}
      {surface==='risk'&&<RiskSurface data={initialData}/>}
    </section>

    <footer><span>TF://ONTOLOGY-DESK</span><span>EVERY TEST PREREGISTERED · EVERY FAILURE RETAINED · EVERY PAID RESPONSE CACHED</span><span>{initialData.financial_data?.network_requests||0} API CALLS / {initialData.financial_data?.datasets||0} DATASETS / {initialData.financial_data?.tickers||0} ENRICHED</span></footer>
  </main>
}

function HomeSurface({data,activeThesisId}:{data:Snapshot;activeThesisId?:string}){
  const ready=(data.trade_proposals||[]).filter(p=>p.status==='ready_for_review');
  const planned=ready.reduce((sum,p)=>sum+p.notional,0);
  const cash=data.account_state?.cash||planned;
  const tacticalCapacity=Math.max(0,cash-planned);
  const alerts=(proposal:TradeProposal)=>{try{return JSON.parse(proposal.broker_alerts||'{}') as {gates?:string[]}}catch{return {gates:[]}}};
  return <>
    <div className="home-command-grid">
      <section className="home-graph-pane"><SignalGraph data={data} activeThesisId={activeThesisId}/></section>
      <aside className="run-console">
        <div className="run-console-head"><span>NEXT MARKET SESSION</span><b>MON · 24 AUG</b><strong>{ready.length} REVIEWS READY</strong></div>
        <div className="capital-readout"><span>ACCOUNT · {data.account_state?.account_label||'LOCAL MODEL'}</span><b>${cash.toLocaleString()}</b><small>CASH / BUYING POWER</small></div>
        <div className="deployment-meter"><i style={{width:`${cash?Math.round(planned/cash*100):0}%`}}/><span><b>${planned.toLocaleString()}</b> CORE + NAMED SWINGS</span><span><b>${tacticalCapacity.toLocaleString()}</b> TACTICAL SLEEVE</span></div>
        <div className="session-sequence"><div><b>09:30</b><span>OBSERVE OPEN</span></div><div><b>09:45</b><span>REFRESH QUOTES</span></div><div><b>09:46+</b><span>REVIEW GATES</span></div></div>
        <p className="authorization-note"><b>AUTONOMOUS EXECUTION AUTHORIZED</b> Ready means sizing and evidence are prepared. Placement requires fresh prices, passing gates, and an open US regular market session; no per-trade user confirmation is required.</p>
      </aside>
    </div>
    <div className="home-run-grid">
      <section><div className="panel-title"><b>TOMORROW&apos;S DEPLOYMENT PLAN</b><span>60% BROAD-MARKET CORE · THESIS SATELLITES CAPPED AT 10% EACH</span><strong>${planned.toLocaleString()} / ${cash.toLocaleString()}</strong></div>{ready.map((p,index)=>{const gates=alerts(p).gates||[];return <article className="review-row" key={p.id}><div className="review-rank">0{index+1}</div><div className="review-symbol"><b>{p.symbol}</b><span>{p.notional/cash*100}% OF CASH</span></div><div><p>{p.rationale}</p><ul>{gates.map(g=><li key={g}>{g}</li>)}</ul></div><strong>READY<br/>FOR EXECUTION</strong></article>})}</section>
      <aside className="watch-console"><div className="panel-title"><b>DECISION GATES</b><span>WHAT CAN STOP THE PLAN</span></div><div className="gate-line"><b>VTI</b><p>Split the $3,000 core into two $1,500 tranches. Pause tranche two if the broad market is disorderly or sharply extended.</p></div><div className="gate-line"><b>VST</b><p>Ten-percent power satellite. Do not chase an opening gap above 3%.</p></div><div className="gate-line danger"><b>AAOI</b><p>Ten-percent maximum optics satellite. A falling open cancels the entry; it is not an invitation to average down.</p></div><div className="reserve-box"><span>TACTICAL SWING SLEEVE</span><b>${tacticalCapacity.toLocaleString()}</b><p>Zero standing cash target. Deploy into one or two validated quick-swing setups; keep cash only transiently when the market is closed or every candidate fails a gate.</p></div></aside>
    </div>
  </>;
}

function RunsSurface({data}:{data:Snapshot}){
  const reports=data.run_reports||[];
  if(!reports.length)return <div className="empty-state"><h2>NO RUN REPORTS YET</h2><p>Scheduled workers will publish a recap after completing their next investigation.</p></div>;
  return <section className="run-ledger"><div className="run-ledger-hero"><div><span>SCHEDULED WORKER LEDGER</span><h1>What changed—not just what ran</h1><p>Every recap separates genuinely new insight from confirmations, risk findings, and next actions.</p></div><div><b>{reports.length}</b><span>RECENT RUNS</span><strong>{reports[0].status}</strong></div></div>{reports.map((report,index)=><article className={`run-report ${index===0?'latest':''}`} key={report.id}><header><div><span>{new Date(report.started_at).toLocaleString('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'})} ET · {clean(report.run_type)}</span><h2>{report.headline}</h2><p>{report.summary}</p></div><strong>{report.status}</strong></header><div className="run-report-columns"><RunReportColumn label="NEW INSIGHTS" items={report.insights}/><RunReportColumn label="LEARNINGS / RISKS" items={report.learnings}/><RunReportColumn label="ACTIONS" items={report.actions}/></div>{Object.keys(report.metrics||{}).length>0&&<footer className="run-metrics">{Object.entries(report.metrics).map(([key,value])=><span key={key}>{clean(key)} <b>{value}</b></span>)}</footer>}</article>)}</section>;
}

function RunReportColumn({label,items}:{label:string;items:string[]}){return <section><b>{label}</b>{items.length?<ul>{items.map((item,index)=><li key={`${label}-${index}`}>{item}</li>)}</ul>:<p>None recorded.</p>}</section>}

function formatDuration(milliseconds:number|null){
  if(milliseconds==null)return 'IN PROGRESS';
  const seconds=Math.round(milliseconds/1000);
  if(seconds<60)return `${seconds}s`;
  const minutes=Math.floor(seconds/60),remaining=seconds%60;
  return minutes<60?`${minutes}m ${remaining}s`:`${Math.floor(minutes/60)}h ${minutes%60}m`;
}

function describeSchedule(rrule:string){
  const parts=Object.fromEntries(rrule.replace(/^RRULE:/,'').split(';').map(part=>part.split('=')));
  const dayNames:Record<string,string>={MO:'MON',TU:'TUE',WE:'WED',TH:'THU',FR:'FRI',SA:'SAT',SU:'SUN'};
  const days=(parts.BYDAY||'').split(',').filter(Boolean).map(day=>dayNames[day]||day).join(' · ');
  const hours=(parts.BYHOUR||'').split(',').filter(Boolean).map(hour=>`${hour.padStart(2,'0')}:${(parts.BYMINUTE||'0').padStart(2,'0')}`).join(' / ');
  return [days||clean(parts.FREQ||'scheduled'),hours].filter(Boolean).join(' · ');
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
  const durations=runs.filter(run=>run.duration_ms!=null).map(run=>run.duration_ms as number);
  const average=durations.length?Math.round(durations.reduce((sum,value)=>sum+value,0)/durations.length):null;
  const chooseAutomation=(id:string)=>{setAutomationId(id);const next=id==='all'?runs[0]:runs.find(run=>run.automation_id===id);setRunId(next?.thread_id)};
  if(!automations.length)return <div className="empty-state"><h2>NO CODEX AUTOMATIONS INDEXED</h2><p>Run the automation indexer, then publish a fresh dashboard snapshot.</p></div>;
  return <section className="automation-ledger">
    <div className="automation-hero"><div><span>CODEX / SCHEDULED OPERATIONS</span><h1>Automation observability</h1><p>Every scheduled job and execution, with runtime health plus the evidence, exploration, decisions, and learning it left behind.</p></div><div className="automation-kpis"><span><b>{automations.length}</b> JOBS</span><span className="green"><b>{passed}</b> PASS</span><span className="red"><b>{failed}</b> FAIL</span><span><b>{formatDuration(average)}</b> AVG</span></div></div>
    <div className="automation-layout">
      <aside className="automation-list"><button className={automationId==='all'?'active':''} onClick={()=>chooseAutomation('all')}><span>PORTFOLIO VIEW</span><b>ALL AUTOMATIONS</b><small>{runs.length} INDEXED RUNS</small></button>{automations.map(job=><button className={automationId===job.id?'active':''} key={job.id} onClick={()=>chooseAutomation(job.id)}><span>{job.status} · {job.model||'DEFAULT MODEL'}</span><b>{job.name}</b><small>{describeSchedule(job.rrule)}</small><i>{job.passed_count} PASS / {job.failed_count} FAIL</i></button>)}</aside>
      <section className="automation-runs"><div className="automation-table-head"><span>START</span><span>AUTOMATION</span><span>OUTCOME</span><span>DURATION</span><span>SUMMARY</span></div>{filtered.length?filtered.map(run=><button key={run.thread_id} className={`${run.outcome} ${selected?.thread_id===run.thread_id?'active':''}`} onClick={()=>setRunId(run.thread_id)}><span>{new Date(run.started_at).toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span><b>{run.automation_name}</b><strong>{run.outcome}</strong><span>{formatDuration(run.duration_ms)}</span><p>{run.summary||run.title||'No run summary recorded.'}</p></button>):<div className="automation-empty">NO RUNS FOR THIS AUTOMATION YET</div>}
      </section>
    </div>
    {selected&&<AutomationRunDetail run={selected}/>}
  </section>;
}

function AutomationRunDetail({run}:{run:AutomationRun}){
  const sections=[['FINDINGS',run.findings],['LEARNED',run.learnings],['EXPLORED',run.explored],['ACTIONS',run.actions]] as const;
  return <article className="automation-detail"><header><div><span>RUN DOSSIER · {run.thread_id}</span><h2>{run.title||run.automation_name}</h2><p>{run.summary||'No concise summary was recorded.'}</p></div><div><strong className={run.outcome==='passed'?'green':run.outcome==='failed'?'red':'amber'}>{run.outcome}</strong><b>{formatDuration(run.duration_ms)}</b><span>{run.tokens_used?.toLocaleString()||'—'} TOKENS</span></div></header><div className="automation-findings">{sections.map(([label,items])=><section key={label}><b>{label}</b>{items.length?<ul>{items.map((item,index)=><li key={index}>{item}</li>)}</ul>:<p>Nothing separately classified.</p>}</section>)}</div>{run.timeline.length>0&&<details className="automation-timeline"><summary>INVESTIGATION TRAIL · {run.timeline.length} CHECKPOINTS</summary>{run.timeline.map((event,index)=><div key={index}><span>{event.at?new Date(event.at).toLocaleTimeString('en-US',{timeZone:'America/New_York'}):`0${index+1}`}</span><p>{event.text}</p></div>)}</details>}{run.final_output&&<details className="automation-output"><summary>FULL FINAL REPORT</summary><pre>{run.final_output}</pre></details>}{run.error_text&&<pre className="automation-error">{run.error_text}</pre>}</article>;
}

function SignalGraph({data,activeThesisId}:{data:Snapshot;activeThesisId?:string}){return <><div className="panel-title"><b>SIGNAL GRAPH · LIVE ONTOLOGY</b><span>EVERY NODE IS A THESIS · EVERY EDGE IS A SHARED DEPENDENCY</span><strong>CLUSTERING / ACTIVE</strong></div><div className="signal-graph">{data.relations.map(r=>{const a=positions[r.src_thesis_id],b=positions[r.dst_thesis_id];if(!a||!b)return null;const dx=b[0]-a[0],dy=b[1]-a[1],w=Math.sqrt(dx*dx+(dy/1.8)**2),angle=Math.atan2(dy/1.8,dx)*180/Math.PI;return <i className="graph-line" key={r.src_thesis_id+r.dst_thesis_id} title={`${clean(r.relation_type)} / ${Math.round(r.strength*100)}`} style={{left:`${a[0]}%`,top:`${a[1]}%`,width:`${w}%`,transform:`rotate(${angle}deg)`,opacity:r.strength}}/>})}{data.theses.map(t=><button key={t.id} className={`signal-node ${t.stance} ${t.id===activeThesisId?'active':''}`} style={{left:`${positions[t.id]?.[0]||50}%`,top:`${positions[t.id]?.[1]||50}%`}} title={t.summary}><span>{t.confidence}</span><b>{t.name.replace(' basket','').replace('AI ','')}</b><small>{t.symbols.slice(0,3).join(' · ')}</small></button>)}<div className="cluster-label c1">CLUSTER 01 · POWER / COMPUTE</div><div className="cluster-label c2">CLUSTER 02 · RISK BUDGET</div><div className="graph-scanline"/></div><div className="graph-log"><b>GRAPH LINK LOG</b>{data.relations.slice(0,3).map((r,i)=><span key={r.rationale}>EDGE {i+1} · {clean(r.relation_type)} · {r.rationale}</span>)}</div><div className="graph-stats"><span>NODES <b>{data.theses.length}</b></span><span>EDGES <b>{data.relations.length}</b></span><span>SOURCES <b>{data.counts.sources}</b></span><span>SYMBOLS <b>{data.counts.symbols}</b></span><span>BRIDGES <b>{data.relations.filter(r=>r.strength<.7).length}</b></span></div></>}

function CyclesSurface({data,activeCycle,activeTest,selectedScenarioId,onCycle,onTest,onScenario}:{data:Snapshot;activeCycle:Cycle;activeTest:Test;selectedScenarioId?:number;onCycle:(cycle:Cycle)=>void;onTest:(test:Test)=>void;onScenario:(id:number)=>void}){
  const activeThesis=data.theses.find(t=>t.id===activeCycle.thesis_id)||data.theses[0];
  const tests=data.tests.filter(t=>t.cycle_id===activeCycle.id);
  const scenarios=data.test_scenarios.filter(s=>s.test_id===activeTest.id);
  const selected=scenarios.find(s=>s.id===selectedScenarioId)||scenarios[0];
  const regimes=[...new Set(scenarios.map(s=>s.market_regime))];
  return <>
    <section className="strategy-pipeline"><div className="panel-title"><b>RESEARCH CYCLES</b><span>EACH CYCLE MOVES THROUGH ONE CONTROLLED PIPELINE</span><strong>{data.cycles.filter(c=>c.status!=='killed').length} ACTIVE</strong></div><div className="pipeline-row">{stages.map((stage,i)=>{const count=data.cycles.filter(c=>c.stage===stage).length;return <div key={stage} className={`pipeline-stage ${activeCycle.stage===stage?'active':''}`}><i>0{i+1}</i><b>{stage}</b><span>{count||'—'} {count===1?'cycle':'cycles'}</span><small>{stage==='research'?'form the hypothesis':stage==='code'?'define exact rules':stage==='backtest'?'stress every variant':stage==='live'?'monitor only approved rules':stage==='postmortem'?'explain the failure':'update the world model'}</small></div>})}</div></section>
    <div className="cycle-workspace">
      <aside className="cycle-navigator"><div className="panel-title"><b>SELECT A CYCLE</b><span>NO HIDDEN FILTER</span></div>{data.cycles.map(c=><button key={c.id} onClick={()=>onCycle(c)} className={c.id===activeCycle.id?'active':''}><span>{c.stage} · REV {c.iteration}</span><b>{c.thesis_name}</b><small>{c.status} · {c.market_regime}</small></button>)}</aside>
      <section className="cycle-main">
        <div className="cycle-brief"><div><span>HYPOTHESIS</span><h1>{activeCycle.hypothesis}</h1></div><div><span>SUCCESS WAS DEFINED AS</span><p>{activeCycle.preregistered_outcome}</p></div><div><span>INVALIDATED IF</span><p>{activeThesis.falsifier}</p></div></div>
        <div className="variant-strip"><div className="variant-intro"><b>STRATEGY VARIANTS</b><span>Different implementations of this cycle’s hypothesis</span></div>{tests.map(t=><button key={t.id} onClick={()=>onTest(t)} className={`${t.status} ${t.id===activeTest.id?'active':''}`}><span>{t.status}</span><b>{t.variant_label}</b><p>{variantDescriptions[t.variant_label]||'A distinct implementation of the cycle hypothesis.'}</p></button>)}</div>
        <section className="kill-wall"><div className="panel-title"><b>THE KILL WALL · {scenarios.length} SCENARIOS FOR {activeTest.variant_label}</b><span><i className="survived"/> PASSED <i className="queued"/> NOT RUN <i className="killed"/> FAILED</span><strong>{data.counts.scenario_cells} ARCHIVED CELLS</strong></div><div className="wall-explainer"><p><b>VARIANT</b>The trading rules being tested. You selected <strong>{activeTest.variant_label}</strong>.</p><p><b>SCENARIO</b>One market regime at either normal cost or doubled transaction cost.</p></div><div className="scenario-table"><div className="scenario-head"><span>MARKET CONDITION</span><span>STANDARD COST · 1×</span><span>STRESSED COST · 2×</span></div>{regimes.map(regime=><div className="scenario-row" key={regime}><div><b>{clean(regime)}</b><p>{regimeDescriptions[regime]}</p></div>{[1,2].map(cost=>{const scenario=scenarios.find(s=>s.market_regime===regime&&s.cost_multiplier===cost);return scenario?<button key={scenario.id} onClick={()=>onScenario(scenario.id)} className={`${scenario.outcome} ${selected?.id===scenario.id?'active':''}`}><span>{scenario.outcome}</span><b>{scenario.metric_value==null?'NOT RUN':`${scenario.metric_value>0?'+':''}${scenario.metric_value}%`}</b><small>{scenario.breach_type?clean(scenario.breach_type):'inside limits'}</small></button>:<div key={cost}/>} )}</div>)}</div>{selected&&<div className="scenario-detail"><div><span>SELECTED SCENARIO</span><b>{clean(selected.market_regime)} · {selected.cost_multiplier}× COST</b><p>{regimeDescriptions[selected.market_regime]}</p></div><div><span>RESULT</span><b className={selected.outcome==='killed'?'red':selected.outcome==='survived'?'green':'amber'}>{selected.outcome}</b><p>{selected.metric_value==null?'Waiting for this test to run.':`Modeled return: ${selected.metric_value}%. ${selected.breach_type?`Failed because it triggered ${clean(selected.breach_type)}.`:'All hard limits remained intact.'}`}</p></div><div><span>VARIANT AUTOPSY</span><p>{activeTest.autopsy||'No autopsy yet; this variant has not completed testing.'}</p></div></div>}</section>
      </section>
    </div>
  </>;
}

function MemorySurface({data}:{data:Snapshot}){return <><div className="panel-title"><b>PERSISTENT WORLD MODEL · WHAT FAILED / WHERE / WHY</b><span>NEGATIVE RESULTS ARE FIRST-CLASS EVIDENCE</span><strong>{data.lessons.filter(l=>!l.incorporated).length} OPEN LOOPS</strong></div><div className="insight-grid">{data.insights.map(i=><article key={i.id}><span>{clean(i.insight_type)} · CONF {i.confidence}</span><h3>{i.title}</h3><p>{i.summary}</p><b>{i.novelty} NOVELTY</b></article>)}</div><div className="memory-table"><div className="table-head"><span>LESSON</span><span>THESIS</span><span>REGIME</span><span>STATE</span></div>{data.lessons.map(l=><div className="table-row" key={l.id}><p><b>{clean(l.lesson_type)}</b>{l.summary}</p><span>{data.theses.find(t=>t.id===l.thesis_id)?.name}</span><span>{l.market_regime}</span><b className={l.incorporated?'green':'amber'}>{l.incorporated?'IN MODEL':'PENDING'}</b></div>)}</div><div className="memory-lower"><section><div className="panel-title"><b>PREREGISTERED PREDICTIONS</b><span>NO MOVING GOALPOSTS</span></div>{data.predictions.map(p=><div className="prediction-row" key={p.id}><b>{p.probability}%</b><p>{p.statement}</p><span>{p.target_date||'TBD'} · {p.status}</span></div>)}</section><section><div className="panel-title"><b>CRITIC OUTPUT</b><span>BEHAVIORAL PATTERNS</span></div>{data.agent_runs.filter(a=>['critic','postmortem'].includes(a.agent_role)).map(a=><div className="critic-row" key={a.id}><b>{a.agent_role}</b><p>{a.summary}</p></div>)}</section></div></>}

function RiskSurface({data}:{data:Snapshot}){
  const purpose:Record<string,string>={max_drawdown:'Stop adding risk when portfolio drawdown reaches the configured ceiling.',max_notional:'Prevent one thesis from consuming too much portfolio equity.',minimum_liquidity:'Reject trades whose spread is too wide for controlled execution.',transaction_cost_stress:'Require every backtest survivor to remain viable after costs are doubled.'};
  const applied:Record<string,string>={max_drawdown:'Before sizing or adding exposure',max_notional:'Before an order may be approved',minimum_liquidity:'At the execution gate',transaction_cost_stress:'Automatically in the scenario matrix'};
  const value=(control:RiskControl)=>{const threshold=JSON.parse(control.threshold_json);return threshold.percent?`${threshold.percent}%`:threshold.percent_of_portfolio_value?`${threshold.percent_of_portfolio_value}% OF PORTFOLIO`:threshold.percent_of_equity?`${threshold.percent_of_equity}% OF EQUITY`:threshold.max_spread_bps?`${threshold.max_spread_bps} BPS`:threshold.multiplier?`${threshold.multiplier}× COST`:'—'};
  return <><div className="risk-status"><div><span>CURRENT REALITY</span><h1>1 control runs automatically</h1><p>The doubled-cost breaker is active in backtests. The portfolio, thesis-sizing, and liquidity limits are defined policies but are not yet wired to broker execution.</p></div><div><b>THRESHOLDS</b><strong>MANUALLY CONFIGURED</strong><span>They change when we deliberately update the research configuration—not from model output.</span></div></div><div className="panel-title"><b>RISK CONTROLS · WHAT THEY DO AND WHEN</b><span>DEFINED IN CODE · NEVER OVERRIDDEN BY A THESIS</span><strong>{data.risk_controls.length} POLICIES</strong></div><div className="risk-grid ergonomic">{data.risk_controls.map(r=>{const automated=r.control_type==='transaction_cost_stress';return <article key={r.id}><span>{r.scope}</span><h2>{clean(r.control_type)}</h2><strong>{value(r)}</strong><p>{purpose[r.control_type]}</p><dl><div><dt>APPLIED</dt><dd>{applied[r.control_type]}</dd></div><div><dt>AUTOMATION</dt><dd className={automated?'green':'amber'}>{automated?'RUNS IN BACKTEST':'POLICY ONLY'}</dd></div><div><dt>UPDATED</dt><dd>MANUAL CONFIG</dd></div></dl></article>})}</div><div className="risk-lower single"><section><div className="panel-title"><b>BREAKER EVIDENCE</b><span>ADVERSARIAL TESTS THAT ACTUALLY RAN</span></div>{data.agent_runs.filter(a=>a.agent_role==='breaker').map(a=><div className="breaker-row" key={a.id}><b>2× TRANSACTION COSTS</b><p>{a.summary}</p><span>INDEPENDENCE GROUP {a.independence_group}</span></div>)}</section></div></>;
}
