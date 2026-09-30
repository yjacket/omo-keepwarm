# 유휴 캐시 비용 연구 자료

유휴 세션의 캐시를 데울지, 파킹할지, 만료시킬지 정하려고 한 연구의 원자료와 보고서다. 2026-09-28에 omo-rollover에서 옮겨 왔다. `brief/`, `quota-2026-09-19/`, `idle-cost-v2/`는 원본과 sha256이 같고, `.gitattributes`의 `research/** -text`로 바이트를 그대로 보존한다. `existing-data-analysis/`는 옮기면서 스크립트 경로와 보고서의 재현 절을 새 위치에 맞게 고쳤다.

## 읽는 순서

1. [brief/AGENT_TASK.md](brief/AGENT_TASK.md): 연구 의뢰서(유휴 정책 v2). 같은 폴더에 참조 구현과 검토 자료(`references/`), 파킹 대 데우기 연구 의뢰(`park-effectiveness-research-brief.md`)가 있다.
2. [quota-2026-09-19/REPORT.md](quota-2026-09-19/REPORT.md): 첫 quota 측정(계수 사전값의 출처). 원시 캡처와 측정 스크립트가 함께 있다.
3. [idle-cost-v2/idle-cost-report.md](idle-cost-v2/idle-cost-report.md): 유료 실측 2회를 합친 최종 보고. 실측 결과, 근거 묶음, 실험 계획, 승인서가 같은 폴더에 있다.
4. [existing-data-analysis/report.md](existing-data-analysis/report.md): 추가 호출 없이 기존 자료로 한 오프라인 분석. 복귀 확률 q, 계기 지연, 복원 비용, DP 재생이 들어 있다. 지시서(`prompt.md`), 스크립트(`scripts/`), 근거(`evidence/`)가 함께 있다.
5. [offline-replay-2026-09-30/README.md](offline-replay-2026-09-30/README.md): keepwarm 설치 점검(2026-09-30) 때 세션 기록만으로 Claude 구독 lane의 유휴 데우기 절감을 재생한 분석. omo-rollover에서 옮긴 자료가 아니라 이 저장소에서 새로 만든 것이다.
6. 결론을 정리한 문서는 [docs/](../docs/)에 있다.

## 출처와 원본 상태

| 여기 경로 | 원본 | 원본 처리 |
|---|---|---|
| `brief/` | omo-rollover 작업 폴더의 `rollover_agent_task/`, `docs/park-effectiveness-research-brief.md`(git 추적 안 됨) | 원본 삭제 |
| `quota-2026-09-19/` | omo-rollover 작업 폴더의 `quota-test/2026-09-19/`(git 추적 안 됨) | 원본 삭제 |
| `idle-cost-v2/` | omo-rollover 브랜치 `wt/idle-cost-shadow-implementation`, 커밋 d8a4abd의 `docs/idle-*` 11개 | **원본 유지.** 그 브랜치의 실행기·분석기·테스트가 이 파일을 읽고, 승인서는 해시로 묶여 있다 |
| `existing-data-analysis/` | omo-rollover 브랜치 `wt/idle-existing-data-analysis`(보고서·스크립트), 로컬 `.omo/evidence/idle-existing-data-analysis/`(근거), `.omo/rollover/prompt-idle-existing-data-analysis.md`(지시서) | 원본 삭제(원격 브랜치 포함) |

## 여기로 옮기지 않은 것

- **코드.** 유휴 비용 엔진, shadow 기록, 실측 실행기와 분석기는 omo-rollover 브랜치 `wt/idle-cost-shadow-implementation`에 있다. keepwarm 확장은 이 코드를 옮기지 않고, 필요한 부분을 이 저장소의 `src/`와 `extension/`에 새로 구현했다.
- **유료 실측 원본.** 요청·응답 기록과 CLI 응답이며, 로컬에만 있다. 위치는 `C:/dev/omo/omo-rollover-wt/idle-rerun-w1/.omo/ulw-execute/evidence/idle-live-run/` 아래 `live/20260925-161302`와 `rerun/20260927-052028`이다. 해시는 `existing-data-analysis/evidence/inputs/inputs.json`에 있다.
- **실행 로그와 세션 인수인계 메모.** 실측 런처 스크립트와 실행 로그, 세션 인수인계 메모는 문서가 아니라 작업 기록이라 omo-rollover의 `.omo/rollover/`에 남겼다.
