# REPORT-205

## 結論

- 狀態: **READY_FOR_REVIEW**。
- 完成/未完成: 票面 Scope 與驗收 1～5 全部完成；未觸發 Stop/Escalate，未 commit。
- 分支/HEAD: `ticket-205` / `c2145409eefda9ee6cac9087bb154dec6fa71f7d`。
- 真實網路: 僅驗收 2 的六支目標端點各請求一次，共 6 次；全部 HTTP 200、非空，未重試。
- 隔離目錄: `/var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-205-network-Om3NA4`。
- 真 `data/` 零寫入；未在 repo 根目錄執行 `build-derived`；未修改 WFNT_app；未修改既有歷史 report。

## 實作摘要

- `scripts/endpoints.mjs`: 僅在 `ENDPOINTS` 新增六支 current-snapshot 端點；未修改 `BACKFILL_ENDPOINTS` 或 `run.mjs`。
- 月頻 `twse_insider_holding` / `tpex_insider_holding` 沿用既有 monthly 形狀，不設 `dateField`；四支日頻端點分別使用該市場實打的 `出表日期` / `Date`。
- `tests/run.test.mjs`: 補六份市場專屬 fixture body、六個 URL mapping；將首跑測試名稱由 eleven 更新為 seventeen；保留 `deepEqual` 完全相等語意並在精確順序清單加入六個 key。
- `tests/backfill.test.mjs`: 將測試名稱改為 `17-entry snapshot endpoint list`，並將 `assert.equal(ENDPOINTS.length, 11)` 精確更新為 `assert.equal(ENDPOINTS.length, 17)`；未改成範圍或子集斷言。
- `README.md`: 日更/月更數量更新為 12/4，補上六支 current-only 資料集及零 backfill、零 derived 說明。

## 六支最終端點契約

```text
key=twse_insider_holding
sourceDataset=twse/insider_holding
cadence=monthly
requiredFields=["資料年月","公司代號","選任時持股 ","設質股數"]

key=tpex_insider_holding
sourceDataset=tpex/insider_holding
cadence=monthly
requiredFields=["資料年月","公司代號","選任時持股","設質股數"]

key=twse_insider_transfer
sourceDataset=twse/insider_transfer
cadence=daily
requiredFields=["出表日期","公司代號","申報人身分","預定轉讓方式及股數-轉讓股數"]

key=tpex_insider_transfer
sourceDataset=tpex/insider_transfer
cadence=daily
requiredFields=["Date","SecuritiesCompanyCode","申請人身分","預定轉讓方式及股數-轉讓股數"]

key=twse_company_capital
sourceDataset=twse/company_capital
cadence=daily
requiredFields=["出表日期","公司代號","實收資本額","已發行普通股數或TDR原股發行股數"]

key=tpex_company_capital
sourceDataset=tpex/company_capital
cadence=daily
requiredFields=["Date","SecuritiesCompanyCode","Paidin.Capital.NTDollars","IssueShares"]
```

## 驗收結果

### 1. `node --test tests/` 全綠且總數 >= 90 — PASS

```text
1..90
# tests 90
# suites 0
# pass 90
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3604.216991
```

沒有刪除、skip、放寬 assertion 或吞錯。HF5 的 `deepEqual` 與 `assert.equal` 都保留精確語意。

### 2. 六支真實網路取數與隔離 raw — PASS

呼叫 `runSnapshot({ rootDir, fetcher, datasets, now })`；`rootDir` 是上述隔離 tmpdir。為遵守票面共 6 次真實請求，注入 fetcher 對兩個既有市場 anchor 回傳固定假資料，只將六支目標 URL 各一次委派給原生 `globalThis.fetch`。結果 `networkRequests=6`、`exitCode=0`。

```text
twse_insider_holding
  HTTP=200 rows=27528
  /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-205-network-Om3NA4/data/raw/twse/insider_holding/2026/2026-07.json
  bytes=10375320 responseBytes=10375320 preserved=true

tpex_insider_holding
  HTTP=200 rows=17517
  /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-205-network-Om3NA4/data/raw/tpex/insider_holding/2026/2026-07.json
  bytes=6597882 responseBytes=6597882 preserved=true

twse_insider_transfer
  HTTP=200 rows=3
  /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-205-network-Om3NA4/data/raw/twse/insider_transfer/2026/2026-09-04.json
  bytes=2154 responseBytes=2154 preserved=true

tpex_insider_transfer
  HTTP=200 rows=2
  /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-205-network-Om3NA4/data/raw/tpex/insider_transfer/2026/2026-09-04.json
  bytes=1414 responseBytes=1414 preserved=true

twse_company_capital
  HTTP=200 rows=1094
  /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-205-network-Om3NA4/data/raw/twse/company_capital/2026/2026-09-04.json
  bytes=1326265 responseBytes=1326265 preserved=true

tpex_company_capital
  HTTP=200 rows=890
  /var/folders/t2/w9vv7vcs3b3808y8k70bkpp80000gn/T/wfnt-ticket-205-network-Om3NA4/data/raw/tpex/company_capital/2026/2026-09-04.json
  bytes=1070807 responseBytes=1070807 preserved=true
```

六支列數與 JSON array 結構均符合 HF2/HF3 的量級及形狀，raw 檔 bytes 均與官方 response body 完全相等。

### 3. `requiredFields` 與該市場實打 key 逐字相符 — PASS

以下每個 `matched` 都由同一次真實 HTTP 200 回應的第一列 `Object.keys` 逐字比對取得，且逐一包含 production `requiredFields` 的全部欄位：

```text
twse_insider_holding
  matched=["資料年月","公司代號","選任時持股 ","設質股數"]
tpex_insider_holding
  matched=["資料年月","公司代號","選任時持股","設質股數"]
twse_insider_transfer
  matched=["出表日期","公司代號","申報人身分","預定轉讓方式及股數-轉讓股數"]
tpex_insider_transfer
  matched=["Date","SecuritiesCompanyCode","申請人身分","預定轉讓方式及股數-轉讓股數"]
twse_company_capital
  matched=["出表日期","公司代號","實收資本額","已發行普通股數或TDR原股發行股數"]
tpex_company_capital
  matched=["Date","SecuritiesCompanyCode","Paidin.Capital.NTDollars","IssueShares"]
```

特別核對：

- TWSE `t187ap11_L` 實打 key 是 `"選任時持股 "`，右引號前保留一個半形尾空白；TPEX 是無尾空白的 `"選任時持股"`。
- TWSE `t187ap12_L` 實打是 `"申報人身分"`；TPEX `t187ap12_O` 實打是 `"申請人身分"`。
- TPEX `t187ap03_O` 的實打 key 同時含 `SecuritiesCompanyCode` 與 `Symbol`；production 必填及代號欄選用 `SecuritiesCompanyCode`，沒有誤用英文簡稱欄 `Symbol`。
- 兩支月頻端點均未以 5 碼 `資料年月` 設 `dateField`；實跑成功解析為 `2026-07`。

### 4. 跨市場錯欄名負向對照 — PASS

選用 `tpex_insider_transfer`，假 fetch 回應保留正確 TPEX key `申請人身分`，但把驗證端點的 `requiredFields` 暫換為 TWSE 的 `申報人身分`。原始輸出：

```text
[fail] tpex_insider_transfer: schema: 缺少欄位 申報人身分
TICKET205_NEGATIVE_REQUIRED_FIELDS=["Date","SecuritiesCompanyCode","申報人身分","預定轉讓方式及股數-轉讓股數"]
TICKET205_NEGATIVE_ROW_KEYS=["Date","SecuritiesCompanyCode","申請人身分","預定轉讓方式及股數-轉讓股數"]
TICKET205_NEGATIVE_ERROR=schema: 缺少欄位 申報人身分
TICKET205_NEGATIVE_OK=false
```

錯誤訊息原文：`schema: 缺少欄位 申報人身分`。

### 5. `run.mjs` 非 monthly 完整性判定實跑 — PASS

以假 fetch 在隔離 tmpdir 選取全部 market-local 非 monthly 端點實跑；新增四支日頻端點已進入分母。原始結果：

```text
TICKET205_COMPLETENESS_DAILY_ENDPOINTS=12
TICKET205_COMPLETENESS_RESULTS=12
TICKET205_COMPLETENESS_EXIT_CODE=0
TICKET205_COMPLETENESS_COMMIT_MESSAGE=snapshot: 2026-09-04 [twse 6/6, tpex 6/6]
```

真實網路六支 subset 實跑則輸出：

```text
snapshot: 2026-09-04 [twse:insider_transfer,tpex:insider_transfer,twse:company_capital,tpex:company_capital]
```

因此完整 12/12 時走兩市場完整摘要，只有本票四支日頻 subset 時走逐 endpoint 摘要；判定行為符合預期。

## 測試檔逐項變更與理由

### `tests/run.test.mjs`

1. `fixtureBodies()` 新增六支 response body，使用各市場自己的欄名，讓所有既有全端點 run case 能通過 schema/date/month 驗證。
2. `urls` 新增六支 URL-to-key mapping，讓既有嚴格 `unexpected URL` fake fetcher 能精確辨識所有新增請求。
3. 首跑測試名稱把 `eleven datasets` 改為 `seventeen datasets`，避免名稱與實際契約矛盾。
4. manifest key 的 `assert.deepEqual` 精確順序清單加入四支日頻與兩支月頻 key；未退化成 `includes` 或子集斷言。

### `tests/backfill.test.mjs`

1. 測試名稱由 `unchanged daily endpoint list` 改為 `17-entry snapshot endpoint list`，正確描述目前 registry。
2. `assert.equal(ENDPOINTS.length, 11)` 更新為 `assert.equal(ENDPOINTS.length, 17)`；保持嚴格相等，確保未來新增 snapshot endpoint 仍會顯式觸發審查。

沒有發現其他以端點全集為基準且需更新的斷言。

## 票面建議修正

驗收 2 同時寫「`fetcher: <真實 fetch>`」與「共 6 次請求」，但選取四支 market-local daily endpoint 時，現有 `runSnapshot` 必定另向兩個 anchor URL 呼叫注入的 fetcher；若直接傳 `globalThis.fetch`，真實請求總數會是 8。此次依「共 6 次真實請求」的明確上限，使用 wrapper 對 anchor 回固定假資料、僅六支目標 URL 委派真實 fetch。建議後續 revision 明寫「六支目標端點須真實 fetch；兩個 anchor 可由 fixture 回應」，消除歧義。

## 收工檢查

- `git diff --check`: 無輸出。
- `git status --short -- data`: 無輸出。
- 工作樹只留下 Scope 內的 `README.md`、`scripts/endpoints.mjs`、`tests/run.test.mjs`、`tests/backfill.test.mjs` 與本檔 `REPORT-205.md`，另保留原有歷史 report；未 commit。
