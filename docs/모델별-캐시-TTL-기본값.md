[유휴 캐시 만료 정책](유휴-캐시-만료-정책.md) 확장에 넣을 lane별 환경값(TTL, 핑 간격, 가격비 r)의 기본값이다. 조사일은 2026-09-28이다. 공급자 문서가 바뀌면 이 표도 다시 확인해야 한다.

## 요약

| lane (senpi provider) | 주로 쓰는 모델 | 캐시 수명(문서) | 가격비 r (읽기 ÷ 쓰기) | 로컬 실측 | 확장 기본값 |
|---|---|---|---|---|---|
| `anthropic-subscription`, `claude-sdk-oauth` (Claude 구독, Agent SDK 경유) | claude-opus-5-5, claude-fable-5-1 | 구독 한도 안의 **본대화 1시간**. 하위 에이전트와 한도 초과(usage credits) 요청은 5분 [2] | 목록가: Opus 5.5 0.025, Fable 5.1 0.0125 [1]. 구독 quota 실측: 약 0.022~0.026 | 59분 뒤 적중(09-17), 55분 읽기로 갱신 확인(09-27, n = 2) | TTL 60분, 간격 55분, r 0.025, **만료 4시간**(사용자 결정) |
| `anthropic` (API 키, pi-ai 경유) | claude-opus-5 | 기본 **5분**. 1시간은 선택(`cacheRetention: long`) [1] | 표준 0.1 ÷ 1.25 = 0.08. Opus 5.5 0.04, Fable 5.1 0.02 [1] | 미측정 | TTL 5분, 간격 4분 30초, r 모델별, **만료 30분**(사용자 결정). senpi 내장 `cache-keepalive`의 지원 대상 |
| `openai-codex`, `chatgpt-subscription` (GPT) | gpt-5.6-sol, gpt-6-astra | GPT-5.6 이상: 마지막 쓰기·재사용 후 **최소 30분**. GPT-5.5: 보통 30분, 최대 24시간. 그 이전: in_memory 5~10분 또는 24h [3] | GPT-5.6 이상 0.1 ÷ 1.25 = 0.08 [3] | 미측정 | TTL 30분, 간격 27분, r 0.08, **만료 약 1시간 50분**(제안) |
| `github-copilot` | gpt-5.6-sol, claude-fable-5-1 | 공개 문서 없음 | 요청 수 기반 과금이면 r이 성립하지 않는다(확인 필요) | 7~245분 간격 8번 모두 캐시 미적중. 5분 등급으로 본다 | **데우기 끔**(과금 방식 확인 전) |
| `devin` | swe-2-high, swe-2-max | 공개 문서 없음 | 모름 | 대략 5~10분, 들쭉날쭉. 캐시 쓰기 필드가 늘 0 | **데우기 끔**(측정 전) |
| Gemini (참고, 현재 미사용) | Gemini 2.5 이상 | 암묵 캐시는 수명 보장 없음. 명시 캐시는 기본 60분이고 보관료가 따로 든다 [4] | 암묵 캐시 적중 시 90% 할인 [4] | - | 대상 아님(핑으로 데우는 구조가 아님) |

## 설정 원칙

- **TTL 기준 시점.** TTL은 마지막으로 캐시를 쓰거나 읽은 요청을 기준으로 잰다. Anthropic은 요청 시작 시각부터 재므로, 응답이 오래 걸리면 그만큼 남은 수명이 줄어든다 [1]. 핑 간격은 TTL보다 여유 있게 잡는다(5분 → 4분 30초, 30분 → 27분, 1시간 → 55분).
- **Claude 구독 lane의 TTL 전환.** 본대화라도 구독 한도를 넘어 usage credits로 과금되기 시작하면 Claude Code가 5분으로 내린다 [2]. 확장은 요청의 캐시 쓰기 필드로 실제 TTL을 확인해야 한다. 1시간 쓰기는 `ephemeral_1h_input_tokens`로 보고된다. senpi 기록에는 이 구분이 없어서 지금은 추정할 수밖에 없다.
- **r의 출처.** 가능하면 실측 quota 비율을 쓰고, 없으면 목록가 비율을 쓴다. Claude 1시간 lane은 실측(약 0.022~0.026)과 Opus 5.5 목록가(0.025)가 거의 같다.
- **데우기를 끄는 lane.** 모르는 lane이나 요청 수로 과금되는 lane은 데우기를 끈다. 이런 lane에서는 핑 한 번이 그대로 비용이고, 재작성해도 추가 비용이 없을 수 있다.

## 출처

1. Anthropic, Prompt caching: TTL 5분 기본과 1시간 선택, 쓰기 1.25배/2배, 읽기 0.1배(Fable 5.1 0.025배, Opus 5.5 0.05배), 요청 시작 기준. https://platform.claude.com/docs/en/build-with-claude/prompt-caching
2. Claude Code, How Claude Code uses prompt caching: 구독 한도 안 본대화 1시간, 그 밖 5분, `promptCacheTtl` 등 설정. https://code.claude.com/docs/en/prompt-caching
3. OpenAI, Prompt caching: GPT-5.6 이상 `prompt_cache_options.ttl` 30분, 쓰기 1.25배, 읽기 0.1배, 이전 모델의 in_memory/24h. https://developers.openai.com/api/docs/guides/prompt-caching
4. Google Cloud, Context caching overview: 암묵 캐시 기본 사용, 명시 캐시 기본 60분. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview
5. 로컬 실측: senpi lane별 TTL 확인(2026-09-17~18, rollover 이벤트 로그), 1시간 TTL 갱신 실험(2026-09-27 재실행, n = 2). [조사 보고서](https://github.com/yjacket/omo-rollover/blob/wt/idle-existing-data-analysis/docs/idle-existing-data-analysis.md)와 [이전 실측 보고서](https://github.com/yjacket/omo-rollover/blob/wt/idle-existing-data-analysis/docs/idle-cost-report.md).
