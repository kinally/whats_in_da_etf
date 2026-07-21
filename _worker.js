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

  // 🔒 严格校验：只接受纯数字的上交所 ETF 代码（5/6位）
  // 拒绝任何非纯数字输入（如"中证500"、"513310abc"等），防止 API 被误请求封禁
  if (!fundCode) {
    return jsonResponse({ ok: false, error: '缺少 code 参数' }, 400);
  }
  if (!/^\d{5,6}$/.test(fundCode)) {
    return jsonResponse({ ok: false, error: `无效的 ETF 代码格式: ${fundCode}，仅支持纯数字代码` }, 400);
  }

  // 上交所 5 开头 ETF
  if (/^5\d{5}$/.test(fundCode)) {
    return querySSE(fundCode);
  }
  // 深交所 15xxxx / 16xxxx ETF
  if (/^1[5-6]\d{4}$/.test(fundCode)) {
    return querySZSE(fundCode);
  }
  return jsonResponse({ ok: false, error: `暂仅支持上交所 5 开头和深交所 15/16 开头的 ETF，不支持 ${fundCode}` }, 400);
}

/* ========== 上交所 (5xxxxx) ========== */
async function querySSE(fundCode) {
  // 并行请求：成分股 + 申购清单基本信息
  const [compResult, sgResult] = await Promise.allSettled([
    fetchComponents(fundCode),
    fetchSgInfo(fundCode),
  ]);

  // 成分股数据是必须的
  if (compResult.status === 'rejected') {
    return jsonResponse({ ok: false, error: compResult.reason.message }, 502);
  }
  const { rows, enriched, computedCount } = compResult.value;

  // 检查是否有申购赎回清单数据
  if (!rows || rows.length === 0) {
    return jsonResponse({
      ok: true,
      etfName: '',
      listDate: null,
      etfPrice: null,
      rows: [],
      count: 0,
      noPcf: true,  // 标识：该基金不提供申购赎回清单
    });
  }

  // 从 sgInfo 获取交易日信息（可选）
  const listDate = sgResult.status === 'fulfilled' && sgResult.value?.tradingDay
    ? sgResult.value.tradingDay : null;

  // ── 主方案：SSE yunhq snap ──
  // 同时拿 ETF 自身行情（名称/价格参考）和成分股的昨收价
  let etfSnap = null;
  let etfName = '';
  let etfPrice = null;

  try {
    etfSnap = await fetchSnapQuote(fundCode);
    if (etfSnap) {
      etfName = etfSnap.fundName || '';
      etfPrice = {
        snapDate: etfSnap.date,  // yunhq 自带的日期 YYYYMMDD
        last: etfSnap.last,
        prevClose: etfSnap.prevClose,
        iopv: etfSnap.iopv,
        chgRate: etfSnap.chgRate,
        open: etfSnap.open,
      };
    }
  } catch (_) { /* snap 非必须，失败不阻塞 */ }

  // 如果 snap 没拿到名称，降级到东财 suggest
  if (!etfName) {
    try {
      const q = await fetchQuote(fundCode);
      etfName = q.name || '';
    } catch (_) {}
  }

  // ── 补算缺失的替代金额 ──
  if (computedCount > 0) {
    const needPrice = enriched.filter(r => {
      const qty = parseInt(r.QUANTITY, 10);
      return qty > 0 && (!r.SUBSTITUTION_CASH_AMOUNT || r.SUBSTITUTION_CASH_AMOUNT === '-' || r.SUBSTITUTION_CASH_AMOUNT === '');
    });

    if (needPrice.length > 0) {
      const priceMap = await computeMissingPrices(needPrice, listDate);

      enriched.forEach(r => {
        const qty = parseInt(r.QUANTITY, 10);
        if (qty > 0 && (!r.SUBSTITUTION_CASH_AMOUNT || r.SUBSTITUTION_CASH_AMOUNT === '-' || r.SUBSTITUTION_CASH_AMOUNT === '')) {
          const price = priceMap[r.INSTRUMENT_ID];
          if (price != null) {
            r.SUBSTITUTION_CASH_AMOUNT = (price * qty).toFixed(2);
            r._AMOUNT_SOURCE = priceMap._source === 'eastmoney' ? 'calc_em' : 'calc';
          }
        }
      });
    }
  }

  return jsonResponse({
    ok: true,
    etfName,
    listDate,
    etfPrice,      // 新增：ETF 价格参考
    rows: enriched,
    count: enriched.length,
  });
}

/* ========== 深交所 (15xxxx/16xxxx) ========== */

async function querySZSE(fundCode) {
  // 1. 向后回退查找最近交易日的 PCF 文件
  const pcfData = await findLatestSZSE(fundCode);
  if (!pcfData) {
    return jsonResponse({
      ok: true, noPcf: true, etfName: '', listDate: null,
      etfPrice: null, rows: [], count: 0,
    });
  }

  // 2. 解析成分股列表
  const { rows, enriched, listDate } = parsePCF(pcfData.text, pcfData.date);

  if (!rows || rows.length === 0) {
    return jsonResponse({
      ok: true, noPcf: true, etfName: '', listDate: null,
      etfPrice: null, rows: [], count: 0,
    });
  }

  // 3. 获取 ETF 名称（东财 suggest）
  let etfName = '';
  try {
    const q = await fetchQuote(fundCode);
    etfName = q.name || '';
  } catch (_) {}

  // 3b. 获取 ETF 行情（东财 push2 实时行情）
  let etfPrice = null;
  try {
    const q = await fetchSZSEQuote(fundCode);
    if (q) {
      etfPrice = {
        last: q.last,
        prevClose: q.prevClose,
        iopv: q.iopv,
        chgRate: q.chgRate,
        open: q.open,
      };
    }
  } catch (_) {}

  // 4. 补算缺失的替代金额
  //    公式：替代金额 = 股份数量 × 昨收价 × (1 + 申购现金替代保证金率)
  //    内地票（深圳市场/上海市场）→ 东财 K-line
  //    境外票（其他市场/香港市场）→ Yahoo Finance 主 + investing.com 备选
  const needPrice = enriched.filter(r => {
    const qty = parseInt(r.QUANTITY, 10);
    return qty > 0 && r._AMOUNT_SOURCE === 'missing';
  });

  if (needPrice.length > 0) {
    // 按市场分组
    const domesticNeed = needPrice.filter(r => r._MARKET_CN === '深圳市场' || r._MARKET_CN === '上海市场');
    const foreignNeed = needPrice.filter(r => r._MARKET_CN === '其他市场' || r._MARKET_CN === '香港市场');

    // 内地票：复用现有补算逻辑查昨收价（东财 K-line 支持沪深两市）
    if (domesticNeed.length > 0) {
      const priceMap = await computeMissingPrices(domesticNeed, listDate);
      domesticNeed.forEach(r => {
        const price = priceMap[r.INSTRUMENT_ID];
        if (price != null) {
          const qty = parseInt(r.QUANTITY, 10);
          const marginRate = parseFloat(r._MARGIN_RATE) / 100 || 0;
          const amount = price * qty * (1 + marginRate);
          r.SUBSTITUTION_CASH_AMOUNT = amount.toFixed(2);
          r._AMOUNT_SOURCE = 'calc';
        }
      });
    }

    // 境外票：Yahoo Finance → investing.com 降级
    if (foreignNeed.length > 0) {
      // 按市场分组，同一个市场用同一个汇率
      const marketGroups = {};
      foreignNeed.forEach(r => {
        const mkt = r._MARKET_CN || '其他市场';
        if (!marketGroups[mkt]) marketGroups[mkt] = [];
        marketGroups[mkt].push(r);
      });

      // 逐市场处理：先查汇率，再查价格
      for (const [market, stocks] of Object.entries(marketGroups)) {
        const currency = MARKET_CURRENCY[market] || 'USD';
        const rate = await fetchExchangeRate(currency);
        if (rate == null) continue; // 汇率查不到则跳过该市场所有股票

        const foreignResults = await asyncPool(stocks, 3, async r => {
          let price = await fetchForeignPrice(r.INSTRUMENT_ID);
          if (price == null) {
            price = await fetchInvestingPrice(r.INSTRUMENT_ID, r.INSTRUMENT_NAME);
          }
          return { id: r.INSTRUMENT_ID, price };
        });

        foreignResults.forEach(pr => {
          if (pr.status === 'fulfilled' && pr.value.price != null) {
            const r = foreignNeed.find(x => x.INSTRUMENT_ID === pr.value.id);
            if (r) {
              const qty = parseInt(r.QUANTITY, 10);
              const marginRate = parseFloat(r._MARGIN_RATE) / 100 || 0;
              // 价格 × 汇率 → 人民币
              const amount = pr.value.price * rate * qty * (1 + marginRate);
              r.SUBSTITUTION_CASH_AMOUNT = amount.toFixed(2);
              r._AMOUNT_SOURCE = 'calc';
            }
          }
        });
      }
    }
  }

  return jsonResponse({
    ok: true, etfName, listDate,
    etfPrice: etfPrice || null,
    rows: enriched,
    count: enriched.length,
  });
}

/* ---------- 深交所 ETF 行情（东财 push2 实时） ---------- */
async function fetchSZSEQuote(fundCode) {
  try {
    // 深交所基金 market=0
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=0.${fundCode}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f170,f171`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const d = data?.data;
    if (!d || d.f43 == null) return null;

    return {
      last: parseFloat(d.f43),
      chgRate: parseFloat(d.f170 ?? d.f48 ?? 0),
      change: parseFloat(d.f171 ?? d.f47 ?? 0),
      prevClose: parseFloat(d.f60 ?? 0),
      open: parseFloat(d.f46 ?? 0),
      high: parseFloat(d.f44 ?? 0),
      low: parseFloat(d.f45 ?? 0),
      // 东财没有 IOPV 字段，留空
      iopv: null,
      fundName: d.f58 || '',
    };
  } catch (_) {
    return null;
  }
}

/* ---------- 回溯查找最近交易日 PCF 文件 ---------- */
async function findLatestSZSE(code, maxDaysBack = 10) {
  const today = new Date();
  for (let i = 0; i < maxDaysBack; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}${m}${day}`;
    const url = `https://reportdocs.static.szse.cn/files/text/etf/ETF${code}${dateStr}.txt`;
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (!resp.ok) continue;
      const buffer = await resp.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buffer);
      // 从文件内容提取日期，如 "( 2026-07-21 )"
      const dateMatch = text.match(/\(\s*(\d{4}-\d{2}-\d{2})\s*\)/);
      const fileDate = dateMatch ? dateMatch[1] : `${y}-${m}-${day}`;
      return { date: fileDate, text, rawDate: dateStr };
    } catch (_) { /* 继续往前推一天 */ }
  }
  return null;
}

/* ---------- 解析 PCF 文件（GBK 固定宽度） ---------- */
function parsePCF(gbkText, fileDate) {
  const lines = gbkText.split('\n');

  // 定位成分股表头行
  const headerIdx = lines.findIndex(l => l.includes('证券代码'));
  if (headerIdx < 0) return { rows: [], enriched: [], listDate: null };

  const header = lines[headerIdx];

  // 表头中各列名及其在表头中的偏移位置（用于匹配数据行中的值）
  // 注意：不能直接用 indexOf 位置切片，因为中文字符视觉宽度与 ASCII 不同，表头与数据行不对齐
  const headerCols = [
    { name: 'code', key: '证券代码', headerPos: header.indexOf('证券代码') },
    { name: 'name', key: '证券简称', headerPos: header.indexOf('证券简称') },
    { name: 'qty', key: '股份数量', headerPos: header.indexOf('股份数量') },
    { name: 'flag', key: '现金替代标志', headerPos: header.indexOf('现金替代标志') },
    { name: 'marginRate', key: '申购现金替代保证金率', headerPos: header.indexOf('申购现金替代保证金率') },
    { name: 'sellMarginRate', key: '赎回现金替代保证金率', headerPos: header.indexOf('赎回现金替代保证金率') },
    { name: 'buyAmount', key: '申购替代金额', headerPos: header.indexOf('申购替代金额') },
    { name: 'sellAmount', key: '赎回替代金额', headerPos: header.indexOf('赎回替代金额') },
    { name: 'market', key: '挂牌市场', headerPos: header.indexOf('挂牌市场') },
  ];

  // 收集表头之后的所有数据行（直到空行或分隔线）
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('---') || line.trim().startsWith('--')) break;
    rows.push(line);
  }

  // 在数据行中查找所有非空值的位置
  function findValues(line) {
    const values = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      values.push({ value: m[0], pos: m.index });
    }
    return values;
  }

  // 将数据行中的值按位置匹配到最近的表头列
  // 注意：越靠右的列因中文字符视觉宽度累积偏移越大，阈值需动态递增
  function matchValuesToColumns(line) {
    const values = findValues(line);
    const result = {};
    let vi = 0;

    for (let ci = 0; ci < headerCols.length; ci++) {
      const col = headerCols[ci];
      const threshold = 25 + ci * 5; // 动态阈值：列越靠右，容忍度越大

      // 找最接近当前表头列位置的值
      while (vi < values.length - 1 &&
             Math.abs(values[vi + 1].pos - col.headerPos) < Math.abs(values[vi].pos - col.headerPos)) {
        vi++;
      }

      if (vi < values.length && Math.abs(values[vi].pos - col.headerPos) < threshold) {
        result[col.name] = values[vi].value;
        vi++;
      } else {
        result[col.name] = '';
      }
    }
    return result;
  }

  const enriched = rows.map(line => {
    const vals = matchValuesToColumns(line);

    const code = vals.code || '';
    const name = vals.name || '';
    const qtyStr = vals.qty || '0';
    const flag = vals.flag || '';
    const marginRateStr = vals.marginRate || '';
    const buyAmountStr = vals.buyAmount || '';
    const market = vals.market || '';

    const qty = parseInt(qtyStr.replace(/,/g, ''), 10) || 0;
    const buyAmount = parseFloat(buyAmountStr.replace(/,/g, '')) || 0;
    const isMissing = qty > 0 && buyAmount === 0;
    const marginRate = marginRateStr.replace('%', '').trim();

    return {
      INSTRUMENT_ID: code,
      INSTRUMENT_NAME: name,
      QUANTITY: String(qty),
      SUBSTITUTION_CASH_AMOUNT: buyAmount > 0 ? buyAmount.toFixed(2) : (isMissing ? '' : '0.00'),
      SUBSTITUTION_FLAG: flag,
      _MARKET_CN: market,
      _FLAG_CN: flag,
      _AMOUNT_SOURCE: buyAmount > 0 ? 'api' : (isMissing ? 'missing' : 'api'),
      _MARGIN_RATE: marginRate,
      _IS_CASH: code === '159900',
    };
  });

  // 从文件提取日期标题
  const dateMatch = gbkText.match(/\(\s*(\d{4}-\d{2}-\d{2})\s*\)/);
  const listDate = dateMatch ? dateMatch[1] : fileDate;

  return { rows, enriched, listDate };
}

/* ---------- 并发池：限制同时运行的 Promise 数量 ---------- */
async function asyncPool(items, concurrency, fn) {
  let i = 0;
  const results = [];
  const runNext = async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = fn(items[idx]).catch(e => { throw e; });
    }
  };
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.allSettled(runners);
  return Promise.allSettled(results);
}

/* ---------- 补算缺失价格：主方案 yunhq snap, 备选东财 K-line ---------- */
async function computeMissingPrices(needPrice, listDate) {
  const priceMap = {};

  // 将 listDate "YYYY-MM-DD" 转 "YYYYMMDD" 用于对比
  const listDateCompact = listDate ? listDate.replace(/-/g, '') : '';

  // 主方案：并发查 yunhq snap（限制最多 5 个并发，防止 API 封禁）
  const snapResults = await asyncPool(needPrice, 5, r =>
    fetchSnapQuote(r.INSTRUMENT_ID)
      .then(snap => snap ? { id: r.INSTRUMENT_ID, snap } : { id: r.INSTRUMENT_ID, snap: null })
  );

  const emNeed = []; // 需要降级到东财的股票

  snapResults.forEach(pr => {
    if (pr.status !== 'fulfilled' || !pr.value.snap) {
      emNeed.push(pr.value?.id);
      return;
    }
    const { id, snap } = pr.value;
    const snapDate = snap.date ? String(snap.date) : '';

    // 日期对齐判断：snap.date == TRADING_DAY ?
    if (snapDate === listDateCompact) {
      // ✅ snap 日期与 TRADING_DAY 一致 → 使用昨收价（T-1 收盘价）
      // SSE 每天上午 8:30 更新前一日收盘数据，替代金额以 T-1 收盘价为基准
      if (snap.prevClose != null) {
        priceMap[id] = snap.prevClose;
      } else {
        emNeed.push(id);
      }
    } else {
      // ❌ 清单是历史数据 → 用昨收价
      if (snap.prevClose != null) {
        priceMap[id] = snap.prevClose;
      } else {
        emNeed.push(id);
      }
    }
  });

  // 备选方案：日期没对齐或 snap 取不到价格的用东财 K-line（同样限 5 并发）
  if (emNeed.length > 0) {
    // 用 TRADING_DAY 作为目标日期（东财 K-line 带日期参数，精确返回当日收盘价）
    const targetDate = listDate;
    if (targetDate) {
      const emResults = await asyncPool(emNeed, 5, id =>
        fetchClosingPriceFromEastMoney(id, targetDate)
          .then(price => ({ id, price }))
          .catch(() => ({ id, price: null }))
      );
      let emCount = 0;
      emResults.forEach(pr => {
        if (pr.status === 'fulfilled' && pr.value.price != null) {
          priceMap[pr.value.id] = pr.value.price;
          emCount++;
        }
      });
      if (emCount > 0) priceMap._source = 'eastmoney';
    }
  }

  return priceMap;
}

/* ---------- 拉取上交所成分股数据 ---------- */
async function fetchComponents(fundCode) {
  const params = new URLSearchParams({
    sqlId: 'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C',
    FUNDID2: fundCode,
    jsonCallBack: 'cb',
    isPagination: 'false',
    'pageHelp.pageSize': '500',
  });
  const resp = await fetch(`https://query.sse.com.cn/commonQuery.do?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Referer: 'https://etf.sse.com.cn/',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
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
  let computedCount = 0;
  const enriched = rows.map(r => {
    const rawAmt = (r.SUBSTITUTION_CASH_AMOUNT || '').trim();
    const qty = parseInt(r.QUANTITY, 10);
    const isMissing = qty > 0 && (!rawAmt || rawAmt === '-');
    if (isMissing) computedCount++;
    return {
      INSTRUMENT_ID: r.INSTRUMENT_ID,
      INSTRUMENT_NAME: r.INSTRUMENT_NAME,
      QUANTITY: r.QUANTITY,
      SUBSTITUTION_CASH_AMOUNT: rawAmt,
      SUBSTITUTION_FLAG: r.SUBSTITUTION_FLAG || '',
      _MARKET_CN: MARKET_MAP[r.UNDERLYION_SECURITY_ID] || '其他',
      _FLAG_CN: FLAG_MAP[r.SUBSTITUTION_FLAG] || r.SUBSTITUTION_FLAG || '',
      _AMOUNT_SOURCE: isMissing ? 'missing' : 'api',
    };
  });

  return { rows, enriched, computedCount };
}

/* ---------- 拉取申购赎回清单基本信息（含交易日） ---------- */
async function fetchSgInfo(fundCode) {
  const params = new URLSearchParams({
    sqlId: 'COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C',
    FUNDID2: fundCode,
    jsonCallBack: 'cb',
    isPagination: 'false',
    'pageHelp.pageSize': '500',
  });
  const resp = await fetch(`https://query.sse.com.cn/commonQuery.do?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Referer: 'https://etf.sse.com.cn/',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  const text = await resp.text();
  let jsonStr = text;
  if (text.startsWith('cb(') && text.endsWith(')')) {
    jsonStr = text.slice(3, -1);
  }
  const data = JSON.parse(jsonStr);
  const result = data.result || [];
  if (!result.length) return {};

  // TRADING_DAY 是 YYYYMMDD 格式，转成 YYYY-MM-DD
  const rawDay = result[0].TRADING_DAY || '';
  const preDay = result[0].PRE_TRADING_DAY || '';
  const tradingDay = rawDay.length === 8
    ? `${rawDay.slice(0,4)}-${rawDay.slice(4,6)}-${rawDay.slice(6,8)}` : '';
  const preTradingDay = preDay.length === 8
    ? `${preDay.slice(0,4)}-${preDay.slice(4,6)}-${preDay.slice(6,8)}` : '';

  return { tradingDay, preTradingDay };
}

/* ---------- SSE yunhq snap 行情接口（主方案） ---------- */
// 可用于查询 ETF 自身行情或任何上交所个股的 snap 数据
async function fetchSnapQuote(code) {
  const select =
    'name,last,chg_rate,change,open,prev_close,high,low,volume,amount,tradephase,cpxxextendname,iopv';
  // HTTPS 优先，降级到 HTTP
  const urls = [
    `https://yunhq.sse.com.cn:32042/v1/sh1/snap/${code}?select=${select}`,
    `http://yunhq.sse.com.cn:32041/v1/sh1/snap/${code}?select=${select}`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!resp.ok) continue;
      const data = await resp.json();
      const s = data?.snap;
      if (!s || s.length < 13) continue;
      return {
        date: data.date,           // YYYYMMDD
        last: parseFloat(s[1]),    // 最新价
        chgRate: parseFloat(s[2]), // 涨跌幅
        change: parseFloat(s[3]),  // 涨跌额
        open: parseFloat(s[4]),    // 开盘价
        prevClose: parseFloat(s[5]), // 昨收价 ← 替代金额补算用
        high: parseFloat(s[6]),    // 最高
        low: parseFloat(s[7]),     // 最低
        volume: parseInt(s[8], 10),
        amount: parseFloat(s[9]),
        fundName: s[11] || '',    // 基金全称（用于 ETF 名称）
        iopv: parseFloat(s[12]),  // IOPV 净值（仅 ETF 有）
      };
    } catch (_) { /* 尝试下一个 URL */ }
  }
  return null;
}

/* ---------- 东财 K-line 历史收盘价（备选方案） ---------- */
async function fetchClosingPriceFromEastMoney(stockCode, dateStr) {
  // 6xxxxx/688xxx → 上交所 market=1；其余 → 深交所 market=0
  const market = stockCode.startsWith('6') ? 1 : 0;
  const dateCompact = dateStr.replace(/-/g, '');
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get` +
    `?secid=${market}.${stockCode}` +
    `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=1&end=${dateCompact}&lmt=1`;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const klines = data?.data?.klines;
    if (!klines?.length) return null;
    const parts = klines[0].split(',');
    // kline: 日期,开盘价,收盘价,最高价,最低价,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
    if (parts[0] === dateStr) return parseFloat(parts[2]);
    return null;
  } catch (_) {
    return null;
  }
}

/* ---------- 拉取 ETF 名称 ---------- */
async function fetchQuote(fundCode) {
  try {
    const resp = await fetch(
      `https://searchadapter.eastmoney.com/api/suggest/get?input=${fundCode}&count=1&type=14`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
    );
    if (!resp.ok) return { name: '' };
    const data = await resp.json();
    const name = data?.QuotationCodeTable?.Data?.[0]?.Name || '';
    return { name };
  } catch (_) {
    return { name: '' };
  }
}

/* ---------- 境外票券昨日收盘价（Yahoo Finance 主方案） ---------- */
async function fetchForeignPrice(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=1d`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    // chartPreviousClose = 昨收价, regularMarketPrice = 最新价（兜底）
    return meta?.chartPreviousClose || meta?.regularMarketPrice || null;
  } catch (_) {
    return null;
  }
}

/* ---------- 境外票券昨日收盘价（investing.com 备选方案） ---------- */
async function fetchInvestingPrice(ticker, name) {
  try {
    // 用名称构造 investing.com 页面路径：替换空格为"-"，转小写
    const slug = (name || ticker).toLowerCase().replace(/\s+/g, '-');
    const url = `https://cn.investing.com/equities/${slug}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    // 找 data-test="etfPrevClose" 元素的文本内容
    const match = html.match(/data-test="etfPrevClose"[^>]*>([^<]+)</);
    if (match) {
      return parseFloat(match[1].replace(/,/g, '')) || null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/* ---------- 汇率查询（免费 exchangerate-api，无 key） ---------- */
// 市场 → 币种映射
const MARKET_CURRENCY = {
  '其他市场': 'USD',
  '香港市场': 'HKD',
  '日本市场': 'JPY',
  '英国市场': 'GBP',
  '德国市场': 'EUR',
  '法国市场': 'EUR',
};
async function fetchExchangeRate(fromCurrency, toCurrency = 'CNY') {
  // 同一个币种不用换算
  if (fromCurrency === toCurrency) return 1;
  try {
    const url = `https://api.exchangerate-api.com/v4/latest/${fromCurrency}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.rates?.[toCurrency] || null;
  } catch (_) {
    return null;
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
