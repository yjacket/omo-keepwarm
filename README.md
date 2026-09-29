# omo-keepwarm

OMO/senpi 세션에서 사람이 자리를 비운 동안 프롬프트 캐시를 데울지, 언제 만료시킬지 정하는 확장이다. 조용히 돈다. 대화 기록에 항목을 넣지 않고, 턴을 만들지 않고, UI에 아무것도 띄우지 않는다.

- 모든 모델을 lane으로 나누고, lane마다 캐시 수명(TTL), 핑 간격, 가격비 r, 데우기 경로를 정한다.
- 사람이 자리를 비우면 에피소드를 열고, 핑 시점마다 "지금 데울 가치가 있나"를 산식으로 판단해 기록한다.
- 실제로 핑을 보내는 것은 mode `on`이고 검증된 lane일 때뿐이다. 기본 mode는 `shadow`여서 판단과 기록만 한다.

## lane 판정

데우기 경로가 있는지를 lane별로 정리했다. 판정 기준은 `src/lanes.mjs`의 `warmPath`다. `warmPromptCache`면 가능이고, `none`이면 불가 또는 미확인이다.

| lane id | 주 사용 모델 | 판정 | 근거 한 줄 |
|---|---|---|---|
| `claude-subscription` | claude-opus-5-5, claude-fable-5-1 | 불가 | Agent SDK 경유라 pi-ai `warmPromptCache`가 supported:false를 돌려주고, SDK 질의는 SDK 세션에 기록을 더한다 |
| `codex-subscription` | gpt-5.6-sol, gpt-6-astra | 불가 | `openai-codex-responses`에는 등록된 캐시 warmer가 없다 |
| `anthropic-api` | claude-opus-5 (API 키) | 가능 | pi-ai `warmPromptCache` 지원 대상이다. 5분 읽기 갱신이 미검증이라 기본 꺼짐 |
| `openai-api` | GPT-5.6 이상 (API 키) | 가능 | pi-ai `warmPromptCache` 지원 대상이다. 읽기 갱신이 미검증이라 기본 꺼짐 |
| `github-copilot` | gpt-5.6-sol, claude-fable-5-1 | 불가 | 요청 과금이라 핑 한 번이 그대로 비용이다 |
| `devin` | swe-2-high, swe-2-max | 불가 | 데우기 원시 기능이 없고 캐시 쓰기 필드가 늘 0이다 |
| `other` | 그 밖의 모델, 비공식 호스트 | 미확인 | 모르는 lane이라 요청을 보내지 않는다 |

"기본 꺼짐"은 `verified`가 기본 `false`라는 뜻이다. mode `on`이어도 검증되지 않은 lane에서는 `would_warm`만 기록한다. 켜는 절차는 [정책 문서의 활성화 단계](docs/유휴-캐시-만료-정책.md#shadow에서-활성화로-가는-단계)에 있다. 판정의 코드 근거는 [모델별 캐시 TTL 기본값](docs/모델별-캐시-TTL-기본값.md)에 있다.

지금 주로 쓰는 lane(Claude 구독, Codex)은 모두 불가다. 그래서 설치해도 핑은 0이고, 판단 기록만 쌓인다. 필요한 upstream 기능은 [senpi upstream 요구](docs/senpi-upstream-요구.md)에 정리했다.

## 설치, 업데이트, 제거

```sh
node bin/omo-keepwarm.mjs install      # 릴리스 복사, current.json, config.json(없을 때만), 스텁
node bin/omo-keepwarm.mjs update       # install과 같은 흐름. 스텁이 같으면 건드리지 않는다
node bin/omo-keepwarm.mjs uninstall    # config mode off를 먼저 쓰고 스텁을 지운다
node bin/omo-keepwarm.mjs uninstall --purge   # 데이터 폴더까지 지운다
node bin/omo-keepwarm.mjs doctor       # PASS/WARN/FAIL 점검
```

- 스텁은 `~/.omo/agent/extensions/omo-keepwarm.ts` 하나다. 버전과 경로를 담지 않아서 업데이트해도 다시 쓰지 않는다. 스텁을 다시 쓰면 열린 세션이 모두 재로드되기 때문이다.
- 릴리스는 `~/.omo-keepwarm/app/releases/<version>/`에 복사하고 바꾸지 않는다. `app/current.json`이 `{ version, root, previous, lkg }`로 현재 릴리스를 가리킨다. 스텁은 `root`를 먼저, 실패하면 `lkg.root`를 로드한다.
- `lkg`(마지막 정상 버전)는 세션이 실제로 로드에 성공한 표시(`app/loaded/<version>`)가 있는 버전만 된다.
- install, update, uninstall은 바쁜 세션이 있으면 거부한다. keepwarm 상태 파일의 phase가 BUSY, PINGING, CLASSIFYING이거나, omo-health 파일이 idle이 아니거나 도구를 실행 중이면 바쁜 것이다. 명령을 부른 세션 자신(`PI_SESSION_ID`)은 제외하고, 제외했다면 `busy check: excluded caller session <id>`를 출력한다. `--force`는 검사를 건너뛴다.
- `~/.omo`의 다른 파일은 건드리지 않는다.

종료 코드:

| 코드 | 뜻 |
|---|---|
| 0 | 성공 |
| 1 | install 실패, doctor에 FAIL 있음 |
| 2 | 인자 오류, calibrate 데이터 부족 |
| 3 | 바쁜 세션이 있어 거부 |
| 64 | 모르는 명령 |
| 70 | 명령 파일이 없음 |

## 스위치와 상한

설정은 `~/.omo-keepwarm/config.json` 하나다. 파일이 없으면 off다. install이 만든다.

| 키 | 기본값 | 뜻 |
|---|---|---|
| `mode` | `"shadow"` | `off`, `shadow`(판단과 기록만), `on`(검증 lane에서 실제 핑) |
| `maxUsdPerEpisode` | `0.5` | 에피소드당 USD 상한 |
| `maxUsdPerDay` | `3` | 하루 USD 상한. 모든 세션이 장부 하나를 나눠 쓴다 |
| `expiry` | `{}` | lane별 만료 설정. `expiry set`으로 바꾼다 |
| `habit` | `"auto"` | 복귀 습관. `habit set`, `habit auto`로 바꾼다 |
| `lanes` | `{}` | 고급 덮어쓰기. [기록과 상태 계약](docs/기록과-상태-계약.md) 참고 |

바꾼 값은 재로드 없이 다음 tick이나 다음 에피소드에 반영된다.

상한은 핑 1회의 예상 비용(맥락 × 캐시 읽기 단가)으로 미리 계산해, 넘을 것 같으면 보내지 않는다. 캐시 미스가 나면 그 세그먼트의 데우기를 멈춘다(다음 턴이 끝나면 새 세그먼트가 다시 시작한다). 모든 핑을 미리 상한과 견주므로 상한을 넘는 폭은 재작성 1회분까지다. 데우기 경로가 없는 lane은 돈을 쓸 수 없어서 USD 상한을 적용하지 않고, 핑 수 상한만 둔다.

## 명령 예시

아래 `omo-keepwarm`은 이 저장소의 `node bin/omo-keepwarm.mjs`를 줄여 쓴 것이다. 짧은 이름으로 쓰려면 저장소에서 `npm link`(또는 `bun link`)를 한 번 실행한다. 출력은 빈 임시 홈(`OMO_KEEPWARM_HOME`)에서 실제로 돌린 결과다.

`expiry`는 lane별 산식값, 자동값, 현재 설정, 격자를 보여 준다. 대괄호가 지금 쓰는 단계다.

```text
$ omo-keepwarm expiry
```

```text
claude-subscription  TTL 60m · ping every 55m · r 0.025 · habit default (p 0.81, m 10.5m, t90 2h20m)
  formula 5h30m → auto 5h · setting auto
  steps: 0 · 1h · 2h · 3h · 4h · [5h] · 6h · 8h · 12h

codex-subscription:30m  TTL 30m · ping every 27m · r 0.08 · habit default (p 0.81, m 10.5m, t90 2h20m)
  formula 1h48m → auto 2h · setting auto
  steps: 0 · 30m · 1h · 1h30m · [2h] · 3h · 4h · 6h

anthropic-api:5m  TTL 5m · ping every 4.5m · r 0.08 · habit default (p 0.81, m 10.5m, t90 2h20m)
  formula 18m → auto 20m · setting auto
  steps: 0 · 10m · 15m · [20m] · 30m · 45m · 1h · 1h30m · 2h

anthropic-api:1h  TTL 60m · ping every 55m · r 0.05 · habit default (p 0.81, m 10.5m, t90 2h20m)
  formula 3h40m → auto 4h · setting auto
  steps: 0 · 1h · 2h · 3h · [4h] · 5h · 6h · 8h · 12h

openai-api:30m  TTL 30m · ping every 27m · r 0.08 · habit default (p 0.81, m 10.5m, t90 2h20m)
  formula 1h48m → auto 2h · setting auto
  steps: 0 · 30m · 1h · 1h30m · [2h] · 3h · 4h · 6h
```

수동 단계는 격자 값 중 하나로 고른다. `auto`로 되돌린다.

```sh
omo-keepwarm expiry set claude-subscription 4h
omo-keepwarm expiry set anthropic-api:5m 30m
omo-keepwarm expiry set claude-subscription auto
```

`habit`은 복귀 습관 세 숫자와 출처를 보여 준다.

```text
$ omo-keepwarm habit
habit default (p 0.81, m 10.5m, t90 2h20m)
setting auto
```

```sh
omo-keepwarm habit set --return-rate 0.8 --median 12m --t90 2h
omo-keepwarm habit auto
```

`status`는 `status/_global.json`을 읽는다. 스냅샷이 없으면 이렇게 나온다.

```text
$ omo-keepwarm status
keepwarm: not running (no snapshot)
```

`report`는 최근 에피소드, 복귀, 반사실 절감을 보여 준다. `--days 7`, `--json`이 있다.

```text
$ omo-keepwarm report
keepwarm report · last 7 days · 0 episodes
```

`calibrate`는 기록으로 p, m, t90을 추정한다. 사람 복귀가 30건 미만이면 아무것도 쓰지 않고 2로 끝난다. `--write`일 때만 `behavior.json`을 쓴다.

```text
$ omo-keepwarm calibrate
episodes 0 · human returns 0 · context ended 0 · censored 0 (window 28 days, Aalen-Johansen)
p - · m - · t90 -
not enough data: need 30 human returns and a valid estimate; nothing written
```

## 기록 위치

모두 `~/.omo-keepwarm/`(또는 `OMO_KEEPWARM_HOME`) 아래에 있다.

| 경로 | 내용 |
|---|---|
| `config.json` | 스위치, 상한, expiry, habit, lanes |
| `behavior.json` | calibrate가 쓴 관찰 습관 |
| `records/<YYYY-MM>/<sessionId>.jsonl` | 기록 v1 |
| `status/<sessionId>.json`, `status/_global.json` | 상태 스냅샷 |
| `ledger/spend-<date>.jsonl`, `ledger/day-<date>.jsonl` | 비용 장부, 하루 집계 |
| `logs/errors.log`, `logs/stub.log` | 오류 로그, 스텁 로드 실패 |

필드는 [기록과 상태 계약](docs/기록과-상태-계약.md)에 있다.

## 끄는 법

- 잠시 끄기: `config.json`의 `mode`를 `"off"`로 바꾼다. 재로드 없이 다음 tick이나 다음 이벤트에서 멈춘다. 열린 에피소드는 `config_off`로 한 번 닫히고 그 뒤로는 아무것도 쓰지 않는다. `--purge`로 지운 뒤에는 열려 있던 세션도 home을 다시 만들지 않는다.
- 완전히 끄기: `omo-keepwarm uninstall`. 데이터까지 지우려면 `--purge`를 붙인다.

## 문서

- [유휴 캐시 만료 정책](docs/유휴-캐시-만료-정책.md): 산식, 격자, 수동 단계, 에피소드와 두 시계, 습관 출처, 활성화 단계
- [모델별 캐시 TTL 기본값](docs/모델별-캐시-TTL-기본값.md): lane별 TTL, 간격, r, 판정 근거
- [기록과 상태 계약](docs/기록과-상태-계약.md): 기록 v1, config, behavior, 스냅샷, omo-health 읽기 규칙
- [senpi upstream 요구](docs/senpi-upstream-요구.md): 주력 lane을 데우려면 senpi에 필요한 것
- [유료 실측 제안](docs/유료-실측-제안.md): 아직 실행하지 않은 측정 계획
- [운영과 문제 해결](docs/운영과-문제-해결.md): 세션 phase, doctor 결과 읽기, 자주 보는 경고, 끄기와 제거
- [개발과 검증](docs/개발과-검증.md): 코드 구조, 규칙, 단위 테스트, 실제 senpi 시나리오, 개발 중 코드로 띄우기

## 배경

omo-rollover의 유휴 비용 조사에서 나온 결론을 옮긴 것이다. 데우기는 경제성이 확인됐다. 파킹(rollover)은 효과를 재기 어려워서 이 확장에 넣지 않았다. 조사 자료는 [research/](research/README.md)에 있고, 바꾸지 않고 보존한다.
