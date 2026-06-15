/**
 * Cloudflare Pages Function
 * 代理上交所 ETF 成分股查询接口，解决浏览器跨域问题
 *
 * 部署路径: /api/query?code=513310
 */
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const fundCode = url.searchParams.get("code") || "513310";

  // 拼装上交所接口参数
  const params = new URLSearchParams({
    sqlId: "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C",
    FUNDID2: fundCode,
    jsonCallBack: "cb",
    isPagination: "false",
    "pageHelp.pageSize": "500",
  });
  const apiUrl = `https://query.sse.com.cn/commonQuery.do?${params}`;

  try {
    const resp = await fetch(apiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://etf.sse.com.cn/",
      },
    });

    // 上交所返回的是 JSONP: cb({...})
    const text = await resp.text();
    let jsonStr = text;
    if (text.startsWith("cb(") && text.endsWith(")")) {
      jsonStr = text.slice(3, -1);
    }
    const data = JSON.parse(jsonStr);
    const rows = data.result || [];

    return new Response(
      JSON.stringify({ ok: true, rows, count: rows.length }),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}
