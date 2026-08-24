-- Initial ontology vocabulary. These rows bootstrap the catalog only; reruns do
-- not overwrite learned or manually reviewed database state.

insert into public.ontology_themes(
  id, kind, name, description, status, match_threshold,
  auto_promote_sources, created_by, created_at, updated_at
)
values
  ('ai_power_nuclear', 'theme', 'AI power bottleneck beneficiaries', 'AI compute demand, electricity, grid, nuclear fuel, and generation scarcity.', 'active', 30, 3, 'bootstrap', now(), now()),
  ('neocloud_compute', 'theme', 'Neocloud and GPU compute', 'GPU cloud capacity, data centers, utilization, financing, and compute infrastructure.', 'active', 30, 3, 'bootstrap', now(), now()),
  ('semis_photonics', 'theme', 'Semiconductors and photonics', 'Semiconductors, memory, networking, optical interconnects, and AI cluster components.', 'active', 30, 3, 'bootstrap', now(), now()),
  ('defense_drones_space', 'theme', 'Defense, drones, and space', 'Defense autonomy, drones, launch, satellites, and space infrastructure.', 'active', 35, 3, 'bootstrap', now(), now()),
  ('quantum', 'theme', 'Quantum computing', 'Quantum hardware, software, commercialization, and speculative momentum.', 'active', 35, 3, 'bootstrap', now(), now()),
  ('biotech_royalty', 'theme', 'Biotech and royalty economics', 'Biotechnology, pharmaceutical catalysts, trials, and royalty-based economics.', 'active', 35, 3, 'bootstrap', now(), now()),
  ('crypto', 'theme', 'Crypto and decentralized AI', 'Crypto assets, blockchain infrastructure, decentralized compute, and digital-asset optionality.', 'active', 35, 3, 'bootstrap', now(), now()),
  ('software_ai_apps', 'theme', 'AI software and applications', 'AI applications, agents, developer tools, SaaS, and model monetization.', 'active', 35, 3, 'bootstrap', now(), now()),
  ('ai_power', 'concept', 'AI power', 'Power demand, generation, grid capacity, and data-center electricity constraints.', 'active', 30, 3, 'bootstrap', now(), now()),
  ('nuclear', 'concept', 'Nuclear energy', 'Nuclear generation, reactors, uranium, and the fuel cycle.', 'active', 30, 3, 'bootstrap', now(), now()),
  ('neocloud', 'concept', 'Neocloud', 'Specialized GPU cloud and AI compute providers.', 'active', 30, 3, 'bootstrap', now(), now()),
  ('photonics', 'concept', 'Photonics', 'Optical networking, transceivers, and high-speed data-center interconnects.', 'active', 30, 3, 'bootstrap', now(), now()),
  ('ipo_events', 'concept', 'IPO events', 'Listings, registrations, roadshows, lockups, and public offerings.', 'active', 35, 3, 'bootstrap', now(), now()),
  ('earnings_events', 'concept', 'Earnings events', 'Earnings, guidance, estimates, and quarterly operating updates.', 'active', 35, 3, 'bootstrap', now(), now()),
  ('crypto_ai', 'concept', 'Crypto AI', 'Decentralized AI networks and crypto-linked compute.', 'active', 35, 3, 'bootstrap', now(), now())
on conflict (id) do nothing;

insert into public.ontology_terms(
  theme_id, term, normalized_term, term_type, weight, status,
  created_by, created_at, updated_at
)
values
  ('ai_power_nuclear', 'power', 'power', 'keyword', 55, 'active', 'bootstrap', now(), now()),
  ('ai_power_nuclear', 'electricity', 'electricity', 'keyword', 60, 'active', 'bootstrap', now(), now()),
  ('ai_power_nuclear', 'electric', 'electric', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('ai_power_nuclear', 'nuclear', 'nuclear', 'keyword', 70, 'active', 'bootstrap', now(), now()),
  ('ai_power_nuclear', 'uranium', 'uranium', 'keyword', 70, 'active', 'bootstrap', now(), now()),
  ('ai_power_nuclear', 'grid', 'grid', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('ai_power_nuclear', 'data center', 'data center', 'phrase', 55, 'active', 'bootstrap', now(), now()),
  ('neocloud_compute', 'neocloud', 'neocloud', 'keyword', 80, 'active', 'bootstrap', now(), now()),
  ('neocloud_compute', 'gpu cloud', 'gpu cloud', 'phrase', 80, 'active', 'bootstrap', now(), now()),
  ('neocloud_compute', 'gpu', 'gpu', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('neocloud_compute', 'compute', 'compute', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('neocloud_compute', 'data center', 'data center', 'phrase', 45, 'active', 'bootstrap', now(), now()),
  ('neocloud_compute', 'cluster', 'cluster', 'keyword', 40, 'active', 'bootstrap', now(), now()),
  ('semis_photonics', 'semiconductor', 'semiconductor', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('semis_photonics', 'semis', 'semis', 'alias', 60, 'active', 'bootstrap', now(), now()),
  ('semis_photonics', 'photonics', 'photonics', 'keyword', 80, 'active', 'bootstrap', now(), now()),
  ('semis_photonics', 'optical', 'optical', 'keyword', 70, 'active', 'bootstrap', now(), now()),
  ('semis_photonics', 'transceiver', 'transceiver', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('semis_photonics', 'memory', 'memory', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('semis_photonics', 'chip', 'chip', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('defense_drones_space', 'defense', 'defense', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('defense_drones_space', 'drone', 'drone', 'keyword', 70, 'active', 'bootstrap', now(), now()),
  ('defense_drones_space', 'autonomy', 'autonomy', 'keyword', 55, 'active', 'bootstrap', now(), now()),
  ('defense_drones_space', 'space', 'space', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('defense_drones_space', 'rocket', 'rocket', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('defense_drones_space', 'satellite', 'satellite', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('quantum', 'quantum', 'quantum', 'keyword', 90, 'active', 'bootstrap', now(), now()),
  ('biotech_royalty', 'biotech', 'biotech', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('biotech_royalty', 'pharma', 'pharma', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('biotech_royalty', 'clinical trial', 'clinical trial', 'phrase', 70, 'active', 'bootstrap', now(), now()),
  ('biotech_royalty', 'royalty', 'royalty', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('crypto', 'crypto', 'crypto', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('crypto', 'bitcoin', 'bitcoin', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('crypto', 'ethereum', 'ethereum', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('crypto', 'blockchain', 'blockchain', 'keyword', 65, 'active', 'bootstrap', now(), now()),
  ('software_ai_apps', 'software', 'software', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('software_ai_apps', 'agent', 'agent', 'keyword', 45, 'active', 'bootstrap', now(), now()),
  ('software_ai_apps', 'saas', 'saas', 'keyword', 55, 'active', 'bootstrap', now(), now()),
  ('software_ai_apps', 'developer tools', 'developer tools', 'phrase', 60, 'active', 'bootstrap', now(), now()),
  ('software_ai_apps', 'model', 'model', 'keyword', 35, 'active', 'bootstrap', now(), now()),
  ('ai_power', 'power', 'power', 'keyword', 60, 'active', 'bootstrap', now(), now()),
  ('ai_power', 'grid', 'grid', 'keyword', 70, 'active', 'bootstrap', now(), now()),
  ('ai_power', 'data center', 'data center', 'phrase', 55, 'active', 'bootstrap', now(), now()),
  ('nuclear', 'nuclear', 'nuclear', 'keyword', 85, 'active', 'bootstrap', now(), now()),
  ('nuclear', 'uranium', 'uranium', 'keyword', 80, 'active', 'bootstrap', now(), now()),
  ('nuclear', 'reactor', 'reactor', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('nuclear', 'fuel cycle', 'fuel cycle', 'phrase', 70, 'active', 'bootstrap', now(), now()),
  ('neocloud', 'neocloud', 'neocloud', 'keyword', 90, 'active', 'bootstrap', now(), now()),
  ('neocloud', 'gpu cloud', 'gpu cloud', 'phrase', 85, 'active', 'bootstrap', now(), now()),
  ('photonics', 'photonics', 'photonics', 'keyword', 90, 'active', 'bootstrap', now(), now()),
  ('photonics', 'optical', 'optical', 'keyword', 80, 'active', 'bootstrap', now(), now()),
  ('photonics', 'transceiver', 'transceiver', 'keyword', 80, 'active', 'bootstrap', now(), now()),
  ('ipo_events', 'ipo', 'ipo', 'keyword', 80, 'active', 'bootstrap', now(), now()),
  ('ipo_events', 'public offering', 'public offering', 'phrase', 80, 'active', 'bootstrap', now(), now()),
  ('ipo_events', 'roadshow', 'roadshow', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('ipo_events', 'lockup', 'lockup', 'keyword', 70, 'active', 'bootstrap', now(), now()),
  ('earnings_events', 'earnings', 'earnings', 'keyword', 85, 'active', 'bootstrap', now(), now()),
  ('earnings_events', 'guidance', 'guidance', 'keyword', 75, 'active', 'bootstrap', now(), now()),
  ('earnings_events', 'eps', 'eps', 'alias', 65, 'active', 'bootstrap', now(), now()),
  ('crypto_ai', 'bittensor', 'bittensor', 'entity', 90, 'active', 'bootstrap', now(), now()),
  ('crypto_ai', 'decentralized ai', 'decentralized ai', 'phrase', 85, 'active', 'bootstrap', now(), now())
on conflict (theme_id, normalized_term) do nothing;

insert into public.ontology_lexicon(token, token_type, weight, status, reason, created_at, updated_at)
select token, 'ignored_symbol', 0, 'active', 'Common uppercase token, not a verified ticker', now(), now()
from unnest(array[
  'A','AI','AM','AN','AND','API','ARE','ATH','BE','BEST','BUT','CAD','CEO','CLI','CPI','DD','DM','DOM',
  'EPS','ETF','EV','FCF','FIB','FOMC','FOR','FYI','GDP','GPU','GPT','HDD','HTTP','HTTPS','I','IMO','IP',
  'MCP','MIT','OF','OUT','PE','PM','RL','RSI','RUN','SAVE','SDK','SEC','THE','THIS','TS','UI','US','USA',
  'USD','WAL','WE','YOU','YOUR'
]::text[]) token
on conflict (token, token_type) do nothing;

insert into public.ontology_lexicon(token, token_type, weight, status, reason, created_at, updated_at)
values
  ('stock', 'market_keyword', 8, 'active', null, now(), now()),
  ('market', 'market_keyword', 8, 'active', null, now(), now()),
  ('earnings', 'market_keyword', 8, 'active', null, now(), now()),
  ('valuation', 'market_keyword', 8, 'active', null, now(), now()),
  ('revenue', 'market_keyword', 8, 'active', null, now(), now()),
  ('margin', 'market_keyword', 8, 'active', null, now(), now()),
  ('cash flow', 'market_keyword', 8, 'active', null, now(), now()),
  ('guidance', 'market_keyword', 8, 'active', null, now(), now()),
  ('portfolio', 'market_keyword', 8, 'active', null, now(), now()),
  ('inflation', 'market_keyword', 8, 'active', null, now(), now()),
  ('price target', 'market_keyword', 8, 'active', null, now(), now()),
  ('13f', 'market_keyword', 8, 'active', null, now(), now()),
  ('financial', 'market_context', 8, 'active', null, now(), now()),
  ('investments', 'market_context', 8, 'active', null, now(), now()),
  ('business', 'market_context', 8, 'active', null, now(), now())
on conflict (token, token_type) do nothing;

insert into public.ontology_lexicon(token, token_type, weight, status, reason, created_at, updated_at)
select token, 'candidate_stopword', 0, 'active', 'Low-information language token', now(), now()
from unnest(array[
  'about','after','again','also','because','before','being','could','from','have','into','just','more','most',
  'other','over','should','than','that','their','there','these','they','this','those','through','under','very',
  'what','when','where','which','while','will','with','would','your'
]::text[]) token
on conflict (token, token_type) do nothing;

-- Known symbols become database entities before memberships are added. Future
-- discoveries are inserted by ingestion with status='candidate'.
insert into public.symbols(symbol, first_seen_at, last_seen_at, mention_count, source_count, status)
select symbol, now(), now(), 0, 0, 'known'
from unnest(array[
  'AAOI','AEHR','AEP','ASTS','AVAV','AVGO','BTC-USD','CCJ','CEG','COHR','COIN','CORZ','CRWV','GEV','HIMS',
  'HOOD','HUT','IBRX','IONQ','IREN','KTOS','LEU','LITE','LLY','MRCY','MRVL','MU','NBIS','NVDA','OABI',
  'OKLO','ONDS','PL','QBTS','RCAT','RDW','RGTI','RKLB','SMR','SNDK','TAO-USD','TLN','UUUU','VST'
]::text[]) symbol
on conflict (symbol) do nothing;

insert into public.symbol_theme_memberships(
  symbol, theme_id, relationship, confidence, evidence_count, source_count,
  status, learned_by, first_seen_at, last_seen_at
)
values
  ('CEG','ai_power_nuclear','beneficiary',90,1,1,'active','bootstrap',now(),now()),
  ('LEU','ai_power_nuclear','beneficiary',85,1,1,'active','bootstrap',now(),now()),
  ('OKLO','ai_power_nuclear','beneficiary',80,1,1,'active','bootstrap',now(),now()),
  ('SMR','ai_power_nuclear','beneficiary',80,1,1,'active','bootstrap',now(),now()),
  ('CCJ','ai_power_nuclear','supplier',85,1,1,'active','bootstrap',now(),now()),
  ('VST','ai_power_nuclear','beneficiary',90,1,1,'active','bootstrap',now(),now()),
  ('TLN','ai_power_nuclear','beneficiary',80,1,1,'active','bootstrap',now(),now()),
  ('GEV','ai_power_nuclear','supplier',85,1,1,'active','bootstrap',now(),now()),
  ('UUUU','ai_power_nuclear','supplier',75,1,1,'active','bootstrap',now(),now()),
  ('IREN','neocloud_compute','member',90,1,1,'active','bootstrap',now(),now()),
  ('NBIS','neocloud_compute','member',90,1,1,'active','bootstrap',now(),now()),
  ('HUT','neocloud_compute','member',80,1,1,'active','bootstrap',now(),now()),
  ('CORZ','neocloud_compute','member',80,1,1,'active','bootstrap',now(),now()),
  ('CRWV','neocloud_compute','member',90,1,1,'active','bootstrap',now(),now()),
  ('AAOI','semis_photonics','member',90,1,1,'active','bootstrap',now(),now()),
  ('LITE','semis_photonics','member',90,1,1,'active','bootstrap',now(),now()),
  ('COHR','semis_photonics','member',90,1,1,'active','bootstrap',now(),now()),
  ('AEHR','semis_photonics','member',75,1,1,'active','bootstrap',now(),now()),
  ('MRVL','semis_photonics','supplier',85,1,1,'active','bootstrap',now(),now()),
  ('NVDA','semis_photonics','supplier',75,1,1,'active','bootstrap',now(),now()),
  ('AVGO','semis_photonics','supplier',80,1,1,'active','bootstrap',now(),now()),
  ('MU','semis_photonics','supplier',75,1,1,'active','bootstrap',now(),now()),
  ('SNDK','semis_photonics','supplier',70,1,1,'active','bootstrap',now(),now()),
  ('ONDS','defense_drones_space','member',80,1,1,'active','bootstrap',now(),now()),
  ('AVAV','defense_drones_space','member',85,1,1,'active','bootstrap',now(),now()),
  ('KTOS','defense_drones_space','member',80,1,1,'active','bootstrap',now(),now()),
  ('MRCY','defense_drones_space','member',75,1,1,'active','bootstrap',now(),now()),
  ('RKLB','defense_drones_space','member',85,1,1,'active','bootstrap',now(),now()),
  ('ASTS','defense_drones_space','member',75,1,1,'active','bootstrap',now(),now()),
  ('PL','defense_drones_space','member',70,1,1,'active','bootstrap',now(),now()),
  ('RDW','defense_drones_space','member',75,1,1,'active','bootstrap',now(),now()),
  ('RCAT','defense_drones_space','member',80,1,1,'active','bootstrap',now(),now()),
  ('IONQ','quantum','member',90,1,1,'active','bootstrap',now(),now()),
  ('RGTI','quantum','member',90,1,1,'active','bootstrap',now(),now()),
  ('QBTS','quantum','member',90,1,1,'active','bootstrap',now(),now()),
  ('OABI','biotech_royalty','member',80,1,1,'active','bootstrap',now(),now()),
  ('LLY','biotech_royalty','member',70,1,1,'active','bootstrap',now(),now()),
  ('IBRX','biotech_royalty','member',75,1,1,'active','bootstrap',now(),now()),
  ('HIMS','biotech_royalty','member',65,1,1,'active','bootstrap',now(),now()),
  ('BTC-USD','crypto','proxy',90,1,1,'active','bootstrap',now(),now()),
  ('TAO-USD','crypto','member',90,1,1,'active','bootstrap',now(),now()),
  ('COIN','crypto','proxy',80,1,1,'active','bootstrap',now(),now()),
  ('HOOD','crypto','proxy',65,1,1,'active','bootstrap',now(),now()),
  ('VST','ai_power','beneficiary',90,1,1,'active','bootstrap',now(),now()),
  ('CEG','ai_power','beneficiary',90,1,1,'active','bootstrap',now(),now()),
  ('GEV','ai_power','supplier',85,1,1,'active','bootstrap',now(),now()),
  ('OKLO','nuclear','member',85,1,1,'active','bootstrap',now(),now()),
  ('LEU','nuclear','supplier',90,1,1,'active','bootstrap',now(),now()),
  ('CCJ','nuclear','supplier',90,1,1,'active','bootstrap',now(),now()),
  ('IREN','neocloud','member',90,1,1,'active','bootstrap',now(),now()),
  ('NBIS','neocloud','member',90,1,1,'active','bootstrap',now(),now()),
  ('CRWV','neocloud','member',90,1,1,'active','bootstrap',now(),now()),
  ('AAOI','photonics','member',90,1,1,'active','bootstrap',now(),now()),
  ('COHR','photonics','member',90,1,1,'active','bootstrap',now(),now()),
  ('LITE','photonics','member',90,1,1,'active','bootstrap',now(),now()),
  ('TAO-USD','crypto_ai','member',90,1,1,'active','bootstrap',now(),now())
on conflict (symbol, theme_id) do nothing;
