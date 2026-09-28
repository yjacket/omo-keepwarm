"""Expiry-time (T*) calculator and wiki charts for the easy keep-warm rule.

Behaviour model (three numbers a person can enter): among idle episodes a share p returns within
a day; returners' return time is lognormal with median m minutes and 90th percentile t90 minutes:
    F(t) = p * Phi((ln t - ln m) / s),   s = (ln t90 - ln m) / 1.2816
Rule: at each review time t (multiples of the ping interval), keep warm while
    h(t) = [F(t + interval) - F(t)] / [1 - F(t)]  >  r,     r = ping cost / rewrite cost
T* is the first review time where it fails; the cache then expires within one interval.
The fitted hazard falls with time, so the first crossing is also the last one.

usage: uv run --with matplotlib python expiry-charts.py <q-summary.json> <images dir> <table json>
"""
from __future__ import annotations

import json
import math
import platform
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import NullFormatter  # noqa: E402

Q_SUMMARY, IMAGES, TABLE = (Path(p) for p in sys.argv[1:4])
IMAGES.mkdir(parents=True, exist_ok=True)
cjk = {"Darwin": "AppleGothic", "Windows": "Malgun Gothic"}.get(platform.system(), "Noto Sans CJK KR")
matplotlib.rcParams["font.family"] = [cjk, "DejaVu Sans"]
matplotlib.rcParams["axes.unicode_minus"] = False

est = json.loads(Q_SUMMARY.read_text(encoding="utf-8"))["A"]["estimate_endsCompeting"]


def step_cif(t: float) -> float:
    value = 0.0
    for s in est["steps"]:
        if s["tMin"] <= t:
            value = s["F1"]
        else:
            break
    return value


EMPIRICAL_T = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440]
EMPIRICAL_F = [step_cif(t) for t in EMPIRICAL_T]


def phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


def model(p: float, m: float, t90: float):
    s = (math.log(t90) - math.log(m)) / 1.2816
    return lambda t: 0.0 if t <= 0 else p * phi((math.log(t) - math.log(m)) / s)


def sse(p: float, m: float, t90: float) -> float:
    f = model(p, m, t90)
    return sum((f(t) - y) ** 2 for t, y in zip(EMPIRICAL_T, EMPIRICAL_F))


best = None
for p in [0.70 + 0.005 * i for i in range(51)]:
    for m in [4.0 + 0.5 * i for i in range(33)]:
        for t90 in [30.0 + 10 * i for i in range(48)]:
            e = sse(p, m, t90)
            if best is None or e < best[0]:
                best = (e, p, m, t90)
_, P_FIT, M_FIT, T90_FIT = best
F_FIT = model(P_FIT, M_FIT, T90_FIT)
RESIDUALS = [round(F_FIT(t) - y, 4) for t, y in zip(EMPIRICAL_T, EMPIRICAL_F)]

LANES = [
    {"key": "5m", "label": "5분 TTL", "ttl": 5.0, "interval": 4.5, "r": 0.08},
    {"key": "30m", "label": "30분 TTL (GPT-5.6 이상)", "ttl": 30.0, "interval": 27.0, "r": 0.08},
    {"key": "1h", "label": "1시간 TTL (Claude 구독 본대화)", "ttl": 60.0, "interval": 55.0, "r": 0.025},
]
HORIZON = 24 * 60.0
COLORS = {"5m": "#d62728", "30m": "#2ca02c", "1h": "#1f77b4"}
TIME_TICKS = [5, 10, 30, 60, 120, 240, 480, 1440]


def time_label(m: float) -> str:
    if m < 60:
        return f"{m:g}분"
    hours, minutes = int(m // 60), round(m - 60 * int(m // 60))
    return f"{hours}시간" + (f" {minutes}분" if minutes else "")


def hazard(f, t: float, interval: float) -> float:
    open_ = 1 - f(t)
    return 0.0 if open_ <= 0 else (f(t + interval) - f(t)) / open_


def t_star(f, interval: float, r: float) -> float:
    k = 1
    while k * interval <= HORIZON:
        if hazard(f, k * interval, interval) < r:
            return k * interval
        k += 1
    return HORIZON


R_VALUES = [0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2]
MEDIANS = [2.5, 5, 7.5, 10, 15, 20, 30, 45, 60]
LEVELS = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
table = {
    "rule": "keep warm while [F(t+interval)-F(t)]/[1-F(t)] > r; T* = first review time where it fails",
    "behaviourModel": "F(t) = p * Phi((ln t - ln m) / s), s = (ln t90 - ln m) / 1.2816",
    "fit": {"p": round(P_FIT, 3), "medianMin": M_FIT, "t90Min": T90_FIT, "sse": round(best[0], 5), "empiricalT": EMPIRICAL_T, "empiricalF": EMPIRICAL_F, "residuals": RESIDUALS, "source": "Aalen-Johansen, q-summary.json A.estimate_endsCompeting (2026-09-17..23)"},
    "lanes": {},
}
for lane in LANES:
    k, iv, r0 = lane["key"], lane["interval"], lane["r"]
    table["lanes"][k] = {
        "label": lane["label"],
        "ttlMin": lane["ttl"],
        "intervalMin": iv,
        "defaultR": r0,
        "tStarMin": t_star(F_FIT, iv, r0),
        "tStarMinOnRawCurve": t_star(lambda t: step_cif(t), iv, r0),
        "tStarByR": {str(r): t_star(F_FIT, iv, r) for r in R_VALUES},
        "tStarByMedian": {str(m): t_star(model(P_FIT, m, m * T90_FIT / M_FIT), iv, r0) for m in MEDIANS},
        "tStarByLevel": {str(p): t_star(model(p, M_FIT, T90_FIT), iv, r0) for p in LEVELS},
    }
TABLE.parent.mkdir(parents=True, exist_ok=True)
TABLE.write_text(json.dumps(table, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def set_time_axis(ax, axis: str = "x") -> None:
    getattr(ax, f"set_{axis}scale")("log")
    getattr(ax, f"set_{axis}ticks")(TIME_TICKS)
    getattr(ax, f"set_{axis}ticklabels")([time_label(m) for m in TIME_TICKS])
    getattr(ax, f"{axis}axis").set_minor_formatter(NullFormatter())
    getattr(ax, f"set_{axis}lim")(4, 1600)


# Figure 1: fitted curve against the measured points, then the stopping rule on it.
fig, (a0, a1) = plt.subplots(1, 2, figsize=(13, 5.5))
ts_curve = [4 * (1600 / 4) ** (i / 199) for i in range(200)]
a0.plot(ts_curve, [F_FIT(t) * 100 for t in ts_curve], color="black", label=f"맞춘 곡선: 최종 {P_FIT * 100:.0f}%, 중앙 {M_FIT:g}분, 90% {time_label(T90_FIT)}")
a0.plot(EMPIRICAL_T, [y * 100 for y in EMPIRICAL_F], "o", color="gray", label="관측(09-17~23, 유휴 162건)")
set_time_axis(a0)
a0.set_ylim(0, 100)
a0.set_ylabel("누적 복귀율 (%)")
a0.set_xlabel("유휴 시작 뒤 경과 시간 (로그 눈금)")
a0.set_title(f"세 숫자로 만든 곡선이 관측과 ±{math.ceil(max(abs(x) for x in RESIDUALS) * 100)}%p 안에서 맞는다")
a0.legend(loc="upper left", fontsize=9)
a0.grid(True, which="major", alpha=0.3)
for lane in LANES:
    k, iv = lane["key"], lane["interval"]
    ts = [iv * j for j in range(1, int(HORIZON // iv) + 1)]
    stop = table["lanes"][k]["tStarMin"]
    a1.plot(ts, [max(hazard(F_FIT, x, iv), 1e-3) for x in ts], marker="o", ms=2.5, color=COLORS[k], label=f"{lane['label']}, r={lane['r']:g} → {time_label(round(stop))}에 멈춤")
    a1.axhline(lane["r"], color=COLORS[k], ls="--", lw=1)
    a1.axvline(stop, color=COLORS[k], ls=":", lw=1)
set_time_axis(a1)
a1.set_yscale("log")
yt = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]
a1.set_yticks(yt)
a1.set_yticklabels([f"{v:g}" for v in yt])
a1.yaxis.set_minor_formatter(NullFormatter())
a1.set_ylim(0.003, 0.8)
a1.set_xlabel("유휴 시작 뒤 경과 시간 (로그 눈금)")
a1.set_ylabel("안 돌아온 사람이 다음 핑 간격 안에 돌아올 확률")
a1.set_title("선이 점선(핑÷재작성 비용 r) 아래로 내려가면 데우기를 멈춘다")
a1.legend(loc="upper right", fontsize=9)
a1.grid(True, which="major", alpha=0.3)
fig.tight_layout()
fig.savefig(IMAGES / "expiry-mechanism.png", dpi=150, bbox_inches="tight")
plt.close(fig)

# Figure 2: T* against the lane cost ratio r.
fig, ax = plt.subplots(figsize=(10, 5.5))
for lane in LANES:
    k = lane["key"]
    ax.step(R_VALUES, [table["lanes"][k]["tStarByR"][str(r)] for r in R_VALUES], where="post", marker="o", ms=3, color=COLORS[k], label=lane["label"])
    ax.plot([lane["r"]], [table["lanes"][k]["tStarMin"]], marker="*", ms=14, color=COLORS[k])
ax.set_xscale("log")
xt = [0.01, 0.02, 0.025, 0.04, 0.05, 0.08, 0.1, 0.2]
ax.set_xticks(xt)
ax.set_xticklabels([f"{v:g}" for v in xt])
ax.xaxis.set_minor_formatter(NullFormatter())
set_time_axis(ax, "y")
ax.set_xlabel("r = 핑 1회 비용 ÷ 재작성 1회 비용 = 캐시 읽기 가격 ÷ 캐시 쓰기 가격 (로그 눈금)")
ax.set_ylabel("데우기 중단(만료) 시점")
ax.set_title("읽기가 쌀수록(r이 작을수록) 오래 데운다 (별 = 기본값)")
ax.legend(loc="upper right", fontsize=9)
ax.grid(True, which="major", alpha=0.3)
fig.tight_layout()
fig.savefig(IMAGES / "expiry-vs-cost-ratio.png", dpi=150, bbox_inches="tight")
plt.close(fig)

# Figure 3: how T* moves when the return pattern changes.
fig, (b1, b2) = plt.subplots(1, 2, figsize=(12, 5.5))
for lane in LANES:
    k = lane["key"]
    b1.plot(MEDIANS, [table["lanes"][k]["tStarByMedian"][str(m)] for m in MEDIANS], marker="o", color=COLORS[k], label=lane["label"])
    b2.plot([p * 100 for p in LEVELS], [table["lanes"][k]["tStarByLevel"][str(p)] for p in LEVELS], marker="o", color=COLORS[k], label=lane["label"])
b1.set_xscale("log")
b1.set_xticks(MEDIANS)
b1.set_xticklabels([f"{m:g}분" for m in MEDIANS])
b1.xaxis.set_minor_formatter(NullFormatter())
b1.set_xlabel(f"돌아오는 사람의 중앙 복귀 시간 (현재 {M_FIT:g}분, 90% 시간도 같은 배율로 이동)")
b1.set_title("복귀가 느려지면 1시간 lane은 더 오래, 5분 lane은 더 일찍 멈춘다")
b1.axvline(M_FIT, color="gray", ls=":", lw=1)
b2.set_xlabel(f"하루 안 최종 복귀율 (%, 현재 {P_FIT * 100:.0f}%)")
b2.set_title("결국 돌아오는 비율이 높을수록 오래 데운다")
b2.axvline(P_FIT * 100, color="gray", ls=":", lw=1)
for b in (b1, b2):
    set_time_axis(b, "y")
    b.set_ylabel("데우기 중단(만료) 시점")
    b.grid(True, which="major", alpha=0.3)
b2.legend(loc="upper left", fontsize=9)
fig.tight_layout()
fig.savefig(IMAGES / "expiry-vs-return-pattern.png", dpi=150, bbox_inches="tight")
plt.close(fig)

print(json.dumps({"fit": table["fit"], "lanes": {k: {kk: v[kk] for kk in ("tStarMin", "tStarMinOnRawCurve", "tStarByR", "tStarByMedian", "tStarByLevel")} for k, v in table["lanes"].items()}}, ensure_ascii=True))
