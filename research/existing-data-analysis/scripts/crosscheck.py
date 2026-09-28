"""Independent re-computation of the key numbers (stdlib + numpy), then a PASS/FAIL comparison
against the Node outputs. Different language, different estimator code, different scan code.

usage: python crosscheck.py <evidence dir> <rerun dir> <first run dir> <analysis worktree>
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

EVD, RERUN, FIRST, REPO = (Path(p) for p in sys.argv[1:5])
OUT = EVD / "out"
GRID = [5, 30, 60, 120, 240, 480, 1440]


def load_jsonl(p: Path) -> list[dict]:
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


# ---------------------------------------------------------------- 1. competing-risk CIF
def cif(items: list[tuple[float, int]], t: float) -> tuple[float, float]:
    """Aalen-Johansen written from the definition: events before censorings at ties."""
    items = sorted(items, key=lambda x: (x[0], x[1] == 0))
    n = len(items)
    s, f1, f2 = 1.0, 0.0, 0.0
    i = 0
    while i < n and items[i][0] <= t:
        tt = items[i][0]
        d1 = d2 = c = 0
        while i < n and items[i][0] == tt:
            st = items[i][1]
            d1 += st == 1
            d2 += st == 2
            c += st == 0
            i += 1
        at_risk = n - (i - (d1 + d2 + c))
        if d1 + d2:
            f1 += s * d1 / at_risk
            f2 += s * d2 / at_risk
            s *= 1 - (d1 + d2) / at_risk
    return f1, f2


def status(e: dict, ends_competing: bool) -> int:
    if e["outcome"] == "return":
        return 1
    if e["outcome"] == "ended":
        return 2 if ends_competing else 0
    return 0


epsA = load_jsonl(OUT / "q-episodes-A.jsonl")
epsB = load_jsonl(OUT / "q-episodes-B.jsonl")
res: dict = {"cif": {}}
for label, comp in (("A_endsCompeting", True), ("A_endsCensored", False)):
    items = [(e["tMin"], status(e, comp)) for e in epsA]
    res["cif"][label] = {str(m): round(cif(items, m)[0], 4) for m in GRID}
for p in ("P1", "P2", "P3"):
    items = [(e["tMin"], status(e, False)) for e in epsB if e["period"] == p and e["stopReason"] == "stop"]
    res["cif"][f"B_{p}"] = {str(m): round(cif(items, m)[0], 4) for m in GRID}


# ---------------------------------------------------------------- 2. gauge feasibility (numpy)
def calls_of(d: Path) -> list[dict]:
    out = []
    for r in load_jsonl(d / "requests.jsonl"):
        m = (r.get("meters") or {}).get("unified-5h") or {}
        if r.get("status") != 200 or m.get("util") is None:
            continue
        u = r.get("usage") or {}
        cc = u.get("cache_creation") or {}
        out.append({
            "step": r["stepId"],
            "ticks": round(m["util"] * 100),
            "reset": m.get("reset"),
            "r": u.get("cache_read_input_tokens", 0),
            "w": cc.get("ephemeral_1h_input_tokens", 0) + cc.get("ephemeral_5m_input_tokens", 0) + u.get("input_tokens", 0),
            "o": u.get("output_tokens", 0),
        })
    return out


T = np.arange(60000, 200001, 500, dtype=float)
W = np.concatenate([[0.0], 0.05 * (12 / 0.05) ** (np.arange(240) / 239)])
RS = (5.39e6, 5.47e6, 5.55e6)


def feasible(calls: list[dict], lag: int) -> np.ndarray:
    k = len(calls)
    m = np.array([max(0, i + 1 - lag) for i in range(k)])
    pr = np.concatenate([[0], np.cumsum([c["r"] for c in calls])])
    pw = np.concatenate([[0], np.cumsum([c["w"] for c in calls])])
    po = np.concatenate([[0], np.cumsum([c["o"] for c in calls])])
    dr, dw, do = pr[m] - pr[m[0]], pw[m] - pw[m[0]], po[m] - po[m[0]]
    dn = np.array([c["ticks"] - calls[0]["ticks"] for c in calls], float)
    ok = np.zeros((len(T), len(W)), bool)
    for R in RS:
        S = (dr / R)[:, None, None] + (dw[:, None, None] + do[:, None, None] * W[None, None, :]) / T[None, :, None]
        lo = np.maximum(np.max(dn[:, None, None] - S, axis=0), 0)
        hi = np.minimum(np.min(dn[:, None, None] + 1 - S, axis=0), 1)
        ok |= lo < hi
    return ok


def max_prefix(calls: list[dict], lag: int) -> int:
    lo, hi = 1, len(calls)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if feasible(calls[:mid], lag).any():
            lo = mid
        else:
            hi = mid - 1
    return lo


c1 = calls_of(FIRST)
f1 = feasible(c1, 1)
ti, wi = np.where(f1)
res["gauge"] = {
    "firstRun": {"lag0": bool(feasible(c1, 0).any()), "lag2": bool(feasible(c1, 2).any()), "lag1_T": [int(T[ti.min()]), int(T[ti.max()])], "lag1_wmin": round(float(W[wi.min()]), 3)},
}
c2 = calls_of(RERUN)
by_reset = defaultdict(list)
for c in c2:
    by_reset[c["reset"]].append(c)
fresh = max(by_reset.values(), key=len)
res["gauge"]["rerunMaxPrefix"] = {f"lag{L}": max_prefix(fresh, L) for L in (0, 1, 2)}

# ---------------------------------------------------------------- 3. successor cache regime from raw rows
reqs = load_jsonl(RERUN / "requests.jsonl")
regime = {}
for exp, arm in (("restore-decomposition", "park_path"), ("policy-effect", "shadow_candidate_policy")):
    for run in (1, 2, 3):
        rows = sorted((r for r in reqs if r["experiment"] == exp and r.get("run") == run and r.get("arm") == arm and r.get("phase") in ("restore_child", "useful_work")), key=lambda r: r.get("index", 0))
        if not rows:
            continue
        reads = [(r.get("usage") or {}).get("cache_read_input_tokens", 0) for r in rows]
        regime[f"{exp}#{run}"] = "successor_rewrites_each_call" if all(x == 3035 for x in reads) else "successor_conversation_cached"
res["successorRegime"] = regime

# ---------------------------------------------------------------- 4. LET_EXPIRE break-even arithmetic
results = json.loads((REPO / "docs/idle-live-results.json").read_text(encoding="utf-8"))
costs = results["policyAnswer"]["evaluatedAt"]
items = [(e["tMin"], status(e, True)) for e in epsA]
F50, E50 = cif(items, 50)
Finf, _ = cif(items, 1e9)
open50 = 1 - F50 - E50
res["breakEven"] = {
    "openAt50min": round(open50, 4),
    "eventualReturnGivenOpenAt50": round((Finf - F50) / open50, 4),
    "warmOverCold": {end: round(costs[end]["costs"]["warmEq"] / costs[end]["costs"]["coldFullEq"], 4) for end in ("low", "high")},
    "note": "LET_EXPIRE pays coldFullEq on each late return; one keep-warm ping costs warmEq per 50 min",
}
(OUT / "crosscheck.json").write_text(json.dumps(res, indent=2, sort_keys=True) + "\n", encoding="utf-8")

# ---------------------------------------------------------------- compare with the Node outputs
node_q = json.loads((OUT / "q-summary.json").read_text(encoding="utf-8"))
node_g = json.loads((OUT / "gauge-lag-scan.json").read_text(encoding="utf-8"))
node_r = json.loads((OUT / "restore-reanalysis.json").read_text(encoding="utf-8"))
lines = []


def check(name: str, ok: bool, detail: str = "") -> None:
    lines.append(f"{'PASS' if ok else 'FAIL'} {name}{(' ' + detail) if detail else ''}")


for m in GRID:
    check(f"A endsCompeting CIF@{m}", abs(res["cif"]["A_endsCompeting"][str(m)] - node_q["A"]["estimate_endsCompeting"]["grid"][str(m)]["returnCIF"]) < 1e-4)
    check(f"A endsCensored CIF@{m}", abs(res["cif"]["A_endsCensored"][str(m)] - node_q["A"]["estimate_endsCensored"]["grid"][str(m)]["returnCIF"]) < 1e-4)
    for p in ("P1", "P2", "P3"):
        check(f"B {p} CIF@{m}", abs(res["cif"][f"B_{p}"][str(m)] - node_q["B"]["periods"][p]["estimate"]["grid"][str(m)]["returnCIF"]) < 1e-4)
fr = node_g["firstRun"]["models"]
check("gauge first run lag0 infeasible", (not res["gauge"]["firstRun"]["lag0"]) and fr["lag0"]["region"]["cells"] == 0)
check("gauge first run lag2 infeasible", (not res["gauge"]["firstRun"]["lag2"]) and fr["lag2"]["region"]["cells"] == 0)
check("gauge first run lag1 T range", res["gauge"]["firstRun"]["lag1_T"] == fr["lag1"]["region"]["T"], str(res["gauge"]["firstRun"]["lag1_T"]))
check("gauge first run lag1 w min", abs(res["gauge"]["firstRun"]["lag1_wmin"] - fr["lag1"]["region"]["w"][0]) < 1e-3)
for L in (0, 1, 2):
    check(f"gauge rerun lag{L} max prefix", res["gauge"]["rerunMaxPrefix"][f"lag{L}"] == node_g["rerun"]["models"][f"lag{L}"]["priorR"]["maxFeasiblePrefix"], str(res["gauge"]["rerunMaxPrefix"][f"lag{L}"]))
for unit, reg in regime.items():
    node_only_s = node_r["successorCachePattern"][unit]["parkSuccessorReadsEqualSystemPromptOnly"]
    check(f"successor regime {unit}", (reg == "successor_rewrites_each_call") == node_only_s, reg)
lines.append(f"break-even: open at 50 min {res['breakEven']['openAt50min']}, eventual return given open {res['breakEven']['eventualReturnGivenOpenAt50']}, warm/cold {res['breakEven']['warmOverCold']}")
lines.append(f"python {sys.version.split()[0]} numpy {np.__version__}")
(OUT / "crosscheck-compare.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
print("\n".join(lines))
fails = sum(1 for x in lines if x.startswith("FAIL"))
sys.exit(1 if fails else 0)
