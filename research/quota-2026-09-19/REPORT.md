# 구독 quota 가중치 실측 — 2026-09-19

## 환경 (관측)
- Claude Code CLI 2.1.276 (native `claude.exe`), headless `-p`, OAuth(구독) lane.
- 프록시: `proxy.mjs` — 127.0.0.1:18321 패스스루 → api.anthropic.com, `ANTHROPIC_BASE_URL`로 연결. 인증 헤더/본문 미기록.
- 실행 플래그: `--safe-mode --strict-mcp-config --tools "" --disable-slash-commands --effort low --max-turns 1`, `MAX_THINKING_TOKENS=0` (thinkingTokens=0 확인됨), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- 캐시 TTL lane: 모든 쓰기가 `ephemeral_1h_input_tokens`에 기록됨 (`ephemeral_5m`은 항상 0). 이 계정/CLI는 1시간 캐시 쓰기 lane.
- 게이트: unified 헤더 존재 확인(구독 lane). 시작 시 5h=0.12, 7d=0.39, 5h reset까지 ~151분 → 통과.
- 관측된 unified 헤더 전부: `unified-status`, `unified-reset`, `unified-5h-utilization/-reset/-status`, `unified-7d-utilization/-reset/-status`, `unified-representative-claim`(five_hour), `unified-overage-status`(rejected), `unified-overage-disabled-reason`(org_level_disabled), `unified-fallback-percentage`(0.5). 모델 전용 추가 버킷 없음.

## 핵심 한계 (관측)
- **헤더 해상도 0.01.** 요청당 Δu는 측정 불가 → "틱당 요청 수/토큰" 방식으로 전환. 모든 비율은 틱 경계 구간 추정.
- **거부(refusal) 요청은 quota 미차감으로 보임(추론):** resume 핑 70회×146K 쓰기(합 7.3M w1 토큰) 동안 5h 틱 0회 — 차감됐다면 예산 초과. safeguard 거부된 요청은 usage를 기록하지만 헤더를 움직이지 않음.
- **`--resume` 경로는 측정에 부적합(관측):** 첫 핑이 safeguard 거부되면 이후 모든 resume가 prefix 캐시 미스(전량 재쓰기). 읽기 측정은 동일 필러를 새 세션으로 재전송하는 방식(Rf)으로 대체 — 144~145K 읽기/요청, 거부 0건.
- **CLI 자동 압축(관측):** 357K 토큰 세션 resume 시 첫 요청이 359K 읽기 + 2.2K 요약 출력(압축) 후 이후 핑은 ~2K만 읽음. CLI contextWindow=200K. API는 357K 단일 요청을 수용(모델 컨텍스트 >200K).
- **Fable null 프롬프트 거부(관측):** 짧은 null 프롬프트는 stop_reason=refusal → CLI가 opus-4-8로 자동 폴백(`--fallback-model`과 무관). 자연스러운 문장 프롬프트 + 필러 있는 세션에서는 거부 없음.

## 측정 결과 (5h 버킷)

### 틱 구간 (관측 → 추론)
| 측정 | 데이터 | 틱(0.01)당 토큰 구간 | 점추정 |
|---|---|---|---|
| opus 쓰기(1h) | 357K×3 → 2틱 | 357K–536K | ~450K |
| opus 읽기 | 144,628×60 → 1틱 (54번째에서 발생) | 7.82M–8.68M | ~8.2M |
| fable 쓰기(1h) | 142.7K×5 → 6틱 | 102K–143K | ~119K |
| fable 읽기 | 145,655×51 → 2틱 (13, 50번째) | 5.39M–5.55M | ~5.4M |

### 비율 (추론; 점추정 [범위])
| 비율 | opus-5 | fable-5-1 | 가격표 비율* |
|---|---|---|---|
| 읽기/쓰기 (kc/kb) | ~0.055 [0.041–0.068] | ~0.022 [0.019–0.026] | 0.05 / 0.015 |
| 출력/쓰기 (kd/kb) | **식별 불가** | **식별 불가** | 2.5 / 1.25 |
| kb(Fable)/kb(Opus) | — | **~3.8× [2.5–5.3]** | 2.0 (가격 기준) |

\* 가격표 비율은 CLI `modelUsage.costUSD`에서 역산(관측): opus-5 = in $5 / 1h쓰기 $10 / 읽기 $0.5 / 출력 $25 per Mtok; fable-5-1 = in $10 / 1h쓰기 $20 / 읽기 $0.3 / 출력 $25 per Mtok; opus-4-8 = opus-5와 동일 단가.

### 7d 버킷 (관측+추론)
- 7d 틱 2회 관측(0.40→0.41 fable 쓰기 중, 0.41→0.42 fable 읽기 중). 두 틱 사이 누적 ≈ 571K w1 + 4.66M rd ≈ 674K 쓰기환산 → **7d 틱 ≈ 5h 틱의 ~5.7배** (주간 한도 ≈ 5시간 한도의 ~5.7배, 추론).
- 7d 분석은 5h와 동일 가중치로 차감됨을 전제(두 버킷이 같은 요청에서 동시에 움직임 — 관측).

## lag / 선형성 점검
- **lag 0 지배적(관측):** 쓰기 틱은 해당 응답의 헤더에 즉시 반영. 단 fable.WR.end(토큰 ~0)에서 +0.02 관측 → 일부 지연 반영(lag≥1)도 존재. 누적 구간 방식은 어느 쪽이든 유효.
- **선형성:** 동일 모양 반복에서 틱 간격이 일정하지 않음(fable 읽기 13/37, opus 쓰기 2연속 후 간격) — 헤더 해상도+지연+위상 효과. 구간 추정의 불확실성으로 반영.

## 폐기/무효 블록
- opus Wt 1차: "Prompt is too long"(CLI 측 문자수 추정 거부, API 호출 0건).
- opus WR resume 핑 70회: refusal→캐시미스, 미차감으로 판단해 읽기 표본에서 제외.
- opus Rt: 자동 압축으로 첫 핑만 유효(359K 읽기 1개 표본).
- fable gate/probe null들: refusal + opus-4-8 폴백(보조 모델 토큰 <1%, 무시).
- Ot(출력): 시작 전 u5=0.27 도달(abort 조건 +0.15) → 0시행, 출력 가중치 식별 불가.

## 실험이 소모한 utilization (관측)
- 5h: 0.12 → 0.27 (+0.15, abort 상한 도달로 종료). 7d: 0.39 → 0.42 (+0.03).
- 5h reset: epoch 1789765800 (실험 종료 시 ~115분 후).

## 결론 (추론)
- **읽기/쓰기 비율은 가격표와 일치** (opus ~0.05, fable ~0.02): "0.4 이상이면 결론이 뒤집힌다"는 가설은 기각. 캐시 데우기는 여전히 싸다.
- **Fable은 토큰당 quota 무게가 Opus의 ~4배** — 가격 비율(2배)보다 큼. Fable 세션의 캐시 데우기/핸드오프 비용은 Opus 기준으로 환산하면 안 됨.
- 출력 가중치는 이번 예산 내 측정 불가. 다음 5h 윈도우에서 Ot 블록부터 실행하면 측정 가능(출력 1토큰 ≈ 쓰기 2.5토큰 가정 시 ~180K 출력/틱 예상).

## 파일
- `raw.jsonl` — 응답별 usage + unified 헤더 원문. `trials.jsonl` — CLI 시행별 결과(modelUsage/costUSD 포함).
- `proxy.mjs`, `run.mjs`, `analyze.py`, `claude-help.txt`, `label.txt`, `last-session.*.txt`.
