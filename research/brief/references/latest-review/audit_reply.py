"""Independent audit of the supplied Python checks. Standard library only.
Costs are K tokens in 1h-write-equivalent units. This is NOT provider measurement.
No network, production writes, or model requests.
"""
from math import floor, isclose
import json
from pathlib import Path


def backward(a, G, B, K, probs, never):
    values = [0.0] * (len(probs) + 1)
    actions = ['EXPIRE'] * (len(probs) + 1)
    for i in range(len(probs)-1, -1, -1):
        surv = never + sum(probs[i:])
        q = sum(probs[i:]) / surv
        h = probs[i] / surv
        candidates = {'EXPIRE': q*K, 'WARM': a+h*a+(1-h)*values[i+1], 'PARK': G+q*B}
        actions[i] = min(candidates, key=candidates.get)
        values[i] = candidates[actions[i]]
    return values, actions


def original_rule(a, G, B, K, probs, never):
    """Evaluate Claude's originally proposed policy recursively, not PARK only."""
    values = [0.0] * (len(probs) + 1)
    actions = ['EXPIRE'] * (len(probs) + 1)
    for i in range(len(probs)-1,-1,-1):
        surv = never + sum(probs[i:]); q = sum(probs[i:])/surv; h = probs[i]/surv
        qstar = G/(K-B) if K>B else float('inf')
        alt = 'PARK' if q>qstar else 'EXPIRE'
        W = G+B if alt=='PARK' else K
        if W<=a:
            action=alt
        else:
            action='WARM' if h>a/(W-a) else alt
        actions[i]=action
        values[i]={'PARK':G+q*B,'EXPIRE':q*K,'WARM':a+h*a+(1-h)*values[i+1]}[action]
    return values, actions


a,G,B=8.25,24.,16.75
cases=[]
for label,K,probs,never in [
    ('original-full-cold',150.,[.10,.05,.03,.02],.8),
    ('same-probabilities-shared-cold',126.375,[.10,.05,.03,.02],.8),
    ('new-shared-cold-counterexample',126.375,[.12,.06,.036,.024],.76),
]:
    v,acts=backward(a,G,B,K,probs,never)
    ov,oa=original_rule(a,G,B,K,probs,never)
    cases.append(dict(label=label,K=K,q=sum(probs),h=probs[0],
                      qstar=G/(K-B),hstar_expire=a/(K-a),
                      original_action=oa[0],original_cost=ov[0],dp_action=acts[0],dp_cost=v[0]))
assert cases[0]['original_action']=='PARK' and isclose(cases[0]['dp_cost'],24.075)
assert cases[1]['original_action']=='WARM' and isclose(cases[1]['original_cost'],21.7125)
assert isclose(cases[1]['dp_cost'], cases[1]['original_cost'])
assert cases[2]['original_action']=='PARK' and isclose(cases[2]['dp_cost'],24.405)
assert isclose(cases[2]['original_cost'],28.02)

P=G+B; K=150.
# Exact timing convention used by regret_check.py: earliest return needs only A=a.
Ts=range(1,400)
opt=lambda t: min(t*a,P,K) if t else 0.
park=lambda t: P if t else G
# An omitted admissible policy IF the first interval really is free:
wait_free_then_park=lambda t: (a if t==1 else P) if t else G
max_regret=lambda f: max(f(t)-opt(t) for t in [0,*Ts])
free_first={
    'immediate_park_regret':max_regret(park),
    'wait_free_interval_then_park_regret':max_regret(wait_free_then_park),
}
assert isclose(free_first['immediate_park_regret'],32.5)
assert isclose(free_first['wait_free_interval_then_park_regret'],24.25)

# Consistent renewal-deadline convention: no free full next interval.
# n paid pings then terminal action; T=1 is a return in the newly bought interval.
# Decisions are atomic, costs fixed, no failures, V=0, genuine non-return allowed.
def deadline_cost(n, terminal, T):
    if T==0:
        return n*a+(G if terminal=='PARK' else 0.)
    if T<=n:
        return T*a+a  # paid pings plus a genuine resume read
    return n*a+(P if terminal=='PARK' else K)
opt_deadline=lambda t: min((t+1)*a,P,K) if t else 0.
all_det=[]
for n in range(50):
    for terminal in ('PARK','EXPIRE'):
        reg=max(deadline_cost(n,terminal,t)-opt_deadline(t) for t in [0,*Ts])
        all_det.append(dict(pings=n,terminal=terminal,max_regret=reg))
best_det=min(all_det,key=lambda row:row['max_regret'])
assert best_det['pings']==0 and best_det['terminal']=='PARK'
assert isclose(best_det['max_regret'],24.25)

# Closed-form maximum regret for the stated deterministic, fixed-cost,
# renewal-deadline model. Not a claim about randomization or real request latency.
m = min(2*a, P, K)
closed_form = {'offline_first_interval_min': m,
               'park_max_regret': max(G, P-m),
               'expire_max_regret': K-m}
assert isclose(closed_form['park_max_regret'], best_det['max_regret'])
assert isclose(closed_form['expire_max_regret'], 133.5)

# Inspect the reported 50K/lambda=20 row, independently reconstructed.
small=[]
for label,rr in [('opus',.055),('fable',.022)]:
    C=50.; lam=20.
    aa=rr*C; gg=2*aa+2.5*3; bb=rr*150+2.5+6+lam; pp=gg+bb
    rp=max(gg,pp-min(aa,pp,C)); re=C-min(aa,pp,C)
    small.append(dict(model=label,C=C,Lambda=lam,park_regret=rp,expire_regret=re))
    assert rp<re

# Price errors in input-equivalent units, not in model-normalized quota units.
price_5m={'cold_full':1.25*150,'cold_shared':.1*25+1.25*125,'shared_loss':(1.25-.1)*25}
price_1h={'cold_full':2*150,'cold_shared':.1*25+2*125,'shared_loss':(2-.1)*25}

# Empirical q is not estimable here: these are scenarios only.
# Cold parent generation: first full rewrite, then a read, then output.
parent={'warm':G,'cold_full':K+(2-1)*a+2.5*3,'delta':K-a}
assert isclose(parent['cold_full'],165.75)

results={'scope':'arithmetic/model audit only, not new quota or TTL observations',
         'shared_counterexample_audit':cases,
         'regret_free_first_interval':free_first,
         'regret_deadline_consistent_best_enumerated_deterministic':best_det,
         'regret_deadline_consistent_closed_form':closed_form,
         'small_context_summary_correction':small,
         'api_input_equivalent_5m':price_5m,'api_input_equivalent_1h':price_1h,
         'parent_generation_write_equivalent':parent}
print(json.dumps(results,ensure_ascii=False,indent=2))
Path(__file__).with_suffix('.results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
