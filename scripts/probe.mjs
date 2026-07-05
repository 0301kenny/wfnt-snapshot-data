// TICKET-010 連通性煙霧驗證:只探測、不落地資料。
// 驗證 GitHub Actions runner 能否直接抓 8 個官方開放資料端點(runner datacenter IP 是否被擋)。
// 任一端點失敗時 exit 1,讓 run 狀態直接反映 GO/NO-GO。

const ENDPOINTS = [
  { id: 'twse_mi_index',       kind: 'json', timeoutMs: 60_000,  url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX' },
  { id: 'twse_stock_day_all',  kind: 'json', timeoutMs: 60_000,  url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL' },
  { id: 'twse_mi_margn',       kind: 'json', timeoutMs: 60_000,  url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN' },
  { id: 'tpex_index',          kind: 'json', timeoutMs: 60_000,  url: 'https://www.tpex.org.tw/openapi/v1/tpex_index' },
  { id: 'tpex_mainboard_close', kind: 'json', timeoutMs: 60_000, url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes' },
  { id: 'tpex_3insti',         kind: 'json', timeoutMs: 60_000,  url: 'https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading' },
  { id: 'tpex_margin',         kind: 'json', timeoutMs: 60_000,  url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance' },
  { id: 'tdcc_holder_dist',    kind: 'csv',  timeoutMs: 300_000, url: 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5' },
];

async function probe(endpoint) {
  const startedAt = Date.now();
  const response = await fetch(endpoint.url, {
    signal: AbortSignal.timeout(endpoint.timeoutMs),
    headers: {
      accept: endpoint.kind === 'json' ? 'application/json' : 'text/csv,text/plain,*/*',
      'user-agent': 'wfnt-snapshot-probe/0.1 (+https://github.com/0301kenny/wfnt-snapshot-data)',
    },
  });
  const body = await response.text();
  const durationMs = Date.now() - startedAt;
  const bytes = Buffer.byteLength(body);
  const contentType = response.headers.get('content-type') ?? '(none)';

  let verdict = 'FAIL';
  let detail = '';
  if (!response.ok) {
    detail = `HTTP ${response.status}`;
  } else if (endpoint.kind === 'json') {
    try {
      const rows = JSON.parse(body);
      if (Array.isArray(rows) && rows.length > 0) {
        verdict = 'OK';
        detail = `rows=${rows.length} firstRowKeys=[${Object.keys(rows[0]).slice(0, 8).join(',')}]`;
      } else {
        detail = `JSON 可解析但非非空陣列(type=${Array.isArray(rows) ? 'empty array' : typeof rows})`;
      }
    } catch {
      detail = `HTTP 200 但非合法 JSON,開頭: ${body.slice(0, 120).replaceAll('\n', ' ')}`;
    }
  } else {
    const firstLines = body.split('\n').slice(0, 2).map((line) => line.slice(0, 100));
    if (body.includes('資料日期')) {
      verdict = 'OK';
      detail = `firstLines=${JSON.stringify(firstLines)}`;
    } else {
      detail = `HTTP 200 但無「資料日期」欄,開頭: ${firstLines.join(' | ')}`;
    }
  }
  return { id: endpoint.id, verdict, status: response.status, bytes, durationMs, contentType, detail };
}

const results = [];
for (const endpoint of ENDPOINTS) {
  try {
    results.push(await probe(endpoint));
  } catch (error) {
    results.push({ id: endpoint.id, verdict: 'FAIL', status: '-', bytes: 0, durationMs: 0, contentType: '-', detail: `${error.name}: ${error.message}` });
  }
}

console.log(`\nprobe @ ${new Date().toISOString()}\n`);
for (const r of results) {
  console.log(`[${r.verdict}] ${r.id.padEnd(22)} status=${r.status} bytes=${r.bytes} ${r.durationMs}ms ct=${r.contentType}`);
  console.log(`       ${r.detail}\n`);
}
const failed = results.filter((r) => r.verdict !== 'OK');
console.log(`結果:${results.length - failed.length}/${results.length} OK${failed.length ? `,失敗:${failed.map((r) => r.id).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
