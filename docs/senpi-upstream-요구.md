keepwarm이 주력 lane(Claude 구독, Codex)을 데우려면 senpi와 pi-ai에 있어야 하는 기능이다. **upstream 이슈는 올리지 않았다(사용자 결정).** 요구만 여기에 적어 둔다. 그 전까지 이 lane에서는 shadow 판단과 기록만 한다.

## 1. Claude 구독: SDK 세션에 더하지 않는 데우기 경로

- **지금.** `claude-sdk-oauth`는 Claude Agent SDK를 거친다. pi-ai `warmPromptCache`는 이 api에 `supported: false`를 돌려준다. SDK로 질의를 보내면 SDK 세션에 기록이 추가되어 대화가 바뀐다.
- **필요.** 마지막 실제 요청과 같은 접두부(system, tools, messages)로, SDK 세션 기록에 남지 않는 요청을 `max_tokens` 0으로 한 번 보내는 경로. 사용량(input, cacheRead, cacheWrite)을 돌려줘야 한다. 1시간 쓰기와 5분 쓰기를 구분할 수 있으면 더 좋다.

## 2. Codex: openai-codex-responses warmer 등록

- **지금.** `openai-codex-responses`에는 등록된 캐시 warmer가 없다.
- **필요.** 다음 조건을 지키는 warmer.
  - 본대화와 **같은 `prompt_cache_key`**를 쓴다.
  - `store: false`로 보내 응답이 저장되지 않는다.
  - `previous_response_id`를 쓰지 않는다(대화 체인에 끼지 않는다).
  - 출력 0토큰에 가까운 최소 요청이고, 사용량을 돌려준다.

## 3. 유휴당 최대 시간 설정

- **지금.** 내장 cache-keepalive는 3회, $0.05로 고정돼 있고 'Warm ping' 항목을 대화에 남긴다.
- **필요.** 유휴 한 번에 데울 최대 시간(또는 핑 수)을 설정으로 받는 것. 항목을 남기지 않는 모드.

## 4. ctx 수준의 흔적 없는 warm 호출

- **필요.** 확장이 `ctx`에서 바로 부를 수 있는 데우기 함수. 내장 keepalive가 하는 조립(prepareProviderRequest → convertToLlm, getSystemPrompt, 활성 도구, getApiKeyAndHeaders, transformHeaders/transformPayload)을 호스트가 대신 하고, 대화 기록, 턴, UI에 흔적을 남기지 않는다.
- 지금 keepwarm은 이 조립을 직접 한다. 호스트 내부 순서가 바뀌면 따라가야 한다.

## 다른 확장과의 관계

**on 모드 핑도 다른 확장의 `before_provider_request` 핸들러를 거친다.** senpi의 `transformPayload`가 `emitBeforeProviderRequest`를 부르고, 호출한 확장만 빼고 모든 확장의 핸들러를 돌린다(`senpi/dist/core/extensions/runner.js` 1418-1421행). 그래서 다른 확장이 핑 요청을 보고 기록하거나 바꿀 수 있다. keepwarm은 바뀐 페이로드의 접두부가 마지막 실제 요청과 다르면 네트워크 전에 멈춘다. 흔적 없는 warm 호출(4번)을 만든다면 이 경로를 핑에서 건너뛸지 정해야 한다.

## 참고

- 판정 근거: [모델별 캐시 TTL 기본값](모델별-캐시-TTL-기본값.md)
- 경로가 생긴 뒤의 검증 절차: [유료 실측 제안](유료-실측-제안.md)
