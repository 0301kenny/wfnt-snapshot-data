READY_FOR_REVIEW

# TICKET-298 r1 Executor Report

## 1. 改動位置

- `scripts/lib/derived.mjs` — 僅修改 `parseTwseWeightedIndexHist`：優先找 `發行量加權股價指數`，找不到才 fallback 到官方舊名 `加權股價指數`；空表與其他行為維持不變。
- `tests/twse-weighted-index.test.mjs` — 新增三個使用暫存 root 的手寫 fixture 測試，分別涵蓋舊名、兩名稱並存時的新名優先、空表回 `null`。
- `tests/twse-weighted-index.test.mjs` — 僅調整既有 `merged TWSE weighted index raw dates match the margin date oracle` 測試的候選日期：限制於 `twse.margin.rows` 最小到最大日期（含端點）；雙向零差集、`>= 1253` 下限與 `20210719 = 17789.25` 斷言均保留。

## 2. 完整驗收摘要

工作目錄：`/Users/zhengweizhu/Projects/wfnt-snapshot-data-t298`

命令：`node --test tests/`

```text
1..239
# tests 239
# suites 0
# pass 239
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10031.423775
```

真實資料一致性測試 diagnostics：

```text
merged rows=1276
only in index=0; only in margin=0
20210719=17789.25
```

## 3. 消融證據

### 3.1 拿掉舊名 fallback

暫時移除 `?? table.data.find(... === '加權股價指數')`，只執行新增的舊名測試：

```text
not ok 1 - historical weighted index parser accepts the legacy official name
error: |-
  Expected values to be strictly equal:

  null !== 9876.54
# tests 1
# pass 0
# fail 1
```

還原 fallback 後以相同 test-name pattern 重跑：

```text
ok 1 - historical weighted index parser accepts the legacy official name
# tests 1
# pass 1
# fail 0
```

### 3.2 拿掉日期範圍限制

暫時讓候選日期恢復為所有 daily 與 historical raw 日期，執行真實資料一致性測試：

```text
not ok 1 - merged TWSE weighted index raw dates match the margin date oracle
error: |-
  Expected values to be strictly equal:

  2050 !== 1276
merged rows=2050
only in index=774; only in margin=0
20210719=17789.25
# tests 1
# pass 0
# fail 1
```

還原日期範圍限制後以相同 test-name pattern 重跑：

```text
ok 1 - merged TWSE weighted index raw dates match the margin date oracle
merged rows=1276
only in index=0; only in margin=0
20210719=17789.25
# tests 1
# pass 1
# fail 0
```

兩組消融完成後再執行完整驗收，結果為 239/239 全綠。未連網、未執行任何會寫入真實 `data/` 的腳本，也未在主目錄操作。
