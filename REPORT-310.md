# REPORT-310

status: READY_FOR_REVIEW

Executor: Claude cc-executor (fallback; codex quota exhausted, Human re-dispatched 2026-10-26). No prior-executor commits: HEAD was still base `b5853a4` at hand-off, all work below is this executor's.

## 1. 改動位置

- `scripts/endpoints.mjs`: `BACKFILL_ENDPOINTS` 新增 `twse_twt38u_hist`／`twse_twt44u_hist`／`twse_twt43u_hist`（cadence daily，無 `selectType`），插在 `twse_t86_hist` 之後。
- `scripts/lib/derived.mjs`: `DERIVED_INPUT_DATASETS` 加三個 dataset；新增 `parseTwseTwt38uHist`／`parseTwseTwt44uHist`／`parseTwseTwt43uHist`（stat OK、fields 逐字相等、列寬、同代號不重複、買賣超可解析；不看 title）與 `mergeTwseLegacyInsti`（聯集、缺席 0、`fi=ff+ft+fd`，輸出 `{id,name,fi,ff,ft,fd}`）；`applyDailyDate` 讀三個 namespace，T86 存在→只用 T86；T86 缺且三支齊→合併；否則 `null`。
- `scripts/lib/history-backfill.mjs`: 三個 endpoint 加進 `DAILY_ENDPOINTS`（`maxIso: '2012-05-01'`），資料端點迴圈在 `iso > maxIso` 時 `continue`（不發請求、不計數）；`recordEndpoint` 對缺 key／缺 kind 從 0 起算。
- `scripts/detect-gaps.mjs`: `COVERAGE_SOURCES.twse` 加三個 dataset。
- 授權的既有測試改動：`tests/backfill.test.mjs` key 清單加三 key、`18`→`21`；`tests/history-backfill.test.mjs` 的 `fixtureFetcher` 加三支分支（`twtLegacy` 選項）與 `twtFixture`，檔尾新增 2 條測試；`tests/all.mjs` 只加一行 import。其餘既有測試未動。
- 新測 `tests/twse-legacy-insti.test.mjs`（6 條）；`README.md`、`AGENTS.md` 同步說明（README 的「10 個 legacy JSON 來源」→13）。

## 2. `node --test tests/`（worktree）

```
# tests 350
# pass 350
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
基線 342/342；新增 8 條（新檔 6、runner 2）。總數 350 ≥ 350。

## 3. Acceptance 對照

1. 2006-10-16 合併（Hard Fact 7 逐字 fixture）：2330／1305／2357／2854／2855 的 fi/ff/ft/fd 與代號名稱去空白——`2006-10-16 merge…` 通過。
2. derived 等價：2012-05-02，root A 只放 T86 五列、root B 只放三支樣本列，同一份收盤 fixture，整棵 `data/derived` 位元組相同，且 2330 為 `6686657／5943657／12000／731000`——`applyDailyDate on three legacy files…` 通過。
3. T86 與三支同在→用 T86（三支刻意給 111/222/333）；缺一支或全缺→欄位 `null`——`T86 wins when present…` 通過。
4. 三支各一例欄名改字／列寬錯／重複代號／stat 非 OK 皆丟錯——三條 `TWTxxU parser…` 通過。
5. runner 2012-05-01～05-02：三支只在 05-01 各請求 1 次且寫入 raw，05-02 為 0 次、無 raw——`legacy institutional endpoints are requested only on or before 2012-05-01` 通過。
6. 舊進度檔（base 形狀、缺三 key、`IN_PROGRESS`）續跑到 `DONE`，三 key 計數為 `{written:1,exists:0,unavailable:0,quarantined:0,failed:0}`——`a base-shaped progress file…` 通過。
7. 既有 342 條除授權處外未改且全綠。`:213` 那條（`a data-bearing rejected TWT93U response is quarantined byte-for-byte`，範圍 2006-10-16）加了 fetcher 分支後 `result.status === 'DONE'`（用暫存複本臨時 `console.log` 取得：`EV213_STATUS=DONE`；斷言未改）。`:200` 那條（unavailable T86，2012-04-30～05-01）同樣通過且未改斷言。

## 4. 消融（每組都在完整 `node --test tests/` 下實跑，之後還原）

| # | 破壞 | 轉紅的測試 |
|---|---|---|
| ① | 合併缺席補 `null` 而非 0 | `2006-10-16 merge: union by id, absent legs are 0…`；`applyDailyDate on three legacy files is byte-identical to the same day from T86` |
| ② | `applyDailyDate` 在 T86 存在時改用三支 | `T86 wins when present; any missing leg leaves the institutional columns null` |
| ③ | runner 拿掉 `maxIso`（2012-05-01 上限） | `history runner stores byte-identical raw only and leaves legacy checkpoint untouched`（既有，2021 年 call 數 30 變多）；`legacy institutional endpoints are requested only on or before 2012-05-01` |
| ④ | `fd` 與 `ft` 對調 | `2006-10-16 merge…`；`applyDailyDate on three legacy files is byte-identical…` |

還原後：`# tests 350 / # pass 350 / # fail 0`（還原後 `git diff` 與消融前一致）。

## 5. 未決／備註

- 無 Stop/Escalate 條款觸發；未連網、未在真實 `data/` 執行寫入腳本、未在主目錄操作；`data` symlink 未 commit（逐檔 `git add`）。
- `fi` 對 2012-05-02 前缺官方合計可比，沿用 Hard Fact 5 的兩日推論（高機率，非逐日證明）。
