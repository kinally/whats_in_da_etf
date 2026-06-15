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

  // 根据代码前缀判断市场
  if (/^5\d{5}$/.test(fundCode)) {
    return querySSE(fundCode);
  }
  if (/^1[5-6]\d{4}$/.test(fundCode)) {
    return querySZSE(fundCode);
  }
  return jsonResponse({ ok: false, error: `不支持的基金代码格式: ${fundCode}` }, 400);
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

/* ========== 深交所 (15xxxx / 16xxxx) ========== */
async function querySZSE(fundCode) {
  const today = new Date();
  // 调整为北京时间
  const cn = new Date(today.getTime() + 8 * 60 * 60 * 1000);
  const ymd = cn.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://reportdocs.static.szse.cn/files/text/etf/ETF${fundCode}${ymd}.txt`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://www.szse.cn/',
      },
    });
    if (!resp.ok) {
      return jsonResponse({ ok: false, error: `深交所暂无 ${fundCode} 今日数据文件 (HTTP ${resp.status})` }, 502);
    }

    // 获取原始字节，尝试 GBK 解码（深交所文件为 GBK 编码）
    let text;
    try {
      const buf = await resp.arrayBuffer();
      text = new TextDecoder('gbk').decode(buf);
    } catch (_) {
      // TextDecoder 不支持 gbk 时，回退到默认 UTF-8
      const buf = await resp.arrayBuffer();
      text = new TextDecoder('utf-8').decode(buf);
    }

    const rows = parseSZSEText(text, fundCode);

    return jsonResponse({
      ok: true,
      etfName: rows._etfName || '',
      rows: rows._components || [],
      count: (rows._components || []).length,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: `深交所查询失败: ${err.message}` }, 502);
  }
}

/* ========== 解析深交所 TSV 文本 ========== */
function parseSZSEText(text, fundCode) {
  const lines = text.split(/\r?\n/);
  let etfName = '';

  // 第 1 行找基金名称（可能被空格包围）
  if (lines[0]) {
    const match = lines[0].match(/([^\s]+ETF)/);
    if (match) etfName = match[1];
  }

  // 找表头行和表格数据
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('证券代码') && lines[i].includes('证券名称')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { _etfName: etfName, _components: [] };

  // 解析表头列
  const cols = lines[headerIdx].split(/\t/).map(c => c.trim());

  const colMap = {};
  cols.forEach((c, idx) => {
    if (c.includes('证券代码')) colMap.code = idx;
    if (c.includes('证券名称')) colMap.name = idx;
    if (c.includes('股份数量')) colMap.qty = idx;
    if (c.includes('现金替代标志')) colMap.flag = idx;
    if (c.includes('申购现金替代保证金')) colMap.createRate = idx;
    if (c.includes('赎回现金替代保证金')) colMap.redeemRate = idx;
    if (c.includes('申购溢价')) colMap.premium = idx;
    if (c.includes('赎回折价')) colMap.discount = idx;
    if (c.includes('买卖市场')) colMap.market = idx;
  });

  const MARKET_MAP = { '深圳市场': '深交所', '上海市场': '上交所', '北京市场': '北交所' };
  const FLAG_MAP = { '允许': '允许现金替代', '必须': '必须现金替代', '禁止': '不允许替代' };

  const components = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('--') || line.startsWith('免责') || line.startsWith('注')) continue;

    const parts = line.split(/\t/).map(p => p.trim());
    if (parts.length < 3) continue;

    const code = parts[colMap.code] || '';
    const name = parts[colMap.name] || '';
    if (!code || !name) continue;

    // 现金替代标志映射
    const rawFlag = parts[colMap.flag] || '';
    let flag = rawFlag;
    let flagCn = '';
    for (const [k, v] of Object.entries(FLAG_MAP)) {
      if (rawFlag.includes(k)) { flagCn = v; break; }
    }

    // 买卖市场映射
    const rawMarket = parts[colMap.market] || '';
    let marketCn = '';
    for (const [k, v] of Object.entries(MARKET_MAP)) {
      if (rawMarket.includes(k)) { marketCn = v; break; }
    }
    if (!marketCn) {
      // 根据代码前缀推断市场
      if (/^6/.test(code) || /^5/.test(code)) marketCn = '上交所';
      else if (/^0/.test(code) || /^3/.test(code) || /^2/.test(code)) marketCn = '深交所';
      else marketCn = '其他';
    }

    components.push({
      INSTRUMENT_ID: code,
      INSTRUMENT_NAME: name,
      QUANTITY: parts[colMap.qty] || '0',
      SUBSTITUTION_CASH_AMOUNT: '',  // 深交所不提供替代金额
      SUBSTITUTION_FLAG: rawFlag,
      _MARKET_CN: marketCn,
      _FLAG_CN: flagCn,
      CREATION_PREMIUM_RATE: colMap.premium !== undefined ? (parts[colMap.premium] || '') : '',
      REDEMPTION_DISCOUNT_RATE: colMap.discount !== undefined ? (parts[colMap.discount] || '') : '',
    });
  }

  return { _etfName: etfName, _components: components };
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
