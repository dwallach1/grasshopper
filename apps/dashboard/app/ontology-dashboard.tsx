'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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

const PRIMARY_NAV={
  home:{label:'Overview'},
  automations:{label:'Automations'},
  runs:{label:'Runs'},
  risk:{label:'Risk'},
} as const;

const SECONDARY_NAV={
  cycles:{label:'Cycles'},
  memory:{label:'Memory'},
  ontology:{label:'Ontology'},
} as const;

type Surface=keyof typeof PRIMARY_NAV|keyof typeof SECONDARY_NAV;

const SEED_LAYOUT=new Map<string,{x:number;y:number}>(Object.entries({
  ai_power_nuclear:{x:170,y:220},
  neocloud_compute:{x:420,y:130},
  semis_photonics:{x:720,y:200},
  software_ai_apps:{x:820,y:430},
  quantum:{x:520,y:500},
  crypto:{x:240,y:460},
  defense_drones_space:{x:110,y:360},
  biotech_royalty:{x:500,y:320},
}));
const CANVAS_W=1000;
const CANVAS_H=620;
const clean=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ');
function layoutTheses(theses:Thesis[],relations:Relation[]){
  const nodes=new Map<string,{x:number;y:number}>();
  theses.forEach((thesis,index)=>{
    const seed=SEED_LAYOUT.get(thesis.id);
    if(seed){nodes.set(thesis.id,{x:seed.x,y:seed.y});return;}
    const angle=(index/Math.max(theses.length,1))*Math.PI*2-Math.PI/2;
    nodes.set(thesis.id,{x:CANVAS_W/2+Math.cos(angle)*300,y:CANVAS_H/2+Math.sin(angle)*210});
  });
  for(let iter=0;iter<90;iter++){
    const force=new Map<string,{x:number;y:number}>();
    for(const id of nodes.keys())force.set(id,{x:0,y:0});
    const ids=[...nodes.keys()];
    for(let i=0;i<ids.length;i++){
      for(let j=i+1;j<ids.length;j++){
        const a=nodes.get(ids[i])!,b=nodes.get(ids[j])!;
        const dx=a.x-b.x,dy=a.y-b.y,dist=Math.hypot(dx,dy)||1;
        const push=9000/(dist*dist);
        const fx=(dx/dist)*push,fy=(dy/dist)*push;
        const fa=force.get(ids[i])!,fb=force.get(ids[j])!;
        fa.x+=fx;fa.y+=fy;fb.x-=fx;fb.y-=fy;
      }
    }
    for(const relation of relations){
      const a=nodes.get(relation.src_thesis_id),b=nodes.get(relation.dst_thesis_id);
      if(!a||!b)continue;
      const dx=b.x-a.x,dy=b.y-a.y,dist=Math.hypot(dx,dy)||1;
      const pull=(dist-200)*0.025*(0.45+relation.strength);
      const fx=(dx/dist)*pull,fy=(dy/dist)*pull;
      const fa=force.get(relation.src_thesis_id)!,fb=force.get(relation.dst_thesis_id)!;
      fa.x+=fx;fa.y+=fy;fb.x-=fx;fb.y-=fy;
    }
    for(const [id,point] of nodes){
      const f=force.get(id)!;
      f.x+=(CANVAS_W/2-point.x)*0.012;
      f.y+=(CANVAS_H/2-point.y)*0.012;
      point.x=Math.min(CANVAS_W-90,Math.max(90,point.x+f.x*0.55));
      point.y=Math.min(CANVAS_H-70,Math.max(70,point.y+f.y*0.55));
    }
  }
  return nodes;
}
function edgePath(a:{x:number;y:number},b:{x:number;y:number}){
  const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,dx=b.x-a.x,dy=b.y-a.y;
  const cx=mx-dy*0.14,cy=my+dx*0.14;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}
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
const currencyPrecise=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
const numberFormatter=new Intl.NumberFormat('en-US');
const dateOnlyFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'});
const shortDateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const fullDateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'});
const timeFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'2-digit',second:'2-digit'});
const formatCurrency=(value:number)=>currencyFormatter.format(value);
const formatCurrencyPrecise=(value:number)=>currencyPrecise.format(value);
const formatNumber=(value:number)=>numberFormatter.format(value);
const formatDateTime=(timestamp:string)=>`${fullDateFormatter.format(new Date(timestamp))} ET`;
const formatShortDateTime=(timestamp:string)=>shortDateFormatter.format(new Date(timestamp));
const formatEventTime=(timestamp:string)=>timeFormatter.format(new Date(timestamp));
const formatDateOnly=(timestamp:string)=>dateOnlyFormatter.format(new Date(timestamp));
const toTitle=(value:string|undefined)=>clean(value||'').replace(/\b\w/g,letter=>letter.toUpperCase());

function formatAge(timestamp:string|undefined,now:number|null){
  if(!timestamp||now===null)return 'Unknown';
  const elapsed=Math.max(0,now-new Date(timestamp).getTime());
  if(elapsed<60_000)return `${Math.floor(elapsed/1000)}s ago`;
  if(elapsed<3_600_000)return `${Math.floor(elapsed/60_000)}m ago`;
  if(elapsed<86_400_000)return `${Math.floor(elapsed/3_600_000)}h ago`;
  return `${Math.floor(elapsed/86_400_000)}d ago`;
}

export function OntologyDashboard({initialData}:{initialData:Snapshot}){
  const router=useRouter();
  const [now,setNow]=useState<number|null>(null);
  const [selectedCycleId,setSelectedCycleId]=useState(initialData.cycles[0]?.id);
  const [selectedTestId,setSelectedTestId]=useState(initialData.tests[0]?.id);
  const [selectedScenarioId,setSelectedScenarioId]=useState(initialData.test_scenarios[0]?.id);
  const [surface,setSurface]=useState<Surface>('home');
  const [focusThesisId,setFocusThesisId]=useState<string|undefined>(initialData.cycles[0]?.thesis_id);
  const [refreshing,setRefreshing]=useState(false);
  const [refreshError,setRefreshError]=useState<string|null>(null);
  const proposalsRef=useRef<HTMLElement|null>(null);

  useEffect(()=>{
    const tick=()=>setNow(Date.now());
    tick();
    const id=window.setInterval(tick,1000);
    return()=>window.clearInterval(id);
  },[]);
  useEffect(()=>{
    const id=window.setInterval(()=>router.refresh(),SNAPSHOT_POLL_MS);
    return()=>window.clearInterval(id);
  },[router]);

  const activeCycle=initialData.cycles.find(c=>c.id===selectedCycleId)||initialData.cycles[0];
  const activeTest=initialData.tests.find(t=>t.id===selectedTestId)||initialData.tests[0];
  const focusedThesisId=focusThesisId||activeCycle?.thesis_id;
  const readyCount=(initialData.trade_proposals||[]).filter(p=>p.status==='ready_for_review').length;

  const robinhoodAt=initialData.account_state?.observed_at;
  const robinhoodAge=!robinhoodAt||now===null?null:Math.max(0,now-new Date(robinhoodAt).getTime());
  const robinhoodTone=robinhoodAge===null?'unknown':robinhoodAge<=ROBINHOOD_MAX_AGE_MS?'fresh':robinhoodAge<=3_600_000?'aging':'stale';
  const isStale=robinhoodTone==='stale'||robinhoodTone==='unknown';

  function selectCycle(cycle:Cycle){
    setSelectedCycleId(cycle.id);
    setFocusThesisId(cycle.thesis_id);
    const test=initialData.tests.find(t=>t.cycle_id===cycle.id);
    if(test){
      setSelectedTestId(test.id);
      const scenario=initialData.test_scenarios.find(s=>s.test_id===test.id);
      if(scenario)setSelectedScenarioId(scenario.id);
    }
  }

  async function refreshRobinhood(){
    if(refreshing)return;
    setRefreshing(true);
    setRefreshError(null);
    try{
      // Broker refresh runs in Cloudflare Workers, not the local webapp.
      throw new Error('Use `bun run cloud:trigger` (research orchestrator) to refresh Robinhood account state.');
    }catch(error){
      setRefreshError(error instanceof Error?error.message:'Refresh failed');
    }finally{
      setRefreshing(false);
    }
  }

  function reviewProposals(){
    proposalsRef.current?.scrollIntoView({behavior:'smooth',block:'start'});
  }

  return <main className="app-shell" id="main-content">
    <a className="skip-link" href="#main-content">Skip to dashboard</a>
    <header className="top-bar">
      <button type="button" className="brand" onClick={()=>setSurface('home')}>ThesisForge</button>
      <nav className="nav-primary" aria-label="Primary">
        {(['home','automations','runs','risk'] as const).map(key=>(
          <button key={key} type="button" className={surface===key?'active':''} onClick={()=>setSurface(key)}>
            {PRIMARY_NAV[key].label}
          </button>
        ))}
      </nav>
      <div className="nav-divider" aria-hidden="true"/>
      <nav className="nav-secondary" aria-label="Research">
        {(['cycles','memory','ontology'] as const).map(key=>(
          <button key={key} type="button" className={surface===key?'active':''} onClick={()=>setSurface(key)}>
            {SECONDARY_NAV[key].label}
          </button>
        ))}
      </nav>
      <div className="top-bar-end">
        <div className={`freshness-chip ${robinhoodTone}`} title={`Published ${formatAge(initialData.generated_at,now)}`}>
          <span className="dot"/>
          <span>Account</span>
          <span className="money">{formatAge(robinhoodAt,now)}</span>
        </div>
        <button
          type="button"
          className={`btn btn-sm ${isStale?'btn-primary':'btn-ghost'}`}
          disabled={refreshing}
          onClick={()=>void refreshRobinhood()}
        >
          {refreshing?'Refreshing…':'Refresh'}
        </button>
      </div>
    </header>
    {refreshError&&<p className="freshness-error" role="alert">{refreshError}</p>}

    <section className="page" aria-live="polite">
      {surface==='home'&&(
        <HomeSurface
          data={initialData}
          activeThesisId={focusedThesisId}
          onFocusThesis={setFocusThesisId}
          readyCount={readyCount}
          isStale={isStale}
          refreshing={refreshing}
          onReview={reviewProposals}
          onRefresh={()=>void refreshRobinhood()}
          proposalsRef={proposalsRef}
        />
      )}
      {surface==='automations'&&<AutomationsSurface data={initialData}/>}
      {surface==='runs'&&<RunsSurface data={initialData}/>}
      {surface==='cycles'&&(
        <CyclesSurface
          data={initialData}
          activeCycle={activeCycle}
          activeTest={activeTest}
          selectedScenarioId={selectedScenarioId}
          onCycle={selectCycle}
          onTest={(test)=>{
            setSelectedTestId(test.id);
            const scenario=initialData.test_scenarios.find(s=>s.test_id===test.id);
            if(scenario)setSelectedScenarioId(scenario.id);
          }}
          onScenario={setSelectedScenarioId}
        />
      )}
      {surface==='memory'&&<MemorySurface data={initialData}/>}
      {surface==='ontology'&&<OntologyManager data={initialData}/>}
      {surface==='risk'&&<RiskSurface data={initialData}/>}
    </section>

    <footer className="app-footer">Preregister · break · learn · deploy</footer>
  </main>;
}

function HomeSurface({
  data,
  activeThesisId,
  onFocusThesis,
  readyCount,
  isStale,
  refreshing,
  onReview,
  onRefresh,
  proposalsRef,
}:{
  data:Snapshot;
  activeThesisId?:string;
  onFocusThesis:(id:string)=>void;
  readyCount:number;
  isStale:boolean;
  refreshing:boolean;
  onReview:()=>void;
  onRefresh:()=>void;
  proposalsRef:RefObject<HTMLElement|null>;
}){
  const ready=(data.trade_proposals||[]).filter(p=>p.status==='ready_for_review');
  const planned=ready.reduce((sum,p)=>sum+p.notional,0);
  const portfolioValue=data.account_state?.total_value||0;
  const buyingPower=data.account_state?.buying_power||0;
  const maxSinglePercent=data.trade_policy?.sizing?.max_single_trade_percent_of_portfolio_value||0;
  const tacticalPercent=data.trade_policy?.sizing?.tactical_swing_sleeve?.target_percent_of_portfolio_value||0;
  const tacticalPositions=data.trade_policy?.sizing?.tactical_swing_sleeve?.target_positions||0;
  const tacticalTarget=portfolioValue*tacticalPercent/100;
  const sleevePct=tacticalTarget?Math.min(100,Math.round(planned/tacticalTarget*100)):0;
  const BrokerAlertsSchema=z.object({gates:z.array(z.string()).optional()}).passthrough();
  const alerts=(proposal:TradeProposal)=>{
    try{
      const parsed=BrokerAlertsSchema.safeParse(JSON.parse(proposal.broker_alerts||'{}'));
      return parsed.success?parsed.data.gates||[]:[];
    }catch{return [];}
  };
  const proposalGates=(proposal:TradeProposal)=>{
    const gates=alerts(proposal);
    return gates.length?gates:['Awaiting recorded quote, evidence, portfolio-risk, and execution gates.'];
  };
  const isDangerGate=(gates:string[])=>gates.some(gate=>/cancel|fail|invalid|reject|stop|weak/i.test(gate));
  const primaryIsReview=readyCount>0;

  return <>
    <div className="home-hero">
      <div className="hero-stack">
        <div>
          <p className="hero-label">Portfolio value</p>
          <p className="hero-value">{portfolioValue?formatCurrencyPrecise(portfolioValue):'—'}</p>
        </div>
        <div className="hero-meta">
          <span>Buying power <b>{buyingPower?formatCurrency(buyingPower):'—'}</b></span>
          <span>{data.account_state?.account_label||'Awaiting refresh'}</span>
          {maxSinglePercent>0&&<span>Max / trade <b>{maxSinglePercent}%</b></span>}
        </div>
        {(tacticalTarget>0||planned>0)&&(
          <div className="sleeve-meter" aria-label="Tactical sleeve">
            <div className="track"><i style={{width:`${sleevePct}%`}}/></div>
            <div className="labels">
              <span>Queued <b>{formatCurrency(planned)}</b></span>
              <span>Sleeve <b>{formatCurrency(tacticalTarget)}</b>{tacticalPositions?` · ${tacticalPositions} max`:''}</span>
            </div>
          </div>
        )}
        <div className="hero-actions">
          {primaryIsReview?(
            <button type="button" className="btn btn-primary" onClick={onReview}>
              Review {readyCount} proposal{readyCount===1?'':'s'}
            </button>
          ):isStale?(
            <button type="button" className="btn btn-primary" disabled={refreshing} onClick={onRefresh}>
              {refreshing?'Refreshing…':'Refresh account'}
            </button>
          ):(
            <span className="hero-label" style={{alignSelf:'center'}}>All clear — no proposals ready</span>
          )}
          {primaryIsReview&&(
            <button type="button" className="btn btn-ghost" disabled={refreshing} onClick={onRefresh}>
              {refreshing?'Refreshing…':'Refresh account'}
            </button>
          )}
        </div>
      </div>
      <div className="quiet-map">
        <span className="map-label">Quiet map</span>
        <QuietMap data={data} activeThesisId={activeThesisId} onFocusThesis={onFocusThesis}/>
      </div>
    </div>

    <section className="proposals-section" ref={proposalsRef}>
      <div className="section-head">
        <h2>Proposals</h2>
        <span>{ready.length} ready{maxSinglePercent?` · ${maxSinglePercent}% max per trade`:''}</span>
      </div>
      {ready.length?(
        <div className="row-list">
          {ready.map(p=>{
            const gates=proposalGates(p);
            const danger=isDangerGate(gates);
            const pct=portfolioValue?`${(p.notional/portfolioValue*100).toFixed(1)}%`:'—';
            return <details className="row-expand proposal-row" key={p.id}>
              <summary>
                <span className="sym">{p.symbol}</span>
                <span className="side">{toTitle(p.side)} · {toTitle(p.order_type)}</span>
                <span className="notional">{formatCurrency(p.notional)}</span>
                <span className="pct">{pct}</span>
                <span className={`status status-pill ${danger?'down':'green'}`}>{danger?'Blocked':'Ready'}</span>
              </summary>
              <div className="row-body">
                <p>{p.rationale}</p>
                <ul>{gates.map(g=><li className={/cancel|fail|invalid|reject|stop|weak/i.test(g)?'danger':''} key={g}>{g}</li>)}</ul>
              </div>
            </details>;
          })}
        </div>
      ):(
        <div className="empty-state">
          <h2>No proposals ready</h2>
          <p>The next workflow run will screen the live ontology and publish only candidates that pass every gate.</p>
        </div>
      )}
    </section>

    {data.insights[0]&&(
      <section style={{marginTop:32}}>
        <div className="section-head"><h2>Latest insight</h2></div>
        <details className="claim">
          <summary>
            <div>
              <span className="claim-title">{data.insights[0].title}</span>
              <span className="claim-meta">{toTitle(data.insights[0].insight_type)} · Conf {data.insights[0].confidence}</span>
            </div>
          </summary>
          <div className="claim-body"><p>{data.insights[0].summary}</p></div>
        </details>
      </section>
    )}
  </>;
}

function QuietMap({data,activeThesisId,onFocusThesis}:{data:Snapshot;activeThesisId?:string;onFocusThesis:(id:string)=>void}){
  const layout=useMemo(()=>layoutTheses(data.theses,data.relations),[data.theses,data.relations]);
  const focused=data.theses.find(t=>t.id===activeThesisId)||data.theses[0];
  const linked=useMemo(()=>{
    if(!focused)return new Set<string>();
    const ids=new Set<string>([focused.id]);
    for(const relation of data.relations){
      if(relation.src_thesis_id===focused.id)ids.add(relation.dst_thesis_id);
      if(relation.dst_thesis_id===focused.id)ids.add(relation.src_thesis_id);
    }
    return ids;
  },[data.relations,focused]);

  return <div className="signal-graph" role="img" aria-label="Thesis signal map">
    {!data.theses.length&&(
      <div className="canvas-empty">
        <b>Waiting for theses</b>
        <p>When research cycles publish theses and relations, they appear here.</p>
      </div>
    )}
    <svg className="signal-edges" viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {data.relations.map(relation=>{
        const a=layout.get(relation.src_thesis_id),b=layout.get(relation.dst_thesis_id);
        if(!a||!b)return null;
        const hot=Boolean(focused&&(relation.src_thesis_id===focused.id||relation.dst_thesis_id===focused.id));
        return <path
          key={`${relation.src_thesis_id}->${relation.dst_thesis_id}:${relation.relation_type}`}
          className={`signal-edge${hot?' hot':''}`}
          d={edgePath(a,b)}
          style={{opacity:hot?Math.max(0.45,relation.strength):Math.max(0.2,relation.strength*0.4)}}
        >
          <title>{`${toTitle(relation.relation_type)} · ${Math.round(relation.strength*100)}% · ${relation.rationale}`}</title>
        </path>;
      })}
    </svg>
    {data.theses.map(thesis=>{
      const point=layout.get(thesis.id)||{x:CANVAS_W/2,y:CANVAS_H/2};
      const isActive=thesis.id===activeThesisId;
      const isLinked=linked.has(thesis.id);
      const size=6+Math.min(8,thesis.confidence/12);
      return <button
        type="button"
        key={thesis.id}
        className={`signal-node ${isActive?'active':''}${isLinked&&!isActive?' linked':''}`}
        style={{left:`${(point.x/CANVAS_W)*100}%`,top:`${(point.y/CANVAS_H)*100}%`}}
        title={thesis.summary}
        onClick={()=>onFocusThesis(thesis.id)}
      >
        <span className="node-dot" style={isActive||isLinked?undefined:{width:size,height:size}}/>
        <b>{thesis.name.replace(' basket','').replace('AI ','')}</b>
      </button>;
    })}
    {focused&&(
      <aside className="canvas-dossier">
        <span>{toTitle(focused.stance)} · conf {focused.confidence}</span>
        <b>{focused.name}</b>
        <p>{focused.summary}</p>
      </aside>
    )}
  </div>;
}

function RunsSurface({data}:{data:Snapshot}){
  const reports=data.run_reports||[];
  if(!reports.length)return <div className="empty-state"><h2>No run reports yet</h2><p>Scheduled workers publish a recap after completing their next investigation.</p></div>;
  return <section>
    <h1 className="surface-title">Runs</h1>
    <div className="run-list">
      {reports.map(report=>(
        <details className="claim" key={report.id}>
          <summary>
            <div>
              <span className="claim-title">{report.headline}</span>
              <span className="claim-meta">{formatDateTime(report.started_at)} · {toTitle(report.run_type)} · {toTitle(report.status)}</span>
            </div>
          </summary>
          <div className="claim-body">
            <p>{report.summary}</p>
            <div className="run-report-columns">
              <RunReportColumn label="New insights" items={report.insights}/>
              <RunReportColumn label="Learnings / risks" items={report.learnings}/>
              <RunReportColumn label="Actions" items={report.actions}/>
            </div>
            {Object.keys(report.metrics||{}).length>0&&(
              <footer className="run-metrics">
                {Object.entries(report.metrics).map(([key,value])=>(
                  <span key={key}>{toTitle(key)} <b>{String(value)}</b></span>
                ))}
              </footer>
            )}
          </div>
        </details>
      ))}
    </div>
  </section>;
}

function RunReportColumn({label,items}:{label:string;items:string[]}){
  return <section>
    <b>{label}</b>
    {items.length?<ul>{items.map((item,index)=><li key={`${label}-${index}`}>{item}</li>)}</ul>:<p>None recorded.</p>}
  </section>;
}

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
  const chooseAutomation=(id:string)=>{
    setAutomationId(id);
    const next=id==='all'?runs[0]:runs.find(run=>run.automation_id===id);
    setRunId(next?.thread_id||'');
  };
  if(!automations.length)return <div className="empty-state"><h2>No worker jobs published</h2><p>Worker runs appear here after the next event-driven dashboard refresh.</p></div>;
  return <section>
    <h1 className="surface-title">Automations</h1>
    <div className="automation-layout">
      <aside className="automation-list">
        <button type="button" className={automationId==='all'?'active':''} onClick={()=>chooseAutomation('all')}>
          <span>All</span>
          <b>All automations</b>
          <small>{runs.length} runs</small>
        </button>
        {automations.map(job=>(
          <button type="button" className={automationId===job.id?'active':''} key={job.id} onClick={()=>chooseAutomation(job.id)}>
            <span>{toTitle(job.status)} · {job.model||'Default model'}</span>
            <b>{job.name}</b>
            <small>{describeSchedule(job.rrule)}</small>
            <i>{job.passed_count} pass / {job.failed_count} fail</i>
          </button>
        ))}
      </aside>
      <section className="automation-runs">
        <div className="automation-table-head">
          <span>Start</span>
          <span>Automation</span>
          <span>Outcome</span>
          <span>Duration</span>
          <span>Summary</span>
        </div>
        {filtered.length?filtered.map(run=>(
          <button
            type="button"
            key={run.thread_id}
            className={`${run.outcome} ${selected?.thread_id===run.thread_id?'active':''}`}
            onClick={()=>setRunId(run.thread_id)}
          >
            <span>{formatShortDateTime(run.started_at)}</span>
            <b>{run.automation_name}</b>
            <strong className={run.outcome==='passed'?'green':run.outcome==='failed'?'red':''}>{toTitle(run.outcome)}</strong>
            <span>{formatDuration(run.duration_ms)}</span>
            <p>{run.summary||run.title||'No run summary recorded.'}</p>
          </button>
        )):<div className="automation-empty">No runs for this automation yet</div>}
      </section>
    </div>
    {selected&&<AutomationRunDetail run={selected}/>}
  </section>;
}

function AutomationRunDetail({run}:{run:AutomationRun}){
  const sections=[['Findings',run.findings],['Learned',run.learnings],['Explored',run.explored],['Actions',run.actions]] as const;
  return <article className="automation-detail">
    <header>
      <div>
        <span>Run · {run.thread_id}</span>
        <h2>{run.title||run.automation_name}</h2>
        <p>{run.summary||'No concise summary was recorded.'}</p>
      </div>
      <div>
        <strong className={run.outcome==='passed'?'green':run.outcome==='failed'?'red':'amber'}>{toTitle(run.outcome)}</strong>
        <b>{formatDuration(run.duration_ms)}</b>
        <span>{run.tokens_used?formatNumber(run.tokens_used):'—'} tokens</span>
      </div>
    </header>
    <div className="automation-findings">
      {sections.map(([label,items])=>(
        <section key={label}>
          <b>{label}</b>
          {items.length?<ul>{items.map((item,index)=><li key={index}>{item}</li>)}</ul>:<p>Nothing separately classified.</p>}
        </section>
      ))}
    </div>
    {run.timeline.length>0&&(
      <details className="automation-timeline">
        <summary>Investigation trail · {run.timeline.length} checkpoints</summary>
        {run.timeline.map((event,index)=>(
          <div key={index}>
            <span>{event.at?formatEventTime(event.at):`0${index+1}`}</span>
            <p>{event.text}</p>
          </div>
        ))}
      </details>
    )}
    {run.final_output&&(
      <details className="automation-output">
        <summary>Full final report</summary>
        <pre>{run.final_output}</pre>
      </details>
    )}
    {run.error_text&&<pre className="automation-error">{run.error_text}</pre>}
  </article>;
}

function CyclesSurface({
  data,
  activeCycle,
  activeTest,
  selectedScenarioId,
  onCycle,
  onTest,
  onScenario,
}:{
  data:Snapshot;
  activeCycle?:Cycle;
  activeTest?:Test;
  selectedScenarioId?:number;
  onCycle:(cycle:Cycle)=>void;
  onTest:(test:Test)=>void;
  onScenario:(id:number)=>void;
}){
  if(!activeCycle||!activeTest){
    return <div className="empty-state"><h2>No research cycles yet</h2><p>Once the orchestrator writes a cycle and test into the snapshot, this page shows the active thesis, variants, and scenario wall.</p></div>;
  }
  const activeThesis=data.theses.find(t=>t.id===activeCycle.thesis_id)||data.theses[0];
  const tests=data.tests.filter(t=>t.cycle_id===activeCycle.id);
  const scenarios=data.test_scenarios.filter(s=>s.test_id===activeTest.id);
  const selected=scenarios.find(s=>s.id===selectedScenarioId)||scenarios[0];
  const regimes=[...new Set(scenarios.map(s=>s.market_regime))];
  return <>
    <h1 className="surface-title">Cycles</h1>
    <div className="pipeline-row">
      {stages.map(stage=>{
        const count=data.cycles.filter(c=>c.stage===stage).length;
        return <div key={stage} className={`pipeline-stage ${activeCycle.stage===stage?'active':''}`}>
          <b>{toTitle(stage)}</b>
          <span>{count||'—'} {count===1?'cycle':'cycles'}</span>
        </div>;
      })}
    </div>
    <div className="cycle-workspace">
      <aside className="cycle-navigator">
        {data.cycles.map(c=>(
          <button type="button" key={c.id} onClick={()=>onCycle(c)} className={c.id===activeCycle.id?'active':''}>
            <span>{toTitle(c.stage)} · Rev {c.iteration}</span>
            <b>{c.thesis_name}</b>
            <small>{toTitle(c.status)} · {toTitle(c.market_regime)}</small>
          </button>
        ))}
      </aside>
      <section>
        <div className="cycle-brief">
          <div>
            <span>Hypothesis</span>
            <h1>{activeCycle.hypothesis}</h1>
          </div>
          <div>
            <span>Success was defined as</span>
            <p>{activeCycle.preregistered_outcome}</p>
          </div>
          <div>
            <span>Invalidated if</span>
            <p>{activeThesis?.falsifier||'No falsifier is recorded for this thesis yet.'}</p>
          </div>
        </div>
        <div className="variant-strip">
          <div className="variant-intro">
            <b>Strategy variants</b>
            <span>Different implementations of this cycle’s hypothesis</span>
          </div>
          {tests.map(t=>(
            <button type="button" key={t.id} onClick={()=>onTest(t)} className={`${t.status} ${t.id===activeTest.id?'active':''}`}>
              <span>{toTitle(t.status)}</span>
              <b>{t.variant_label}</b>
              <p>{variantDescriptions.get(t.variant_label)||'A distinct implementation of the cycle hypothesis.'}</p>
            </button>
          ))}
        </div>
        <section className="kill-wall">
          <div className="section-head">
            <h2>Scenario wall · {activeTest.variant_label}</h2>
            <span>{scenarios.length} scenarios</span>
          </div>
          <div className="wall-explainer">
            <p><b>Variant</b>The trading rules being tested.</p>
            <p><b>Scenario</b>One market regime at normal or doubled transaction cost.</p>
          </div>
          <div className="scenario-table">
            <div className="scenario-head">
              <span>Market condition</span>
              <span>Standard cost · 1×</span>
              <span>Stressed cost · 2×</span>
            </div>
            {regimes.map(regime=>(
              <div className="scenario-row" key={regime}>
                <div>
                  <b>{toTitle(regime)}</b>
                  <p>{regimeDescriptions.get(regime)}</p>
                </div>
                {[1,2].map(cost=>{
                  const scenario=scenarios.find(s=>s.market_regime===regime&&s.cost_multiplier===cost);
                  return scenario?(
                    <button
                      type="button"
                      key={scenario.id}
                      onClick={()=>onScenario(scenario.id)}
                      className={`${scenario.outcome} ${selected?.id===scenario.id?'active':''}`}
                    >
                      <span>{toTitle(scenario.outcome)}</span>
                      <b>{scenario.metric_value==null?'Not run':`${scenario.metric_value>0?'+':''}${scenario.metric_value}%`}</b>
                      <small>{scenario.breach_type?toTitle(scenario.breach_type):'inside limits'}</small>
                    </button>
                  ):<div key={cost}/>;
                })}
              </div>
            ))}
          </div>
          {selected&&(
            <div className="scenario-detail">
              <div>
                <span>Selected scenario</span>
                <b>{toTitle(selected.market_regime)} · {selected.cost_multiplier}× cost</b>
                <p>{regimeDescriptions.get(selected.market_regime)}</p>
              </div>
              <div>
                <span>Result</span>
                <b className={selected.outcome==='killed'?'red':selected.outcome==='survived'?'green':'amber'}>{toTitle(selected.outcome)}</b>
                <p>{selected.metric_value==null?'Waiting for this test to run.':`Modeled return: ${selected.metric_value}%. ${selected.breach_type?`Failed because it triggered ${clean(selected.breach_type)}.`:'All hard limits remained intact.'}`}</p>
              </div>
              <div>
                <span>Variant autopsy</span>
                <p>{activeTest.autopsy||'No autopsy yet; this variant has not completed testing.'}</p>
              </div>
            </div>
          )}
        </section>
      </section>
    </div>
  </>;
}

function MemorySurface({data}:{data:Snapshot}){
  if(!data.lessons.length&&!data.insights.length&&!data.predictions.length){
    return <div className="empty-state"><h2>No memory recorded yet</h2><p>Lessons, insights, and preregistered predictions appear here after research cycles complete.</p></div>;
  }
  const openLoops=data.lessons.filter(l=>!l.incorporated).length;
  return <>
    <h1 className="surface-title">Memory</h1>
    <div className="section-head">
      <h2>Insights</h2>
      <span>{openLoops} open loops</span>
    </div>
    <div className="row-list">
      {data.insights.map(i=>(
        <details className="claim" key={i.id}>
          <summary>
            <div>
              <span className="claim-title">{i.title}</span>
              <span className="claim-meta">{toTitle(i.insight_type)} · Conf {i.confidence} · Novelty {i.novelty}</span>
            </div>
          </summary>
          <div className="claim-body"><p>{i.summary}</p></div>
        </details>
      ))}
    </div>
    <div className="section-head" style={{marginTop:28}}>
      <h2>Lessons</h2>
    </div>
    <div className="memory-table">
      <div className="table-head">
        <span>Lesson</span>
        <span>Thesis</span>
        <span>Regime</span>
        <span>State</span>
      </div>
      {data.lessons.map(l=>(
        <div className="table-row" key={l.id}>
          <p><b>{toTitle(l.lesson_type)}</b>{l.summary}</p>
          <span>{data.theses.find(t=>t.id===l.thesis_id)?.name}</span>
          <span>{toTitle(l.market_regime)}</span>
          <b className={l.incorporated?'green':'amber'}>{l.incorporated?'In model':'Pending'}</b>
        </div>
      ))}
    </div>
    <div className="memory-lower">
      <section>
        <div className="section-head"><h2>Predictions</h2></div>
        {data.predictions.map(p=>(
          <div className="prediction-row" key={p.id}>
            <b>{p.probability}%</b>
            <div>
              <p>{p.statement}</p>
              <span>{p.target_date||'TBD'} · {toTitle(p.status)}</span>
            </div>
          </div>
        ))}
      </section>
      <section>
        <div className="section-head"><h2>Critic</h2></div>
        {data.agent_runs.filter(a=>['critic','postmortem'].includes(a.agent_role)).map(a=>(
          <div className="critic-row" key={a.id}>
            <b>{toTitle(a.agent_role)}</b>
            <p>{a.summary}</p>
          </div>
        ))}
      </section>
    </div>
  </>;
}

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
    return <div className="ontology-controls">
      {items.map(item=>(
        <button
          type="button"
          className={`btn btn-sm ${item.danger?'btn-danger':item.action==='promote'||item.action==='restore'?'btn-primary':'btn-ghost'}`}
          disabled={Boolean(pending)}
          key={item.action}
          onClick={()=>manage(type,key,item.action)}
        >
          {pending===`${type}:${key}:${item.action}`?'Working…':item.label}
        </button>
      ))}
    </div>;
  };

  return <section>
    <h1 className="surface-title">Ontology</h1>
    <p style={{margin:'-8px 0 20px',color:'var(--text-2)',fontSize:13}}>Themes learn from evidence. You can override.</p>
    <div className="ontology-toolbar">
      <div role="tablist" aria-label="Ontology views">
        <button type="button" className={tab==='themes'?'active':''} onClick={()=>setTab('themes')}>Themes</button>
        <button type="button" className={tab==='symbols'?'active':''} onClick={()=>setTab('symbols')}>Symbols</button>
        <button type="button" className={tab==='evidence'?'active':''} onClick={()=>setTab('evidence')}>Evidence + history</button>
      </div>
      {tab!=='evidence'&&(
        <input aria-label={`Search ${tab}`} placeholder={`Search ${tab}`} value={query} onChange={event=>setQuery(event.target.value)}/>
      )}
      <span className={notice.toLowerCase().includes('failed')||notice.toLowerCase().includes('required')?'error':''} aria-live="polite">{notice}</span>
    </div>
    {tab==='themes'&&(
      <div className="ontology-theme-grid">
          {filteredThemes.map(theme=>(
          <article className={`ontology-row ${theme.status}`} key={theme.id}>
            <header>
              <div>
                <span>{toTitle(theme.kind)} · {theme.id}</span>
                <h2>{theme.name}</h2>
              </div>
              <b>{toTitle(theme.status)}</b>
            </header>
            <p>{theme.description||'Emerging source cluster; description will deepen with evidence.'}</p>
            <dl>
              <div><dt>Activation</dt><dd>{theme.auto_promote_sources} sources</dd></div>
              <div><dt>Match floor</dt><dd>{theme.match_threshold}</dd></div>
              <div><dt>Vocabulary</dt><dd>{theme.term_count??'Live'}</dd></div>
              <div><dt>Symbols</dt><dd>{theme.symbol_count??'Live'}</dd></div>
            </dl>
            {controls('theme',theme.id,theme.status)}
          </article>
        ))}
      </div>
    )}
    {tab==='symbols'&&(
      <div className="ontology-symbol-table">
        <div className="ontology-table-head">
          <span>Symbol</span>
          <span>State</span>
          <span>Sources</span>
          <span>Mentions</span>
          <span>Last seen</span>
          <span>Override</span>
        </div>
        {filteredSymbols.map(symbol=>(
          <div className={`ontology-symbol-row ${symbol.status}`} key={symbol.symbol}>
            <b>{symbol.symbol}</b>
            <span>{toTitle(symbol.status)}</span>
            <span>{symbol.source_count}</span>
            <span>{symbol.mention_count}</span>
            <span>{symbol.last_seen_at?formatDateOnly(symbol.last_seen_at):'—'}</span>
            {controls('symbol',symbol.symbol,symbol.status)}
          </div>
        ))}
      </div>
    )}
    {tab==='evidence'&&(
      <div className="ontology-evidence-layout">
        <section>
          <div className="section-head">
            <h2>Evidence queue</h2>
            <span>{candidates.length} signals</span>
          </div>
          {candidates.slice(0,40).map(candidate=>(
            <article className="candidate-row" key={candidate.id}>
              <div>
                <span>{toTitle(candidate.candidate_type)} · {toTitle(candidate.status)}</span>
                <b>{candidate.proposed_label}</b>
                <p>{candidate.proposed_description}</p>
              </div>
              <strong>{candidate.score}<small>Score</small></strong>
              <strong>{candidate.source_count}<small>Sources</small></strong>
            </article>
          ))}
        </section>
        <aside>
          <div className="section-head"><h2>History</h2></div>
          {actions.length?actions.slice(0,40).map(action=>(
            <div className="ontology-action" key={action.id}>
              <b>{toTitle(action.action)}</b>
              <span>{toTitle(action.entity_type)} · {action.entity_key}</span>
              <small>{formatDateTime(action.created_at)}</small>
            </div>
          )):<p className="ontology-no-actions">No overrides yet.</p>}
        </aside>
      </div>
    )}
  </section>;
}

function RiskSurface({data}:{data:Snapshot}){
  const purpose=new Map(Object.entries({
    max_drawdown:'Stop adding risk when portfolio drawdown reaches the configured ceiling.',
    max_notional:'Prevent one thesis from consuming too much portfolio equity.',
    minimum_liquidity:'Reject trades whose spread is too wide for controlled execution.',
    transaction_cost_stress:'Require every backtest survivor to remain viable after costs are doubled.',
  }));
  const applied=new Map(Object.entries({
    max_drawdown:'Before sizing or adding exposure',
    max_notional:'Before an order may be approved',
    minimum_liquidity:'At the execution gate',
    transaction_cost_stress:'Automatically in the scenario matrix',
  }));
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
  const automatedCount=data.risk_controls.filter(r=>r.control_type==='transaction_cost_stress').length;
  const policyOnly=data.risk_controls.length-automatedCount;
  return <>
    <h1 className="surface-title">Risk</h1>
    <div className="risk-status">
      <div>
        <span>Current reality</span>
        <h1>{automatedCount} control{automatedCount===1?'':'s'} enforced · {policyOnly} policy only</h1>
        <p>The doubled-cost breaker runs in backtests. Portfolio, thesis-sizing, and liquidity limits are defined but not yet wired to broker execution.</p>
      </div>
      <div>
        <b>Thresholds</b>
        <strong>Manually configured</strong>
        <span>They change with research config, not model output.</span>
      </div>
    </div>
    <div className="section-head">
      <h2>Controls</h2>
      <span>{data.risk_controls.length} policies</span>
    </div>
    <div className="risk-list">
      {data.risk_controls.map(r=>{
        const automated=r.control_type==='transaction_cost_stress';
        return <div className="risk-row" key={r.id}>
          <div className="name">
            <span>{toTitle(r.scope)}</span>
            <h2>{toTitle(r.control_type)}</h2>
            <p>{purpose.get(r.control_type)}</p>
          </div>
          <div className="threshold">{value(r)}</div>
          <div className="applied">{applied.get(r.control_type)}</div>
          <div className={`auto ${automated?'green':'amber'}`}>{automated?'Enforced':'Policy only'}</div>
        </div>;
      })}
    </div>
    <div className="section-head" style={{marginTop:28}}>
      <h2>Breaker evidence</h2>
    </div>
    {data.agent_runs.filter(a=>a.agent_role==='breaker').map(a=>(
      <div className="breaker-row" key={a.id}>
        <b>2× transaction costs</b>
        <p>{a.summary}</p>
        <span>Independence group {a.independence_group}</span>
      </div>
    ))}
  </>;
}
