"""Independent re-derivation (Python, no shared code with verify_comparison.cjs).
Units: K tokens, 1h cache-write = 1 (write-equivalent). Model: Opus 5 measured ratios.
"""
from math import floor, ceil, isclose

# ---------- 1. Base costs -------------------------------------------------
def base(rr, ro, C=150.0, g=2, Oh=3.0, Sh=25.0, Sm=2.5, Rw=6.0, Rr=125.0, Ks=0.0):
    a = rr * C
    G = g * rr * C + ro * Oh
    B = rr * (Sh + Rr) + Sm + Rw + Ks
    return dict(a=a, G=G, B=B, P=G + B, K=C, K_shared=rr * Sh + (C - Sh))

opus = base(0.055, 2.5)
fab_old = base(0.022, 1.25)   # my previous turn (CLI-derived $25 output)
fab_new = base(0.022, 2.5)    # official $50 output
print("opus", {k: round(v, 3) for k, v in opus.items()})
print("fable(1.25)", {k: round(v, 3) for k, v in fab_old.items()})
print("fable(2.5) ", {k: round(v, 3) for k, v in fab_new.items()})
assert isclose(opus["P"], 40.75) and isclose(fab_old["P"], 22.15) and isclose(fab_new["P"], 25.9)

# ---------- 2. Counterexample: full backward induction --------------------
# Interval returns: unconditional probabilities that the user returns inside
# interval i (i=0 is the interval right after the current deadline). Rest = never.
def dp(a, G, B, K, probs, never, warm_resume=None):
    """Value at each epoch given user still absent. Actions: PARK, EXPIRE, WARM.
    PARK  = G + q_t*B ; EXPIRE = q_t*K ; WARM = a + h_t*A + (1-h_t)*V_{t+1}
    where A = warm resume cost (= a: one read of C)."""
    A = a if warm_resume is None else warm_resume
    n = len(probs)
    V = [0.0] * (n + 1)
    act = [None] * (n + 1)
    # after the last interval only 'never' mass remains -> everything is 0 except G
    V[n], act[n] = 0.0, "EXPIRE"
    for t in range(n - 1, -1, -1):
        surv = never + sum(probs[t:])
        q = sum(probs[t:]) / surv
        h = probs[t] / surv
        park = G + q * B
        expire = q * K
        warm = a + h * A + (1 - h) * V[t + 1]
        cands = {"EXPIRE": expire, "WARM": warm, "PARK": park}
        best = min(cands, key=lambda k: (round(cands[k], 9), ["EXPIRE", "WARM", "PARK"].index(k)))
        V[t], act[t] = cands[best], best
    return V, act

probs = [0.10, 0.05, 0.03, 0.02]; never = 0.80
V, act = dp(opus["a"], opus["G"], opus["B"], opus["K"], probs, never)
print("\n[counterexample] epoch values:", [round(v, 3) for v in V], act)
assert act[0] == "WARM" and isclose(V[0], 24.075, abs_tol=1e-9)

# my previous-turn rule
q0 = sum(probs) / 1.0; h0 = probs[0]
q_star = opus["G"] / (opus["K"] - opus["B"])
alt = "PARK" if q0 > q_star else "EXPIRE"
W = opus["P"] if alt == "PARK" else opus["K"]
h_star = opus["a"] / (W - opus["a"])
my_action = "WARM" if h0 > h_star else alt
print(f"my rule: q0={q0:.3f} q*={q_star:.4f} alt={alt} W={W} h*={h_star:.4f} h0={h0} -> {my_action}")
assert my_action == "PARK"
print(f"cost of my action (park now) = {opus['G'] + q0*opus['B']:.3f}  vs DP optimum {V[0]:.3f}")

# Is the failure due to alternative switching? Fix the alternative to PARK and re-run DP.
def dp_fixed_alt(a, G, B, K, probs, never, alt):
    n = len(probs); V = [0.0] * (n + 1)
    V[n] = G if alt == "PARK" else 0.0  # if alt is fixed PARK you still pay G at the end
    for t in range(n - 1, -1, -1):
        surv = never + sum(probs[t:]); q = sum(probs[t:]) / surv; h = probs[t] / surv
        stop = G + q * B if alt == "PARK" else q * K
        warm = a + h * a + (1 - h) * V[t + 1]
        V[t] = min(stop, warm)
    return V[0]
print("fixed-alt PARK optimum:", round(dp_fixed_alt(*[opus[k] for k in "aGBK"], probs, never, "PARK"), 3),
      "-> park now (27.35) is optimal if alternative is frozen; failure is the alt switch")

# Robustness of the counterexample to K_shared
V2, act2 = dp(opus["a"], opus["G"], opus["B"], opus["K_shared"], probs, never)
print("with K_shared=%.3f: optimum %.3f action %s ; park-now %.3f" % (opus["K_shared"], V2[0], act2[0], opus["G"] + q0*opus["B"]))

# ---------- 3. My OSLA claim under q=1 / constant W ---------------------------
# Decreasing hazard, return certain (never=0), long geometric-like tail with explicit late mass.
def osla(a, W, hazards):
    """one-step rule: warm iff h > a/(W-a); returns (cost, first stop epoch)"""
    hs = a / (W - a)
    cost = 0.0; surv = 1.0; stopped = None
    # simulate expected cost following OSLA against the same distribution
    for t, h in enumerate(hazards):
        if h > hs:
            cost += surv * (a + h * a); surv *= (1 - h)
        else:
            cost += surv * W; stopped = t; break
    else:
        cost += surv * W
    return cost, stopped

def dp_const_W(a, W, hazards):
    n = len(hazards); V = [0.0] * (n + 1); V[n] = W
    for t in range(n - 1, -1, -1):
        h = hazards[t]; V[t] = min(W, a + h * a + (1 - h) * V[t + 1])
    return V[0]

import random
random.seed(7)
mismatch = 0
for trial in range(2000):
    W = random.uniform(15, 80)
    # decreasing hazards, arbitrary start
    h = random.uniform(0.02, 0.9); hz = []
    for _ in range(random.randint(3, 30)):
        hz.append(h); h *= random.uniform(0.5, 1.0)
    c1, _ = osla(opus["a"], W, hz); c2 = dp_const_W(opus["a"], W, hz)
    if not isclose(c1, c2, rel_tol=1e-9, abs_tol=1e-9): mismatch += 1
print(f"\n[OSLA vs DP, constant W, decreasing hazard] mismatches: {mismatch}/2000")

# increasing hazard -> OSLA can fail even with constant W (sanity)
hz = [0.05, 0.05, 0.9]
print("increasing-hazard sanity: OSLA", round(osla(opus['a'], 40.75, hz)[0], 3), "DP", round(dp_const_W(opus['a'], 40.75, hz), 3))

# ---------- 4. Competitive ratio / regret -----------------------------------
a, G, B, P, K = (opus[k] for k in ("a", "G", "B", "P", "K"))
Wmin = min(P, K); n_hat = floor(Wmin / a)   # pings before switching
def alg_cost(T_intervals, returns=True):
    """break-even rule: ping at deadlines 1..n_hat, switch at deadline n_hat+1."""
    if not returns:
        return n_hat * a + (G if P <= K else 0.0)
    if T_intervals <= n_hat + 1:           # returns before the switch deadline
        n_pings = T_intervals - 1           # pings strictly before return
        return n_pings * a + a              # + warm resume
    return n_hat * a + (P if P <= K else K)
def opt_cost(T_intervals, returns=True):
    if not returns: return 0.0
    keep = (T_intervals - 1) * a + a
    return min(keep, P, K)
worst = 0.0
for T in range(1, 200):
    r = alg_cost(T) / opt_cost(T); worst = max(worst, r)
print(f"\n[q=1] worst multiplicative ratio over return times: {worst:.3f}  (n_hat={n_hat})")
print(f"[never returns] ALG spends {alg_cost(0, False):.2f}, OPT 0 -> ratio unbounded; additive regret bound P+G = {P+G:.2f}")
add_worst = max(alg_cost(T) - opt_cost(T) for T in range(1, 200))
print(f"[q=1] worst additive regret over return times: {add_worst:.3f} (<= n_hat*a = {n_hat*a:.2f})")

# ---------- 5. Lambda back-calculation consistency --------------------------
rr, C, Cp = 0.055, 150.0, 45.0; Nb = 6
Nstar = lambda lam: (G + B + lam - a) / (rr * (C - Cp))
lam_mine = Nb * rr * (C - Cp) - (G + B)
lam_fix = Nb * rr * (C - Cp) - (G + B) + a
print(f"\n[Lambda] N*(lam_mine)={Nstar(lam_mine):.3f} (should be {Nb}); N*(lam_fix)={Nstar(lam_fix):.3f}")

# ---------- 6. Crossing vs park timing ----------------------------------------
n_cross = ceil((P - a) / a - 1e-12)
print(f"\n[timing] P/a={P/a:.3f}; n_cross={n_cross}; t_cross={n_cross*55}min; first park deadline=(n_hat+1)*55={(n_hat+1)*55}min")
