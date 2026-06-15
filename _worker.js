/**
 * Cloudflare Workers + Assets 入口
 * 处理 /api/query 代理上交所 ETF 成分股接口
 * 其他路由由静态资源引擎自动处理
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ======== API 路由 ========
    if (url.pathname === '/api/query') {
      return handleQuery(url);
    }

    // ======== 静态资源 ========
    if (typeof env.ASSETS !== 'undefined' && env.ASSETS.fetch) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleQuery(url) {
  const fundCode = url.searchParams.get('code') || '513310';

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

    return new Response(JSON.stringify({ ok: true, rows, count: rows.length }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
