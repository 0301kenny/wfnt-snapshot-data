# READY_FOR_REVIEW

TICKET-302 r1 已依 Contract 實作完成；未觸發 Stop / Escalate 條款。全程未連網、未執行 `launchctl`、未寫入真實 `data/`，所有會寫 raw／derived 的測試與演練都使用暫存 root。

## 1. 改動位置

- `scripts/backfill-quarterly.mjs:90-258`
  - 新增 `--refresh-recent N`（預設 0，經 `parseNumericFlag`）。
  - 最後 N 季可重抓；解析內容相同不寫，內容不同寫入 `.rev-{台北日期}.html`，主檔不存在時仍寫主檔。
  - `refreshRecent=0` 保持既有五欄回傳物件；啟用時增加 `revisions`、`unchanged`、`unpublished`。
  - 最後 `max(N, 1)` 季的兩種「尚未公布」解析錯誤會記錄並繼續。
- `scripts/lib/derived.mjs:848-902,2181-2230`
  - 主檔與所有日期排序的修訂檔逐版合併；新版覆寫同代號、舊版獨有代號保留。
  - 壞修訂檔 `console.warn` 後略過；只有主檔時直接回傳原 parser 結果。
  - Q2–Q4 前季列先查同市場，再查另一市場；TWSE winner priority 未改。
- `scripts/quarterly-refresh.mjs:1-90`（新增）
  - 依台北日期計算「上一季所屬年份減一 Q1」至上一季的範圍。
  - 預設 `--refresh-recent 4`；僅 `rawWritten > 0` 時呼叫 `rebuildQuarterly`；輸出一行摘要。
- `ops/launchd/com.wfnt.quarterly-refresh.plist:1-30`（新增）
  - 每週六 10:15，以 `/usr/local/bin/node` 執行；stdout/stderr 寫入 `~/Library/Logs/wfnt-quarterly-refresh.log` 對應的絕對路徑。
- `tests/quarterly-revisions.test.mjs:1-373`（新增）、`tests/all.mjs:13`
  - 14 個新測試涵蓋 Contract 所列 refresh（含非一般業數值比較）、合併、跨市場、尚未公布、台北跨年範圍、條件式重算與 numeric guard。
- `README.md:245-295`、`AGENTS.md:22-23`
  - 補上修訂 raw 規則、合併／差分語意、runner 用法與 launchd 安裝／移除範本說明。

## 2. 完整測試摘要

在 worktree `/Users/zhengweizhu/Projects/wfnt-snapshot-data-t302` 執行：

```text
$ node --test tests/
1..295
# tests 295
# suites 0
# pass 295
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11741.430142
```

其他靜態檢查：

```text
git diff --check                                      PASS
plutil -lint ops/launchd/com.wfnt.quarterly-refresh.plist  OK
node --check scripts/backfill-quarterly.mjs           PASS
node --check scripts/lib/derived.mjs                  PASS
node --check scripts/quarterly-refresh.mjs            PASS
```

## 3. 消融證據

每組只暫時改動 production code，執行單一新測試後立即用反向 patch 還原。

1. 修訂改成覆蓋主檔：把 `nextPath` 暫改為主檔 `path`。
   - `node --test --test-name-pattern="appends changed bytes" tests/quarterly-revisions.test.mjs`
   - 結果：0 pass / 1 fail；對應目前 `tests/quarterly-revisions.test.mjs:177` 的 assertion，偵測主檔 bytes 已被新版取代。
2. 合併改成只取最新版：暫時移除以 `mainRows` 初始化 merged map 的迴圈。
   - `node --test --test-name-pattern="revision merge adds" tests/quarterly-revisions.test.mjs`
   - 結果：0 pass / 1 fail；對應目前 `tests/quarterly-revisions.test.mjs:219` 的 assertion，實際代號只有 `2330,9999`，缺少只在舊版的 `1101`。
3. 拿掉跨市場前一季：暫時將 fallback 表達式改為只查 `previousById`。
   - `node --test --test-name-pattern="falls back" tests/quarterly-revisions.test.mjs`
   - 結果：0 pass / 1 fail；對應目前 `tests/quarterly-revisions.test.mjs:270` 的 assertion，EPS 筆數由預期 1 變成 0，並出現 `missingPrevious=1`。

三組全部還原後：

```text
$ node --test tests/quarterly-revisions.test.mjs
1..14
# tests 14
# pass 14
# fail 0
```

其後完整套件亦為 295/295 綠燈，證明消融改動均已還原。

## 4. 真實 raw 的暫存 root 演練

演練只讀以下四個真實 raw，複製到 `mkdtemp` 建立的 root：

```text
data/raw/twse/quarterly_fin_hist/2026/2026-Q1.html
data/raw/twse/quarterly_fin_hist/2026/2026-Q2.html
data/raw/tpex/quarterly_fin_hist/2026/2026-Q1.html
data/raw/tpex/quarterly_fin_hist/2026/2026-Q2.html
```

步驟與結果：

- 先在暫存 root 重算，確認上櫃 `4442` 有 Q1、沒有 Q2。
- 以暫存的真實 `2026-Q2.html` 為底，加入一列由真實 `4442` Q1 row 衍生的累計值，存成暫存 `2026-Q2.rev-2026-10-17.html`（1,316,770 bytes）。
- 再次於暫存 root 執行 `rebuildQuarterly`。
- `4442` 由 `targetBeforeQ2=false` 變成 `targetAfterQ2=[20262,27.15,9.93,8.51]`。
- 原有控制公司 `1101` 的完整 derived 檔在前後 `controlByteStable=true`。
- 重算摘要由 `{"seasons":2,"fundamentals":3921,"eps":3937}` 變成 `{"seasons":2,"fundamentals":3922,"eps":3938}`，只增加該晚申報列對應的 margin 與 EPS。
- 演練結束後刪除暫存 root；真實 `data/` 未寫入。

原始證據摘要：

```json
{"copied":["twse/Q1","twse/Q2","tpex/Q1","tpex/Q2"],"target":"4442","targetBeforeQ2":false,"targetAfterQ2":[20262,27.15,9.93,8.51],"controlId":"1101","controlByteStable":true,"beforeSummary":{"seasons":2,"fundamentals":3921,"eps":3937},"afterSummary":{"seasons":2,"fundamentals":3922,"eps":3938},"revisionBytes":1316770}
```
