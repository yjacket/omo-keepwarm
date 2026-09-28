# 정리 기록

이 작업이 만든 임시 경로와 그 처리. 모두 이 작업이 직접 만든 정확한 경로만 지웠다. 공유 TEMP(`%LOCALAPPDATA%\Temp`)에는 아무것도 만들지 않았고, 그 안의 기존 항목에도 손대지 않았다.

| 경로 | 만든 이유 | 처리 |
|---|---|---|
| `.omo/evidence/idle-existing-data-analysis/out-rerun/` | 재현성 확인용 두 번째 실행 결과 | `out/rerun-compare.txt`를 기록한 뒤 `rm -r -- <정확한 경로>`로 삭제했다(두 번 만들고 두 번 삭제). 최종 삭제는 마지막 재실행 직후다 |
| `.omo/evidence/idle-existing-data-analysis/tmp/repro-<pid>/` | 결함 재현 스크립트가 쓰는 가짜 rollover 디렉터리 | 스크립트가 끝날 때 그 경로만 삭제한다. 결과 파일의 `tmpRemoved: true`로 확인했다 |
| `.omo/evidence/idle-existing-data-analysis/tmp/` | 위 경로의 부모 | 비어 있음을 확인하고 `rmdir -- <정확한 경로>`로 삭제했다 |
| `.omo/evidence/idle-existing-data-analysis/relocation-check/` | 스크립트를 `scripts/idle-existing-data/`로 옮긴 뒤 재현 확인(결과 6개 모두 기록된 해시와 동일) | `rm -r -- <정확한 경로>`로 삭제했다 |

2026-09-28 추가 기록:

- 스크립트는 `scripts/idle-existing-data/`로 옮겨 커밋 `ac2acf5`에 넣었다. 사용자 승인에 따라 `wt/idle-existing-data-analysis`에 푸시했다.
- 결과(`out/`)와 입력 해시(`inputs/`)는 개인 세션 기록에서 나온 값이라 로컬에만 둔다.
- 위키 원고와 차트는 새 비공개 저장소 `yjacket/omo-keepwarm`(`C:/dev/omo/omo-keepwarm`, 커밋 `3515c29`)의 `docs/`로 옮겨 푸시했다. 분석 작업트리의 중복본 `docs/wiki/`는 `rm -r -- <정확한 경로>`로 지웠다. 차트는 `expiry-charts.py`로 다시 만들 수 있다.

남긴 것은 이 폴더(`inputs/`, `scripts/`, `out/`, 문서)와 보고서 `docs/idle-existing-data-analysis.md`다. 작업트리 `C:/dev/omo/omo-rollover-wt/idle-existing-data-analysis`와 브랜치 `wt/idle-existing-data-analysis`는 산출물이 있는 곳이라 지우지 않았다. 커밋은 하지 않았다.

그 밖의 기록 두 가지:

- 분석 중 eval 도구 하나가 오래 걸려 백그라운드로 넘어갔다. 그때 도구 쪽이 이 세션의 artifacts 폴더에 출력 로그를 남겼다. 하네스가 관리하는 경로라 건드리지 않았다.
- 입력 파일은 하나도 쓰거나 지우지 않았다. `inputs/inputs-verify.txt`에 따르면 앞부분이 바뀐 파일은 0개다.

2026-09-28 이전 기록: 이 근거 묶음과 보고서·스크립트·지시서를 비공개 저장소 omo-keepwarm의 `research/existing-data-analysis/`로 옮겼다. 옮기기 전에 sha256으로 원본과 같음을 확인했다. 새 위치에서 다시 실행했을 때도 결과 6개가 기록된 해시와 같았다. omo-rollover 쪽 원본(원격 브랜치 `wt/idle-existing-data-analysis`, 로컬 작업트리, `.omo` 근거, 지시서)은 옮긴 뒤 지웠다.
