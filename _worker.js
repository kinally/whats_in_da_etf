/**
 * Cloudflare Workers + Assets 入口
 * /api/query → ETF 成分股查询（自动识别上交所/深交所）
 * 其他路由 → 静态资源
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/query') {
      return handleQuery(url);
    }
    if (env.ASSETS && env.ASSETS.fetch) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  }
};

/* ========== 路由分派 ========== */
async function handleQuery(url) {
  const fundCode = (url.searchParams.get('code') || '').trim();
  if (!fundCode) {
    return jsonResponse({ ok: false, error: '缺少 code 参数' }, 400);
  }

  // 暂仅支持上交所 5 开头 ETF
  if (/^5\d{5}$/.test(fundCode)) {
    return querySSE(fundCode);
  }
  return jsonResponse({ ok: false, error: `暂仅支持上交所 5 开头的 ETF，不支持 ${fundCode}` }, 400);
}

/* ========== 上交所 (5xxxxx) ========== */
async function querySSE(fundCode) {
  const params = new URLSearchParams({
    sqlId: 'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C',
    FUNDID2: fundCode,
    jsonCallBack: 'cb',
    isPagination: 'false',
    'pageHelp.pageSize': '500',
  });
  const apiUrl = `https://query.sse.com.cn/commonQuery.do?${params}`;

  try {
    const resp = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://etf.sse.com.cn/',
      },
    });
    const text = await resp.text();
    let jsonStr = text;
    if (text.startsWith('cb(') && text.endsWith(')')) {
      jsonStr = text.slice(3, -1);
    }
    const data = JSON.parse(jsonStr);
    const rows = data.result || [];

    const MARKET_MAP = { '101': '上交所', '102': '深交所', '9999': '境外' };
    const FLAG_MAP = { '0': '不允许替代', '1': '允许现金替代', '2': '必须现金替代' };
    const enriched = rows.map(r => ({
      INSTRUMENT_ID: r.INSTRUMENT_ID,
      INSTRUMENT_NAME: r.INSTRUMENT_NAME,
      QUANTITY: r.QUANTITY,
      SUBSTITUTION_CASH_AMOUNT: (r.SUBSTITUTION_CASH_AMOUNT || '').trim(),
      SUBSTITUTION_FLAG: r.SUBSTITUTION_FLAG || '',
      _MARKET_CN: MARKET_MAP[r.UNDERLYION_SECURITY_ID] || '其他',
      _FLAG_CN: FLAG_MAP[r.SUBSTITUTION_FLAG] || r.SUBSTITUTION_FLAG || '',
    }));

    return jsonResponse({ ok: true, etfName: '', rows: enriched, count: enriched.length });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 502);
  }
}

/* ========== JSON 响应工具 ========== */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
  });
}
