[유휴 캐시 만료 정책](유휴-캐시-만료-정책.md) 확장에 넣을 lane별 환경값(TTL, 핑 간격, 가격비 r)의 기본값과 데우기 판정이다. 조사일은 2026-09-28이다. 공급자 문서가 바뀌면 이 표도 다시 확인해야 한다. 코드의 기준은 `src/lanes.mjs`의 `classifyLane()`이다.

## 요약

| lane id | 분류 조건 | 주로 쓰는 모델 | 캐시 수명(문서) | 가격비 r (읽기 ÷ 쓰기) | 로컬 실측 | 확장 기본값 |
|---|---|---|---|---|---|---|
| `claude-subscription` | api `claude-sdk-oauth` | claude-opus-5-5, claude-fable-5-1 | 구독 한도 안의 **본대화 1시간**. 하위 에이전트와 한도 초과(usage credits) 요청은 5분 [2] | 목록가: Opus 5.5 0.025, Fable 5.1 0.0125 [1]. 구독 quota 실측: 약 0.022~0.026 | 59분 뒤 적중(09-17), 55분 읽기로 갱신 확인(09-27, n = 2) | TTL 60분, 간격 55분, r 0.025, 격자 1h |
| `codex-subscription` | api `openai-codex-responses` | gpt-5.6-sol, gpt-6-astra | GPT-5.6 이상: 마지막 쓰기·재사용 후 **최소 30분**. 그 이전: in_memory 5~10분 [3] | GPT-5.6 이상 0.1 ÷ 1.25 = 0.08 [3] | 미측정 | TTL은 pi-ai 값(없으면 30분), 30분이면 간격 27분 아니면 4분 30초, r 0.08 |
| `github-copilot` | provider `github-copilot` | gpt-5.6-sol, claude-fable-5-1 | 공개 문서 없음 | 요청 수 과금이라 r이 성립하지 않는다 | 7~245분 간격 8번 모두 미적중 | TTL 5분, 간격 4분 30초, observe |
| `devin` | api `devin-agent` | swe-2-high, swe-2-max | 공개 문서 없음 | 모름 | 대략 5~10분, 들쭉날쭉. 캐시 쓰기 필드가 늘 0 | TTL 5분, 간격 4분 30초, observe |
| `anthropic-api` | api `anthropic-messages`이고 호스트가 api.anthropic.com | claude-opus-5 (API 키) | 기본 **5분**. 1시간은 선택(`cacheRetention: long`) [1] | 모델 단가 비율. 5분이면 읽기 ÷ 쓰기, 1시간이면 쓰기 단가 ×1.6. 없으면 0.08 | 미측정 | 5분: 간격 4분 30초. 1시간: 간격 55분 |
| `openai-api` | pi-ai `isOpenAIResponsesPromptCacheModel` | GPT-5.6 이상 (API 키) | 30분 [3] | 모델 단가 비율. 없으면 0.08 | 미측정 | TTL은 pi-ai 값(없으면 30분), 간격 TTL × 0.9 |
| `other` | 그 밖 | 비공식 호스트, 모르는 모델 | 모름 | 모름 | kiro-lb(anthropic-messages 프록시): 09-23~30 615건 모두 cacheRead·cacheWrite 0, 비용 0 | TTL은 pi-ai 값(없으면 5분), 간격 4분 30초, observe |
| Gemini (참고, 현재 미사용) | `other`로 분류 | Gemini 2.5 이상 | 암묵 캐시는 수명 보장 없음. 명시 캐시는 기본 60분이고 보관료가 따로 든다 [4] | 암묵 캐시 적중 시 90% 할인 [4] | - | 대상 아님 |

## 데우기 판정

판정은 `warmPath`로 정한다. `warmPromptCache`면 가능, `none`이면 불가 또는 미확인이다. 가능한 lane도 `verified`가 기본 `false`라서 실제 핑은 나가지 않는다.

| lane id | 판정 | warmPath | policy | 코드 근거 |
|---|---|---|---|---|
| `claude-subscription` | 불가 | none | decide | pi-ai `warmPromptCache`는 api가 `anthropic-messages`이고 호스트가 api.anthropic.com일 때만 지원한다(`pi-ai/dist/api/warm-prompt-cache.js:26-27`, 그 밖은 `supported: false`). SDK로 질의하면 SDK 세션에 기록이 더해진다 |
| `codex-subscription` | 불가 | none | decide | 같은 파일에 `openai-codex-responses` 분기가 없다. OpenAI 경로는 `isOpenAIResponsesPromptCacheModel`만 본다(`warm-prompt-cache.js:6-15`) |
| `anthropic-api` | 가능 | warmPromptCache | decide | `warm-prompt-cache.js:26-27`의 지원 조건을 만족한다. 5분 읽기 갱신 미측정 |
| `openai-api` | 가능 | warmPromptCache | decide | `warm-prompt-cache.js:6-15`의 지원 조건을 만족한다. 읽기 갱신 미측정 |
| `github-copilot` | 불가 | none | observe | 요청 과금(economics `request`) |
| `devin` | 불가 | none | observe | 데우기 원시 기능 없음. 캐시 쓰기 필드가 늘 0 |
| `other` | 미확인 | none | observe | 모르는 lane이거나 비공식 호스트. kiro-lb는 캐시 필드가 늘 0이라 데울 것이 없다 |

decide lane은 산식으로 판단하고 기록한다. observe lane은 에피소드와 턴만 기록하고 만료 값이 없다. 덮어쓰기 결과 `TTL − 간격 ≤ 5초`이거나 decide lane의 r이 (0, 1) 밖이면 `invalid`가 되어 아무것도 하지 않는다.

## claude-sdk-oauth는 왜 1시간인가

pi-ai는 `claude-sdk-oauth`의 캐시 수명을 5분으로 본다(`pi-ai/dist/utils/prompt-cache-ttl.js:332-334`, 주석 "uses Anthropic's default 5m TTL"). keepwarm은 이 값을 쓰지 않고 1시간으로 고정한다.

- Claude Code 문서는 구독 한도 안의 본대화를 1시간으로 적는다 [2].
- 로컬 실측에서 59분 뒤 적중했고, 55분에 읽으면 갱신되는 것도 확인했다(n = 2) [5].
- 5분으로 두면 간격 4분 30초로 핑하게 되어, 경로가 생긴 뒤 핑 수가 열 배 이상 늘어난다.

한도를 넘어 usage credits로 과금되면 Claude Code가 5분으로 내린다 [2]. senpi 기록에는 1시간 쓰기(`ephemeral_1h_input_tokens`) 구분이 없어서 지금은 판별하지 못한다. 필요하면 `lanes.claude-subscription.ttlSeconds`로 덮어쓴다.

## 설정 원칙

- **TTL 기준 시점.** TTL은 마지막으로 캐시를 쓰거나 읽은 요청을 기준으로 잰다. Anthropic은 요청 시작 시각부터 재므로, 응답이 오래 걸리면 그만큼 남은 수명이 줄어든다 [1]. 그래서 핑 간격을 TTL보다 여유 있게 잡는다(5분 → 4분 30초, 30분 → 27분, 1시간 → 55분).
- **r의 출처.** 가능하면 실측 quota 비율을 쓰고, 없으면 목록가 비율을 쓴다. Claude 1시간 lane은 실측(약 0.022~0.026)과 Opus 5.5 목록가(0.025)가 거의 같다.
- **데우기를 끄는 lane.** 모르는 lane이나 요청 수로 과금되는 lane에는 요청을 보내지 않는다. 핑 한 번이 그대로 비용이고, 재작성해도 추가 비용이 없을 수 있다.
- **덮어쓰기.** config.json `lanes.<id>`로 ttlSeconds, intervalSeconds, r, minContextTokens, verified, grid만 바꿀 수 있다. 형식은 [기록과 상태 계약](기록과-상태-계약.md)에 있다.

## 출처

1. Anthropic, Prompt caching: TTL 5분 기본과 1시간 선택, 쓰기 1.25배/2배, 읽기 0.1배(Fable 5.1 0.025배, Opus 5.5 0.05배), 요청 시작 기준. https://platform.claude.com/docs/en/build-with-claude/prompt-caching
2. Claude Code, How Claude Code uses prompt caching: 구독 한도 안 본대화 1시간, 그 밖 5분, `promptCacheTtl` 등 설정. https://code.claude.com/docs/en/prompt-caching
3. OpenAI, Prompt caching: GPT-5.6 이상 `prompt_cache_options.ttl` 30분, 쓰기 1.25배, 읽기 0.1배, 이전 모델의 in_memory/24h. https://developers.openai.com/api/docs/guides/prompt-caching
4. Google Cloud, Context caching overview: 암묵 캐시 기본 사용, 명시 캐시 기본 60분. https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview
5. 로컬 실측: senpi lane별 TTL 확인(2026-09-17~18, rollover 이벤트 로그), 1시간 TTL 갱신 실험(2026-09-27 재실행, n = 2). [조사 보고서](../research/existing-data-analysis/report.md)와 [이전 실측 보고서](../research/idle-cost-v2/idle-cost-report.md).
