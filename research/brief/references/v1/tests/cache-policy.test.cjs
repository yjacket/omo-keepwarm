const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../dist/cache-policy.js');
const costs = p.baselineCosts({contextTokens:150_000});
const options = {ttlMs:300_000, intervalMs:270_000, remainingTtlMs:30_000,
  sharedCachePersists:true, allowParking:true};
const point = (minutes, probability=1) => ({afterMs:minutes*60_000, probability});
const forecast = (returns, neverReturnsProbability=0) => ({returns,neverReturnsProbability});
const near = (actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`);

test('usage items are disjoint and weighted once',()=>{
  near(p.equivalentCost({input:1000,write5m:2000,write1h:3000,read:4000,output:500}),12400);
});
test('invalid usage is rejected',()=>assert.throws(()=>p.equivalentCost({input:-1,write5m:0,write1h:0,read:0,output:0})));
test('baseline 150K => warm 15K, parent 45K, child 25K',()=>{
  assert.equal(costs.warmEq,15_000); assert.equal(costs.parkNowEq,45_000);
  assert.equal(costs.restoreWarmEq,25_000); assert.equal(costs.coldSharedEq,158_750);
  assert.equal(costs.coldFullEq,187_500); near(costs.sharedLossEq,28_750);
});
test('shared prefix cannot be larger than context',()=>assert.throws(()=>p.baselineCosts({contextTokens:10_000})));
test('crossovers for all 6 sizes and 3 TTLs bracket parking cost',()=>{
  const expectedCalls=[9,5,4,3,3,2];
  [50_000,100_000,150_000,200_000,300_000,500_000].forEach((C,i)=>{
    const c=p.baselineCosts({contextTokens:C});
    for(const ttl of [300_000,1_800_000,3_600_000]){
      const interval=ttl*.9, P=c.parkNowEq+c.restoreWarmEq;
      const x=p.crossover(P,c.rawWarmEq,c.warmEq,interval);
      assert.equal(x.warmCalls,expectedCalls[i]);
      assert.ok(x.preCrossingCostEq<P); assert.ok(x.postCrossingCostEq>=P);
      assert.equal(x.crossingAtMs,expectedCalls[i]*interval);
    }
  });
});
test('150K skill or lost shared cache shifts crossing',()=>{
  const minutes=P=>p.crossover(P,15000,15000,270000).crossingAtMs/60000;
  assert.equal(minutes(70000),18); assert.equal(minutes(81000),22.5);
  assert.equal(minutes(98750),27); assert.equal(minutes(109750),31.5);
});
test('no-cost warming does not yield division by zero',()=>assert.equal(p.crossover(70000,15000,0,270000).warmCalls,Infinity));
test('no warm needed when parking already costs no more than warm resume',()=>assert.equal(p.crossover(10,15,5,270000).warmCalls,0));
test('return wins exact timer boundary',()=>{
  assert.equal(p.warmCallsBeforeReturn(270000,270000,270000),0);
  assert.equal(p.warmCallsBeforeReturn(270001,270000,270000),1);
  assert.equal(p.warmCallsBeforeReturn(1080000,270000,270000),3);
  assert.equal(p.warmCallsBeforeReturn(1080001,270000,270000),4);
});
test('an already-aged cache schedules its first review from residual TTL',()=>{
  const x=p.crossover(70000,15000,15000,270000,30000);
  assert.equal(x.crossingAtMs,840000);
});
test('return in 20 seconds: no paid action',()=>{
  const r=p.planIdle(costs,forecast([point(1/3)]),options);
  assert.equal(r.action,'LET_EXPIRE'); near(r.expectedCostEq,15000);
});
test('return in 2 minutes: one more warm',()=>{
  const r=p.planIdle(costs,forecast([point(2)]),options);
  assert.equal(r.action,'KEEP_WARM'); near(r.expectedCostEq,30000);
});
test('return in 12 minutes: 3 warms + actual return, not early parking',()=>{
  const r=p.planIdle(costs,forecast([point(12)]),options);
  assert.equal(r.action,'KEEP_WARM'); near(r.expectedCostEq,60000);
});
test('return in 1 hour: park now',()=>{
  const r=p.planIdle(costs,forecast([point(60)]),options);
  assert.equal(r.action,'PARK'); near(r.expectedCostEq,70000);
});
test('no return: do nothing rather than pay for handoff',()=>{
  const r=p.planIdle(costs,forecast([],1),options);
  assert.equal(r.action,'LET_EXPIRE'); near(r.expectedCostEq,0);
});
test('10% return in 1h, 90% no return: expire',()=>{
  const r=p.planIdle(costs,forecast([point(60,.1)],.9),options);
  assert.equal(r.action,'LET_EXPIRE'); near(r.expectedCostEq,15875);
});
test('90% immediate-ish return, 10% long return: warm then reassess',()=>{
  const r=p.planIdle(costs,forecast([point(2,.9),point(60,.1)]),options);
  assert.equal(r.action,'KEEP_WARM'); near(r.expectedCostEq,35500);
});
test('a small context can be cheaper cold than parked',()=>{
  const c=p.baselineCosts({contextTokens:50_000});
  const r=p.planIdle(c,forecast([point(60)]),options);
  assert.equal(r.action,'LET_EXPIRE'); near(r.expectedCostEq,33750);
});
test('shared cache expiry is included on actual child restoration',()=>{
  const r=p.planIdle(costs,forecast([point(60)]),{...options,sharedCachePersists:false});
  assert.equal(r.action,'PARK'); near(r.costs.PARK,98750);
});
test('handoff quality gate prevents parking even when cheapest',()=>{
  const r=p.planIdle(costs,forecast([point(60)]),{...options,allowParking:false});
  assert.notEqual(r.action,'PARK'); assert.equal(r.costs.PARK,Infinity);
});
test('a stated quality penalty can change the decision',()=>{
  const r=p.planIdle({...costs,parkQualityEq:200_000},forecast([point(60)]),options);
  assert.notEqual(r.action,'PARK');
});
test('invalid total probability and zero return time are rejected',()=>{
  assert.throws(()=>p.planIdle(costs,forecast([point(10,.2)]),options));
  assert.throws(()=>p.planIdle(costs,forecast([point(0)]),options));
});
test('unknown or expired cache never triggers a blind cache warm',()=>{
  const base={remainingTtlMs:0,cacheVerified:true,busy:false,userRequestPending:false,parked:false};
  assert.equal(p.advise(base,costs,forecast([point(60)]),options).action,'LET_EXPIRE');
});
test('real work and user requests have priority',()=>{
  const base={remainingTtlMs:30000,cacheVerified:true,busy:true,userRequestPending:false,parked:false};
  assert.equal(p.advise(base,costs,forecast([point(60)]),options).action,'WAIT');
});
test('no action before renewal review',()=>{
  const base={remainingTtlMs:60000,cacheVerified:true,busy:false,userRequestPending:false,parked:false};
  assert.equal(p.advise(base,costs,forecast([point(60)]),options).action,'WAIT');
});
test('no forecast means no autonomous parking',()=>{
  const base={remainingTtlMs:30000,cacheVerified:true,busy:false,userRequestPending:false,parked:false};
  const r=p.advise(base,costs,undefined,options);
  assert.equal(r.action,'LET_EXPIRE'); assert.match(r.reason,/no-calibrated-forecast/);
});
test('a late return exactly at the next review cancels that review',()=>{
  const r=p.planIdle(costs,forecast([point(4.5)]),options);
  near(r.expectedCostEq,30000); assert.equal(r.action,'KEEP_WARM');
});
test('budget fallback is a strict spending bound, not parking',()=>{
  assert.equal(p.budgetFallback(15000,30000,55000),'KEEP_WARM');
  assert.equal(p.budgetFallback(15000,45000,55000),'LET_EXPIRE');
  assert.equal(p.budgetFallback(15000,40000,55000),'LET_EXPIRE');
});
test('planner output is unaffected by sunk-cost bookkeeping',()=>{
  const a=p.planIdle(costs,forecast([point(2)]),options);
  const b=p.planIdle(costs,forecast([point(2)]),options);
  assert.deepEqual(a,b); // No alreadySpent field exists in the planner API.
});
// Independent recursive enumerator for small horizons validates the DP recurrence.
function brute(c,f,o,j=0){
  const t=j*o.intervalMs, next=t+o.intervalMs;
  const future=f.returns.filter(p=>p.afterMs>t);
  const s=f.neverReturnsProbability+future.reduce((a,p)=>a+p.probability,0);
  if(s<1e-9) return 0;
  if(!future.length) return 0;
  const expiry=t+(j?o.ttlMs-o.intervalMs:o.remainingTtlMs);
  let X=0, D=0, A=0, sn=f.neverReturnsProbability;
  for(const x of future){
    X+=x.probability*(x.afterMs<expiry?c.rawWarmEq:(o.sharedCachePersists?c.coldSharedEq:c.coldFullEq));
    D+=x.probability*(c.restoreWarmEq+c.skillRestoreEq+c.parkQualityEq+(!o.sharedCachePersists&&x.afterMs>=t+o.ttlMs?c.sharedLossEq:0));
    if(x.afterMs<=next) A+=x.probability*c.rawWarmEq; else sn+=x.probability;
  }
  const W=c.warmEq+(A+sn*brute(c,f,o,j+1))/s;
  return Math.min(X/s,o.allowParking?c.parkNowEq+D/s:Infinity,W);
}
test('DP matches an independent enumerator on 120 deterministic random scenarios',()=>{
  let seed=1234567; const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<120;i++){
    const masses=Array.from({length:5},rng), total=masses.reduce((a,b)=>a+b,0);
    const returns=masses.slice(0,4).map((m,k)=>({afterMs:10000+k*270000+rng()*250000,probability:m/total}));
    const f=forecast(returns,masses[4]/total);
    const o={...options,sharedCachePersists:i%2===0,allowParking:i%3!==0};
    near(p.planIdle(costs,f,o).expectedCostEq,brute(costs,f,o));
  }
});
