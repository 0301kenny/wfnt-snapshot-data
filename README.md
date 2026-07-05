# wfnt-snapshot-data

TW Stock Radar 的每日官方開放資料快照服務(建置中)。

- 資料來源:TWSE OpenAPI、TPEX OpenAPI、TDCC 開放資料——全部為官方公開的**盤後**資料,本 repo 只做每日留存,不即時、不推播。
- 目前狀態:TICKET-010 連通性煙霧驗證階段(`scripts/probe.mjs` + `probe` workflow),尚未開始落地資料。
- 架構設計文件:見主專案 `docs/18-snapshot-service-architecture.md`。
- 歷史政策(預告):本 repo 的 git 歷史不是保存機制,權威留存 = 當前 working tree + GitHub Releases;允許年度 squash 重置歷史。
