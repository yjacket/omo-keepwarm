keepwarm이 주력 lane(Claude 구독, Codex)을 데우려면 senpi와 pi-ai에 있어야 하는 기능이다. 그 전까지 이 lane에서는 shadow 판단과 기록만 한다.

**upstream 상태 (2026-09-30 확인).**

- 올린 이슈는 두 개다.
  - code-yeongyu/senpi#2389는 내장 keepalive의 도구 불일치를 다룬다(5번 참고). #2400(커밋 7e56f373dd)으로 고쳐져 2026-09-29 20:19Z에 병합됐고, senpi v2026.9.30에 릴리스됐다. 설치된 senpi 2026.9.29-5에는 아직 없다.
  - code-yeongyu/senpi#2454(2026-09-30)는 1번과 3번을 내장 keepalive 개선안으로 묶은 것이다. 내장 keepalive(#773)가 원래 "유휴 동안 캐시를 데워 다음 턴이 읽게 한다"는 같은 목적이라 새 기능이 아니라 개선안으로 썼다. 세션당 한도와 최악 비용 추정은 그 기능이 일부러 고른 보수적 선택이었다(`cache-keepalive/changes.md`, 2026-08-09).
- 2번(Codex)은 올리지 않는다. 메인 세션이라고 가정한 재생에서도 순이득이 캐시 비용의 0~2%다.
- 4번은 내장 keepalive가 구독 lane을 데우게 되면 필요 없다.
- 5번은 요구할 필요가 없었다. 호스트가 이미 `ctx.getPromptCachePrefixRequest()`를 준다.

## 1. Claude 구독: SDK 세션에 더하지 않는 데우기 경로

- **지금.** `claude-sdk-oauth`는 Claude Agent SDK를 거친다. pi-ai `warmPromptCache`는 이 api에 `supported: false`를 돌려준다. 살아 있는 SDK 세션에 질의를 보내면 기록이 추가되어 대화가 바뀐다. 다만 SDK(0.3.284)의 `resume` + `forkSession: true` + `persistSession: false`로 세션을 복제해 보내면 원래 대화에는 남지 않는다. senpi는 이 옵션을 이미 재로드 때 쓴다. 복제한 세션이 같은 접두부를 보내는지는 아직 실측하지 않았다.
- **필요.** 마지막 실제 요청과 같은 접두부(system, tools, messages)로, SDK 세션 기록에 남지 않는 요청을 한 번 보내는 경로다. SDK에는 `max_tokens` 0이 없어서 짧은 답 한 번 값이 든다. 사용량(input, cacheRead, cacheWrite)을 돌려줘야 한다. 1시간 쓰기와 5분 쓰기를 구분할 수 있으면 더 좋다. senpi#2454에 올렸다.
- **근거 수치.** 2026년 9월 세션 기록을 재생한 결과다([오프라인 재생](../research/offline-replay-2026-09-30/README.md)). 사람 복귀 565건 가운데 60~300분 공백 뒤 식어 있던 복귀가 40건이었고, 그때 쓴 캐시가 12,251,292 토큰이었다. 핑 비용을 빼면 순절감은 7.46M~11.16M write-eq 토큰으로, 이 lane 캐시 쓰기의 6.2%~9.3%이고 읽기를 포함한 캐시 비용 전체의 약 3~5%다.

## 2. Codex: openai-codex-responses warmer 등록

- **지금.** `openai-codex-responses`에는 등록된 캐시 warmer가 없다.
- **필요.** 다음 조건을 지키는 warmer.
  - 본대화와 **같은 `prompt_cache_key`**를 쓴다.
  - `store: false`로 보내 응답이 저장되지 않는다.
  - `previous_response_id`를 쓰지 않는다(대화 체인에 끼지 않는다).
  - 출력 0토큰에 가까운 최소 요청이고, 사용량을 돌려준다.

## 3. 유휴당 최대 시간 설정

- **지금.** 내장 cache-keepalive는 3회, $0.05로 고정돼 있고 'Warm ping' 항목을 대화에 남긴다.
- **필요.** 유휴 한 번에 데울 최대 시간(또는 핑 수)을 설정으로 받는 것. senpi#2454에는 이렇게 올렸다.
  - 핑 한도는 사람이 입력할 때만 초기화한다. 지금은 `session_start`에서만 초기화된다.
  - 설정은 provider별로 두고, 모델별로 덮어쓸 수 있게 하며, 기간으로 받는다.
  - 예상 비용은 읽기 단가로 계산하고, 연속 두 번째 미스에서 데우기를 멈춘다.
  - 알림 항목을 끄는 모드는 요청하지 않았다. senpi는 핑과 그 비용을 더 잘 보이게 하는 방향이다(#2416).

## 4. ctx 수준의 흔적 없는 warm 호출

- **필요.** 확장이 `ctx`에서 바로 부를 수 있는 데우기 함수. 내장 keepalive가 하는 조립(prepareProviderRequest → convertToLlm, getSystemPrompt, 활성 도구, getApiKeyAndHeaders, transformHeaders/transformPayload)을 호스트가 대신 하고, 대화 기록, 턴, UI에 흔적을 남기지 않는다.
- **호스트에 이미 있는 것.** `ctx.getPromptCachePrefixRequest()`는 다음 사용자 턴의 provider 요청 접두부를 호스트가 조립해 돌려준다(`senpi/dist/core/extensions/types.d.ts` 462행). 내장 keepalive도 #2400부터 이 접두부로 핑한다. 남은 요구는 흔적 없는 warm 호출 자체다.
- 지금 keepwarm은 이 조립을 직접 한다. 호스트 내부 순서가 바뀌면 따라가야 한다. `getPromptCachePrefixRequest()`로 바꾸지 않은 이유는, 쓰는 lane에 데우기 경로가 없어서 바꿔도 달라지는 것이 없기 때문이다.

## 5. 마지막 실제 요청의 도구 목록

- **지금.** 확장이 보는 `pi.getAllTools()`(ToolInfo)에는 실제 요청의 도구 순서(활성 순서), `constrainedSampling`(strict 도구), tool-search가 붙이는 `defer_loading`과 카탈로그 도구가 없다. ToolInfo로 다시 만든 도구 목록은 실제 요청과 달라 캐시 접두부가 어긋난다. senpi 2026.9.29 실사용 QA에서 이 차이 때문에 on 모드의 모든 warm 핑이 접두부 불일치로 멈췄다(증거 `.omo/evidence/keepwarm-v1/task-11/defect-prefix-mismatch/`).
- **keepwarm의 대응.** `before_provider_request`에서 본 실제 요청의 `tools`를 메모리에만 두고 warm 요청에 그대로 쓴다. 재로드 직후처럼 그 값이 없으면 활성 순서와 strict 표시로 다시 만들고, 그래도 다르면 보내지 않는다.
- **내장 keepalive도 같은 문제가 있었다.** senpi 2026.9.29-5의 `cache-keepalive/index.js`(128-133행)는 `getAllTools()` 순서로 `{name, description, parameters}`만 넘긴다. strict 도구나 지연 도구가 있으면 핑의 도구 접두부가 실제 요청과 달라, 캐시를 읽지 못하고 새로 쓴다. 이 결함은 code-yeongyu/senpi#2389로 올렸고, #2400에서 핑의 도구를 `getPromptCachePrefixRequest()`에서 가져오게 바꿔 고쳤다. 같은 수정이 두 번째 결함도 고쳤다. 무장(arming)이 `agent_end`에서 일어났는데 그 시점의 세션은 아직 바쁨이라, keepalive를 켜도 실제 세션에서 핑이 한 번도 나가지 않았다. 이제는 `agent_settled`에서 무장한다. 두 수정 모두 다음 senpi 릴리스에 들어간다.
- **호스트에 이미 있다.** 이 요구가 찾던 것은 `ctx.getPromptCachePrefixRequest()`다. 이 API는 senpi 2026.9.28-7부터 있었다(커밋 978333162d, 2026-09-24). v1 설계가 이를 놓치고 요구로 적었다. 4번의 흔적 없는 warm 호출이 생기면 도구 조립도 호스트가 맡는다.

## 다른 확장과의 관계

**on 모드 핑도 다른 확장의 `before_provider_request` 핸들러를 거친다.** senpi의 `transformPayload`가 `emitBeforeProviderRequest`를 부르고, 호출한 확장만 빼고 모든 확장의 핸들러를 돌린다(`senpi/dist/core/extensions/runner.js` 1418-1421행). 그래서 다른 확장이 핑 요청을 보고 기록하거나 바꿀 수 있다. keepwarm은 바뀐 페이로드의 접두부가 마지막 실제 요청과 다르면 네트워크 전에 멈춘다. 흔적 없는 warm 호출(4번)을 만든다면 이 경로를 핑에서 건너뛸지 정해야 한다.

## 참고

- 판정 근거: [모델별 캐시 TTL 기본값](모델별-캐시-TTL-기본값.md)
- 경로가 생긴 뒤의 검증 절차: [유료 실측 제안](유료-실측-제안.md)
