READY_FOR_REVIEW

# TICKET-296 r1 Executor Report

## 1. 實作位置

- 上市 OpenAPI 殖利率規則函式：`scripts/lib/derived.mjs:165` 的 `compactTwseDividendYield`；每日估值寫入點在 `scripts/lib/derived.mjs:1647` 呼叫此函式，僅 `market === 'twse'` 使用。
- 離線修補函式：`scripts/lib/derived.mjs:786` 的 `repairTwseDividendYield`。它只以 `data/raw/twse/bwibbu_all/**` 的空字串殖利率為候選，並只修改 TWSE fundamentals 同日同股且 `dy === null` 的格子；寫入沿用 `writeDerivedJson`／`stableDerivedString`。
- CLI：`scripts/repair-twse-dividend-yield.mjs`，用法為 `node scripts/repair-twse-dividend-yield.mjs [--out <root>]`；未指定 `--out` 時使用目前目錄，未知參數以非 0 結束。

## 2. 完整測試

還原所有消融後執行：

```text
$ node --test tests/
1..217
# tests 217
# suites 0
# pass 217
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8922.899564
```

## 3. 消融證據

三組消融都只暫時修改 `scripts/lib/derived.mjs`，取得紅燈後立即還原；最後再跑完整測試，結果見上一節的 217／217。

### A1：每日路徑改回 `compactNumber`

暫時把 TWSE 每日估值的殖利率寫入改回 `compactNumber(row.DividendYield)`，執行新每日路徑測試：

```text
$ node --test --test-name-pattern="TWSE OpenAPI blank dividend yields" tests/run.test.mjs
not ok 1 - TWSE OpenAPI blank dividend yields become zero in incremental and rebuilt fundamentals
expected dy: 0
actual dy: null
1..1
# tests 1
# pass 0
# fail 1
```

### A2：修補不看原始檔，一律把 derived 的 `dy === null` 改成 0

暫時讓修補函式列舉全部 fundamentals 並修改所有 null 殖利率，執行修補測試：

```text
$ node --test tests/twse-dividend-yield-repair.test.mjs
not ok 2 - repair leaves unsupported nulls, PE nulls, and dates absent from blank raw unchanged
expected: { files: 0, cells: 0 }
actual:   { files: 2, cells: 2 }
1..3
# tests 3
# pass 2
# fail 1
```

### A3：規則只認 `''`，不認全空白

暫時把規則改成只在 `value === ''` 時回傳 0，執行新每日路徑測試：

```text
$ node --test --test-name-pattern="TWSE OpenAPI blank dividend yields" tests/run.test.mjs
not ok 1 - TWSE OpenAPI blank dividend yields become zero in incremental and rebuilt fundamentals
expected whitespace DividendYield dy: 0
actual dy: null
1..1
# tests 1
# pass 0
# fail 1
```

## 4. 真實資料唯讀複本演練

只從真實 `data/raw/twse/bwibbu_all` 與 `data/derived/fundamentals` 複製到暫存 root `/tmp/wfnt-ticket-296.5St5jL`；CLI 的兩次寫入都只發生在此暫存 root。stdout 原文：

```text
$ node scripts/repair-twse-dividend-yield.mjs --out /tmp/wfnt-ticket-296.5St5jL
files=237 cells=5153
$ node scripts/repair-twse-dividend-yield.mjs --out /tmp/wfnt-ticket-296.5St5jL
files=0 cells=0
```

真實 `data/` 未執行修補、`run.mjs` 或 `build-derived.mjs`，也未被修改。
