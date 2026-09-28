# idle-existing-data-analysis 근거 묶음 (로컬)

보고서는 [../report.md](../report.md)이고 스크립트는 [../scripts/](../scripts/)에 있다. 2026-09-28에 omo-rollover(로컬 `.omo/evidence/idle-existing-data-analysis/`)에서 비공개 저장소 omo-keepwarm으로 옮겼다. `inputs/`의 경로는 옮기기 전 기준이다.

- 모든 스크립트는 입력을 읽기만 한다.
- 네트워크, 모델 호출, 타이머, 예약 작업이 없다.
- 실행 환경은 Node v24.20.0, Python 3.13.14, numpy 2.3.3이다. 차트는 `uv run --with matplotlib`(matplotlib 3.11.2)로 만든다.

| 경로 | 내용 |
|---|---|
| `inputs/inputs.json` | 입력 387개 파일의 크기, 줄 수, sha256. 그룹은 rollover 이벤트 로그 126, senpi 대화 기록 133, 첫 실행 10, 재실행 108, 09-19 캡처 10 |
| `inputs/inputs-verify.txt` | 분석 뒤 재해시 결과. 앞부분이 바뀐 파일 0, 뒤에만 덧붙은 살아 있는 세션 2 |
| `inputs/paid-originals-vs-2026-09-27.txt` | 유료 원본 118개가 09-27 최종 검증 해시와 같음 |
| `out/q-summary.json`, `out/q-episodes-A.jsonl`, `out/q-episodes-B.jsonl` | 유휴 구간과 누적 복귀율(비식별: 세션 앞 8자, 저장소 이름, 시각만) |
| `out/gauge-lag-scan.json` | 계기 지연 모형별 실현 가능 영역 |
| `out/restore-reanalysis.json` | 복원 단계 합계 재현, 후속 세션 캐시 동작, 가정 시나리오, V, 재설명, 운영 후속 세션 |
| `out/dp-replay.json` | 기존 `planIdle` 오프라인 재생 |
| `out/crosscheck.json`, `out/crosscheck-compare.txt` | Python·numpy 독립 재계산, 47 PASS / 0 FAIL |
| `out/repro-self-dispatch-shadow.json` | 확장 자기 발송 `/rollover now`가 shadow를 "복귀"로 닫는 결함의 재현 |
| `out/proposal-cost-estimate.json` | 제안 실측의 지출 추정 |
| `out/expiry-table.json` | 쉬운 만료 산식의 lane별 만료 시점과 민감도(위키 차트의 원자료) |
| `out/rerun-compare.txt` | 두 번 실행한 결과 6개 파일이 바이트 단위로 같음 |
| `exclusions.md` | 제외와 분리의 근거 |
| `cleanup.md` | 이 작업이 만들고 지운 임시 경로 |

재현 명령은 보고서 6절에 있고, omo-keepwarm 루트에서 `ROLLOVER_REPO`를 준 채로 실행한다.
