# 深交所 ETF 支持方案

> **状态：🟢 已实现 · 2026-07-21**
>
> 本文档记录深交所（SZSE）ETF 成分股数据获取方案的设计与实现细节。
> 对应代码：`_worker.js` 中的 `querySZSE()` / `findLatestSZSE()` / `parsePCF()` 函数。

---

## 一、数据源

### 1.1 官方 PCF 文件

深交所每个交易日发布 ETF 申购赎回清单（PCF），文件格式为 **GBK 编码的固定宽度文本**，可通过以下 URL 模式获取：

```
https://reportdocs.static.szse.cn/files/text/etf/ETF{CODE}{YYYYMMDD}.txt
```

**示例：** 创业板ETF（159915）在 2026-06-18 的数据
```
https://reportdocs.static.szse.cn/files/text/etf/ETF15991520260618.txt
```

### 1.2 适用代码范围

| 交易所 | 代码开头 | 示例 | 数据源 |
|--------|---------|------|-------|
| 上交所 (SSE) | `5xxxxx` | 513310, 516070 | `query.sse.com.cn` JSONP |
| 深交所 (SZSE) | `15xxxx` / `16xxxx` | 159915, 159919 | `reportdocs.static.szse.cn` TXT |

---

## 二、日期处理策略

### 2.1 核心问题

直接使用 `today` 不可行，因为：
- 周末/节假日无数据 → 文件返回 404
- 交易日当天 PCF 通常在 **开盘前（8:30-9:00）** 发布，盘前用昨天日期

### 2.2 方案：向后逐日回退

```javascript
async function findLatestSZSE(code, maxDaysBack = 10) {
  for (let i = 0; i < maxDaysBack; i++) {
    const date = offsetBusinessDays(i);  // 从今天往前推 i 个自然日
    const url = `https://reportdocs.static.szse.cn/files/text/etf/ETF${code}${date}.txt`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (resp.ok) return { date, text: await resp.text() };
  }
  return null;  // 找不到任何近期的 PCF 文件
}
```

**优化思路：**
- 可以用 SSE 的 `sgInfo` API 中的 `PRE_TRADING_DAY` / `TRADING_DAY` 来辅助判断交易日
- 也可以维护一个简单的交易日历（或调用交易日 API）

### 2.3 文件日期与补算价格的关系

同 SSE 已确认的规则：

| 文件日期 | 补算用价格 | 说明 |
|---------|-----------|------|
| 文件标注 T 日（T=today） | T-1 收盘价（昨收价） | PCF 替代金额以 T-1 为基准 |
| 文件标注 T-1 日 | T-2 收盘价 | 类推 |

---

## 三、文件格式解析

### 3.1 文件结构

文件分为四个区段，用 `---` 分隔线隔开：

```
[1. 标题区]
创业板ETF易方达申购赎回清单
( 2026-06-18 )

[2. 基本信息]
基金名称：  创业板ETF易方达
基金管理人：易方达基金管理有限公司
基金代码：  159915
目标指数：  399006
基金类型：  单市场ETF

[3. T-1 日内容]
现金差额：  4271.63元
最小申赎单位资产净值：  4180145.63元
基金份额净值：  4.1801元

[4. T 日内容]
预估现金差额：  4421.63元
现金替代比例上限：  50.00%
是否公布IOPV：  是
最小申购赎回单位：  1000000份
...

[5. 成分股明细]   ← 核心数据
证券代码  证券名称      股份数量  现金替代标志  申购保证金率  赎回保证金率  申购溢价  赎回溢价  市场
300001    特锐德          400      允许           73.00%                     0.0000    0.0000  深圳市场
300002    神州泰岳       1100      允许           73.00%                     0.0000    0.0000  深圳市场
...
```

### 3.2 成分股表格列定义（固定宽度）

| 列名（深交所原文） | 列名（我们使用） | 宽度 | 说明 |
|-----------------|----------------|------|------|
| 证券代码 | `INSTRUMENT_ID` | 6-8 | 如 300001 |
| 证券名称 | `INSTRUMENT_NAME` | 不定 | UTF-8 解码后 |
| 股份数量 | `QUANTITY` | 不定 | 每篮子股数 |
| 现金替代标志 | `SUBSTITUTION_FLAG` | 4 | 允许/必须/禁止 |
| 申购现金替代保证金率 | (申购保证金率) | 不定 | 如 73.00% |
| 赎回现金替代保证金率 | (赎回保证金率) | 不定 | 如 73.00% |
| 申购溢价/折价 | (申购溢价) | 不定 | 如 0.0000 |
| 赎回溢价/折价 | (赎回溢价) | 不定 | 如 0.0000 |
| 深圳市场 | `_MARKET_CN` | 固定 | "深圳市场" |

### 3.3 编码处理

```javascript
// GBK → UTF-8 解码
const decoder = new TextDecoder('gbk');
const utf8Text = decoder.decode(gbkBuffer);
```

> ⚠️ Cloudflare Workers 的 `TextDecoder` 支持 `'gbk'` 编码，可以直接使用。

### 3.4 解析伪代码

```javascript
function parsePCF(rawText) {
  // 1. 定位成分股表格起始行（"证券代码" 表头行）
  // 2. 从表头下一行开始，逐行解析
  // 3. 每行按固定宽度分割字段
  // 4. 提取：代码 / 名称 / 数量 / 替代标志
  // 5. 返回 enriched 格式数组
  
  const lines = utf8Text.split('\n');
  const headerIdx = lines.findIndex(l => l.includes('证券代码'));
  const rows = [];
  
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('---') || line.startsWith('--')) break;
    
    const code = line.slice(0, 8).trim();
    const name = line.slice(8, 30).trim();
    const qty = parseInt(line.slice(30, 45).trim(), 10);
    const flag = line.slice(45, 55).trim();
    
    rows.push({ code, name, qty, flag });
  }
  return rows;
}
```

---

## 四、整合到 _worker.js

### 4.1 handleQuery 路由

```javascript
async function handleQuery(url) {
  const fundCode = (url.searchParams.get('code') || '').trim();
  
  if (/^5\d{5}$/.test(fundCode)) {
    return querySSE(fundCode);       // 现有逻辑
  }
  if (/^1[5-6]\d{4}$/.test(fundCode)) {
    return querySZSE(fundCode);      // 新增：深交所逻辑
  }
  return jsonResponse({ ok: false, error: `不支持的基金代码: ${fundCode}` }, 400);
}
```

### 4.2 querySZSE 函数

```javascript
async function querySZSE(fundCode) {
  // 1. 向后回退查找最近交易日的 PCF 文件
  const pcfData = await findLatestSZSE(fundCode);
  if (!pcfData) {
    return jsonResponse({ ok: true, noPcf: true, ... });
  }
  
  // 2. 解析成分股列表
  const rows = parsePCF(pcfData.text);
  
  // 3. 补算替代金额（复用 computeMissingPrices）
  const enriched = rows.map(r => ({ ... }));
  
  // 4. 获取 ETF 名称 & 行情（东财 suggest / 其他接口）
  const etfName = await fetchSZSEQuote(fundCode);
  
  // 5. 返回统一格式
  return jsonResponse({ ok: true, etfName, listDate, rows: enriched, ... });
}
```

---

## 五、待确认事项

| # | 事项 | 状态 | 需人类信息专员核实 | 备注 |
|---|------|------|-------------------|------|
| 1 | TXT 文件中是否有"替代金额"字段 | ❌ 确认无 | 已确认 | 需补算 |
| 2 | 深交所的现金替代标志码制 | ❌ 待核实 | 🔍 深交所文件用汉字"允许/禁止/必须"，与 SSE 的 0-8 数字编码不同，需确认全套码制映射关系 | |
| 3 | 深交所 ETF 的行情接口 | ❌ 待核实 | 🔍 yunhq.sse.com.cn 仅支持上交所，深交所 ETF 实时价格/IOPV 从哪拿？东财行情？（如 `push2.eastmoney.com`） | |
| 4 | 深交所 ETF 名称获取 | ❌ 待核实 | 🔍 现有东财 suggest 是否支持 15/16 开头代码查询名称？ | |
| 5 | GBK 解码在 CF Worker 中是否稳定 | ✅ 可行 | 已确认 | `TextDecoder('gbk')` |
| 6 | 日期回退步长（最大几天） | ❌ 待核实 | 🔍 建议值 10 天，需确认是否能覆盖春节/国庆长假 | |
| 7 | 16 开头基金中 ETF 与 LOF 的区分 | ❌ 待核实 | 🔍 16 开头既有 ETF 又有 LOF，如何在前端/后端过滤？是否有公开的 ETF 白名单？ | |
| 8 | TXT 文件中是否有"市场"字段标识成分股所属交易所 | ❌ 待核实 | 🔍 沪深跨市场 ETF（如 159919 沪深300）的成分股可能同时包含深市和沪市股票 | |

---

## 六、文件列表（深交所相关）

```
sse_etf_monitor_cf/
├── _worker.js            # 🔌 新增 querySZSE() + fetchSZSE() + parsePCF()
├── SZSE_PLAN.md          # 📄 本文档
└── README.md             # 更新待办列表
```

---

*方案版本：v0.1 · 2026-06-18*