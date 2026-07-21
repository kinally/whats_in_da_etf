# SZSE 待修复问题清单

> 创建日期：2026-07-21
> 下次会话从此开始

---

## 问题 1：深圳市场替代金额计算失效

**现象：** 深圳交易所 PCF 中，标记为"深圳市场"和"上海市场"的票券，其替代金额计算全部不生效，显示为 `-`。

**已尝试的修复：**
- 跳过 `yunhq.sse.com.cn` snap 查询（深市会超时），直接走东财 K-line
- 东财 K-line 请求添加 `Referer: https://quote.eastmoney.com/` 头
- 新增 `fetchPrevCloseFromPush2` 函数，K-line 失败时降级到 push2 实时行情取昨收价

**仍未解决，可能原因：**
- 东财 API 对 CF Worker  IP 段的访问限制
- 需要尝试其他数据源，如新浪财经、腾讯证券
- 或需要更完整的请求头模拟（Cookie、Accept-Language 等）

---

## 问题 2：申赎现金替代金额占比异常

**现象：** 大量 ETF 的 159900 申赎现金的替代金额占比恰好为 50%，且替代金额除以占比后，总价值远小于 ETF 实际总市值。

**猜测：** 50% 占比可能不是实际值，而是基金公司未填写时的默认占位值。待确认。

**例外：** 日经 ETF（159866）的持仓 + 申赎现金 = 总市值，计算正确。

**待确认事项：**
- 50% 占比是否为默认占位值？
- 如果未填写，应如何计算实际占比？
- 是否需要从其他字段推导总市值？

---

## 问题 3：SZSE ETF 行情价格不显示

**现象：** `class="etf-price-info"` 下的内容项（最新价、涨跌幅、IOPV）完全不显示。

**已实现：** `fetchSZSEQuote(fundCode)` 函数，调用东财 push2 实时行情接口（`secid=0.{fundCode}`），返回 `{last, chgRate, prevClose, iopv: null}`。

**仍未解决，可能原因：**
- 东财 push2 接口对 CF Worker 的请求限制
- IOPV 净值字段东财没有提供
- 需要尝试其他行情源：新浪财经、腾讯证券、Yahoo Finance

---

## 附录：当前数据链路

### 上交所（SSE）✅ 已正常

```
ETF 行情: yunhq.sse.com.cn snap → 最新价/涨跌幅/IOPV
成分股昨收价: yunhq.sse.com.cn snap → 东财 K-line 兜底
```

### 深交所（SZSE）🔴 待修复

```
ETF 行情: 东财 push2 → ❌ 不显示
内地票昨收价: 东财 K-line → 东财 push2 兜底 → ❌ 不计算
境外票昨收价: Yahoo Finance → investing.com 兜底 → ✅ 正常
汇率: exchangerate-api.com → ✅ 正常
```

---

*下次会话从「问题 1」开始排查，确认东财 API 是否被 CF Worker  IP 段限制，或切换数据源。*