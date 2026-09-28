# Rollover cache/parking policy v1.0

작성일: 2026-09-19. 비용 단위는 입력 정가 환산 **토큰**, 시간 단위는 **밀리초**입니다.

이 패키지는 계산 엔진과 연구 문서입니다. 실제 rollover 저장소를 수정하거나 API 요청을 실행하지 않습니다.

## 파일

| 파일 | 역할 |
|---|---|
| `research-report.md` | 가정, 실측, 비용식, 온라인 결정식, 한계와 출처 |
| `research-report.docx` | 같은 연구 내용을 읽기용 문서로 정리 |
| `src/cache-policy.ts` | 순수 TypeScript 비용·교차점·예측 정책·안전 가드 |
| `dist/cache-policy.js`, `.d.ts` | 컴파일 결과. 실행 시 외부 패키지 불필요 |
| `tests/cache-policy.test.cjs` | 30개 테스트; 별도로 120개 생성 시나리오 교차검증 포함 |
| `test-results.txt` | 실제 실행 결과 |
| `demo.cjs` | 수치 예제 |

## 실행

컴파일된 코드를 바로 실행할 수 있습니다.

```sh
node demo.cjs
node --test tests/cache-policy.test.cjs
```

TypeScript 수정 후 재빌드:

```sh
tsc -p tsconfig.json
node --test tests/cache-policy.test.cjs
```

검증 환경은 Node.js 22.16.0, TypeScript 5.8.3입니다. 최신 버전 추천이나 모든 런타임 호환성 보장은 아닙니다.

## 연결 예제

```ts
import { baselineCosts, advise } from './cache-policy';

const costs = baselineCosts({ contextTokens: 150_000 });
const advice = advise(
  {
    remainingTtlMs: 30_000,
    cacheVerified: true,
    busy: false,
    userRequestPending: false,
    parked: false,
  },
  costs,
  {
    // 검증용 가상 분포. 실제 사용자 복귀 확률로 오인하거나 그대로 적용하지 않는다.
    returns: [
      { afterMs: 120_000, probability: 0.9 },
      { afterMs: 3_600_000, probability: 0.1 },
    ],
    neverReturnsProbability: 0,
  },
  {
    ttlMs: 300_000,
    intervalMs: 270_000,
    sharedCachePersists: false,
    allowParking: true, // 필요한 원문 보존/승인/품질 조건을 충족했을 때만 true
  },
);
console.log(advice);
```

`LET_EXPIRE`는 세션 삭제가 아니라 **추가 요청 없이 캐시 만료를 허용**한다는 뜻입니다.
원문·작업 파일·세션 메타데이터는 보존합니다. 사용자 복귀가 타이머보다 우선합니다.

## 적용 경계

- 첫 적용은 `shadow`로 하고 계산 결과만 기록합니다. 이 모드는 호출 측에서 구현합니다.
- `LET_EXPIRE` 이후에는 같은 유휴 구간의 갱신 타이머를 중단합니다. 실제 사용자/작업 활동으로 새 유휴 구간이 시작될 때만 다시 평가합니다.
- `advise`는 유효 TTL과 캐시 히트를 확인할 수 없으면 데우기를 지시하지 않습니다.
- 복귀 분포가 없으면 자동 파킹하지 않습니다. 기본은 만료 허용이며, 별도 승인한 유한 예산으로 `budgetFallback`을 사용할 수 있습니다.
- 현재 비용은 claude-sdk-oauth 로그의 가격 환산값입니다. OAuth 실제 quota 소모를 검증한 것이 아닙니다.
- TTL 30분은 계산 가능한 다른-lane 시나리오일 뿐, Claude의 네이티브 30분 캐시 옵션을 뜻하지 않습니다.
- 대표식의 C는 전체 컨텍스트가 cache hit한다는 가정입니다. 실제 hit prefix 밖의 입력과 최신 출력·도구 결과는 ε 또는 실측 warmEq/rawWarmEq에 반영합니다. cacheVerified는 단순히 hit가 1토큰 이상 있다는 의미가 아닙니다.
- 동일 세션에서도 lane/model/effort/prefix가 바뀌면 비용·캐시 상태를 다시 구성합니다. `planIdle` 한 번의 미래 계산은 동일 lane을 가정합니다.
- 현재 엔진은 부모에서 요약만 생성하고 **실제 복귀 시에 후속 세션을 시작**하는 파킹을 모델링합니다. 후속 세션까지 미리 실행하는 구현에는 추가 재개 비용이 필요합니다.
- 예측 분포의 `neverReturnsProbability`는 관측이 끝난 미복귀 데이터나 단순한 예측 범위 밖 확률이 아닙니다. 오른쪽 검열/장기 복귀 꼬리를 별도로 추정해야 합니다.
- 실제 호출 직전의 session generation 검증, 원자적 handoff 저장·활성 세션 교체, 오류 복구, API별 usage 변환, 개인정보 보호는 어댑터 책임입니다.
