# READY_FOR_REVIEW

TICKET-297 r1 已依 Contract 實作。未觸發 Stop / Escalate 條款；未連網、未在 repo 真實 `data/` 執行 runner 或資料腳本、未執行 `launchctl`。

## 1. 定義位置

- 入口函式：`scripts/lib/history-backfill.mjs:394` 的 `runHistoryBackfill(options)`。
- CLI：`scripts/history-backfill.mjs:16` 嚴格解析旗標，`:40` 將 CLI 值轉成 runner options，`:52` 只呼叫 runner 並套用其 exit code。
- 跨程序鎖：`scripts/lib/history-backfill.mjs:212` 的 `acquireLock` 以原子 `mkdir` 建鎖，活 pid 直接返回，死 pid 先以原子 rename 取得接手權再移除；`:379` 安裝 SIGINT/SIGTERM cleanup，runner `finally` 只在 owner token 相符時釋放鎖。
- 進度檔：`scripts/lib/history-backfill.mjs:189` 的 `saveProgress` 透過 `writeFileEnsured`（同目錄暫存檔 + rename）原子寫入 `data/history-backfill/progress.json`；每日完成及每個停止分支都會呼叫它。
- 既有 helper：`scripts/backfill.mjs` 只替 Contract Hard Fact 5 指定的四個 helper 加上 `export`，函式內容未改。

## 2. 完整測試

命令：

```text
node --test tests/
```

最終摘要原文：

```text
1..233
# tests 233
# suites 0
# pass 233
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11100.019692
```

## 3. 四組消融

每組都只暫改 `scripts/lib/history-backfill.mjs`，以指定的新測試取得紅燈後立即還原；下列各組還原後皆為 `tests 1 / pass 1 / fail 0`，最後完整 suite 亦為 233/233 綠。

### A. 拿掉暫停時段檢查

消融：將每日開始前的 `isInPauseWindow(...)` guard 強制為 false。

```text
# Subtest: the daily pause window writes PAUSED_DAILY_WINDOW without requests
not ok 1 - the daily pause window writes PAUSED_DAILY_WINDOW without requests
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 'DONE'
    - 'PAUSED_DAILY_WINDOW'
1..1
# tests 1
# pass 0
# fail 1
```

還原後：

```text
ok 1 - the daily pause window writes PAUSED_DAILY_WINDOW without requests
# tests 1
# pass 1
# fail 0
```

### B. runner 改寫 `.backfill-progress.json`

消融：在 `saveProgress` 額外把歷史 runner progress 寫入 legacy checkpoint。

```text
# Subtest: history runner stores byte-identical raw only and leaves legacy checkpoint untouched
not ok 1 - history runner stores byte-identical raw only and leaves legacy checkpoint untouched
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected

    + Buffer(1481) [Uint8Array] [
    - Buffer(23) [Uint8Array] [
1..1
# tests 1
# pass 0
# fail 1
```

還原後：

```text
ok 1 - history runner stores byte-identical raw only and leaves legacy checkpoint untouched
# tests 1
# pass 1
# fail 0
```

### C. 殘留鎖不接手

消融：把既有鎖一律視為 live lock，不走死 pid 接手路徑。

```text
# Subtest: a stale lock is taken over and removed after completion
not ok 1 - a stale lock is taken over and removed after completion
  error: |-
    Expected values to be strictly equal:

    'LOCKED' !== 'DONE'
  expected: 'DONE'
  actual: 'LOCKED'
1..1
# tests 1
# pass 0
# fail 1
```

還原後：

```text
ok 1 - a stale lock is taken over and removed after completion
# tests 1
# pass 1
# fail 0
```

### D. `unavailable` 當成失敗

消融：將合法 JSON、零資料列的 data endpoint 回傳改成 `failed`。

```text
# Subtest: a legal no-row T86 response is unavailable and does not stop later dates
not ok 1 - a legal no-row T86 response is unavailable and does not stop later dates
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 'PAUSED_NETWORK'
    - 'DONE'
1..1
# tests 1
# pass 0
# fail 1
```

還原後：

```text
ok 1 - a legal no-row T86 response is unavailable and does not stop later dates
# tests 1
# pass 1
# fail 0
```

## 4. CLI 零網路暫存演練

方式：建立 `/tmp/ticket297-fake-fetch.mjs`，用 Node `--import` 在 CLI 載入前覆寫 `globalThis.fetch`。fake fetch 只接受 MI_INDEX 與 TPEX dailyQuotes URL，分別回傳官方非交易日形狀與合法零列形狀；任何其他 URL 立即 throw。輸出 root 是 `/tmp/ticket297-cli.wiq1Y1`，`--delay-ms 0`，`--pause-window 00:00-00:00`。因此此演練零網路，且沒有讀寫 repo 真實 `data/`。

命令：

```text
node --import /tmp/ticket297-fake-fetch.mjs scripts/history-backfill.mjs \
  --from 2021-01-01 --to 2021-01-01 \
  --out /tmp/ticket297-cli.wiq1Y1 \
  --delay-ms 0 --pause-window 00:00-00:00
```

stdout 原文：

```text
[history-backfill] DONE 2021-01-01..2021-01-01 days=1
```

產出檔案只有：

```text
data/history-backfill/progress.json
```

`progress.json` 原文：

```json
{
  "schemaVersion": 1,
  "status": "DONE",
  "range": {
    "from": "2021-01-01",
    "to": "2021-01-01",
    "order": "desc"
  },
  "nextDate": null,
  "updatedAt": "2026-10-15T16:13:54.334Z",
  "days": {
    "total": 1,
    "done": 1,
    "trading": 0,
    "nonTrading": 1
  },
  "endpoints": {
    "twse/mi_index_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 1,
      "quarantined": 0,
      "failed": 0
    },
    "twse/t86_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    },
    "twse/mi_margn_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    },
    "twse/bwibbu_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    },
    "twse/sbl_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    },
    "tpex/daily_quotes_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 1,
      "quarantined": 0,
      "failed": 0
    },
    "tpex/insti_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    },
    "tpex/margin_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    },
    "tpex/pe_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    },
    "tpex/sbl_hist": {
      "written": 0,
      "exists": 0,
      "unavailable": 0,
      "quarantined": 0,
      "failed": 0
    }
  },
  "consecutiveAnchorFailures": 0,
  "recentDays": [
    {
      "date": "2021-01-01",
      "durationMs": 4,
      "twse": "non-trading",
      "tpex": "non-trading"
    }
  ],
  "failures": [],
  "launches": [
    {
      "startedAt": "2026-10-15T16:13:54.325Z",
      "endedAt": "2026-10-15T16:13:54.334Z",
      "daysDone": 1,
      "status": "DONE"
    }
  ]
}
```
