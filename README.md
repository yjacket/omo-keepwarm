# omo-keepwarm

OMO/senpi 세션이 유휴일 때 프롬프트 캐시를 언제까지 데우고 언제 만료시킬지 정하는 확장이다. **아직 설계 단계이고 코드는 없다.**

## 문서

- [유휴 캐시 만료 정책](docs/유휴-캐시-만료-정책.md): 기본 정책(5분 lane 30분, 1시간 lane 4시간), 만료 산식, 사용자 행동 입력, 확장 동작, 차트
- [모델별 캐시 TTL 기본값](docs/모델별-캐시-TTL-기본값.md): lane별 TTL, 핑 간격, 가격비 r의 기본값과 출처(2026-09-28 조사)

## 배경

omo-rollover의 유휴 비용 조사에서 나온 결론을 옮긴 것이다.

- **데우기는 경제성이 확인됐다.** 복귀 확률 곡선으로 재생하면 만료 방치가 가장 비쌌다.
- **파킹(rollover)은 효과를 측정하기 어렵다.** 인수인계에 숨은 비용이 많기 때문이다. 이 확장에서는 기본으로 꺼 둔다.

조사 자료:

- [조사 보고서](https://github.com/yjacket/omo-rollover/blob/wt/idle-existing-data-analysis/docs/idle-existing-data-analysis.md)
- [재현 스크립트](https://github.com/yjacket/omo-rollover/tree/wt/idle-existing-data-analysis/scripts/idle-existing-data)
- [유료 실측 보고](https://github.com/yjacket/omo-rollover/blob/wt/idle-existing-data-analysis/docs/idle-cost-report.md)

## 구현 전에 확인할 것

1. **데우기 핑 경로.** senpi 내장 `cache-keepalive`는 API 키로 쓰는 Anthropic lane만 지원한다. 주력인 Claude 구독(Agent SDK 경유)과 Codex에는 대화에 흔적을 남기지 않는 핑 경로가 있는지부터 확인해야 한다. 경로를 새로 만드는 것보다, senpi upstream에 구독 lane 지원과 유휴당 최대 시간 설정을 요청하는 쪽이 코드가 가장 적게 든다.
2. **5분 lane의 TTL 갱신.** 5분 lane에서 캐시를 읽으면 TTL이 갱신되는지와 lane별 가격비 r을 확인해야 한다(Claude 1시간 lane만 실측됨).
3. **기록 설계.** 결정과 결과 기록에서 확장 자신이 보낸 명령을 사용자 복귀로 세지 않게 해야 한다. omo-rollover의 shadow 기록에 이 결함이 있었다.
