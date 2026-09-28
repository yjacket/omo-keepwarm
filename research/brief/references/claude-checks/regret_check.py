from math import floor
def base(rr, ro, C, g=2, Oh=3.0, Sh=25.0, Sm=2.5, Rw=6.0, Rr=125.0, Ks=0.0, lam=0.0):
    a = rr*C; G = g*rr*C + ro*Oh; B = rr*(Sh+Rr) + Sm + Rw + Ks + lam
    return a, G, B, G+B, C
def minimax_regret(a, G, B, P, K):
    W = min(P, K); alt_is_park = P <= K; n_hat = floor(W/a)
    # scenarios: return in interval T (T=1..) or never. remaining TTL ~ 0 at decision time.
    def opt(T): return min(T*a, P, K) if T else 0.0
    def park_now(T): return (G+B) if T else G
    def expire_now(T): return K if T else 0.0
    def breakeven(T):
        if not T: return n_hat*a + (G if alt_is_park else 0.0)
        if T <= n_hat+1: return T*a
        return n_hat*a + W
    Ts = list(range(1, 400)) + [0]
    reg = lambda f: max(f(T) - opt(T) for T in Ts)
    return dict(park_now=reg(park_now), breakeven_warm=reg(breakeven), expire_now=reg(expire_now), n_hat=n_hat)
for label, rr, ro in [("opus", .055, 2.5), ("fable(2.5)", .022, 2.5)]:
    for C in (30, 50, 100, 150, 190):
        for lam in (0, 20):
            r = minimax_regret(*base(rr, ro, C, lam=lam))
            print(f"{label:11s} C={C:3d}K Λ={lam:2d}K  park_now={r['park_now']:6.2f}  breakeven_warm={r['breakeven_warm']:6.2f}  expire_now={r['expire_now']:6.2f}  n̂={r['n_hat']}")
