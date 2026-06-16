# ETF 成分股查看器 — Cloudflare Workers 版

> 🏠 **纯前端 + Cloudflare Workers 部署**，无需 Python 后端。
> 在搜索框输入上交所 ETF 代码（5 开头），点刷新即可实时查询成分股。

## 🗺️ 架构

```
浏览器                   Cloudflare Workers
 ┌──────┐   /api/query    ┌──────────────────────────────┐
 │ 页面  │ ──────────────→ │  _worker.js                   │
 │      │ ←────────────── │  ├─ 上交所 query.sse(成分股)   │
 │      │   JSON          │  ├─ 上交所 sgInfo(交易日)      │
 │      │                 │  ├─ SSE yunhq snap(行情/补算)  │
 │      │                 │  └─ 东财 K-line(补算备选)      │
 └──────┘                 └──────────────────────────────┘
```

## 🔀 数据源分流策略

| 用途 | 主方案 (P0) | 备选 (P1) | 原因 |
|------|------------|----------|------|
| ETF 名称 | `yunhq snap[11]` (cpxxextendname) | 东财 `searchadapter.suggest` | snap 0开销,随行情一起返回 |
| ETF 行情(最新价/涨跌幅/IOPV) | `yunhq snap[1]/[2]/[12]` | — | 上交所官方实时行情 |
| 成分股替代金额补算 | `yunhq snap[1]`(最新价=今日收盘价) | 东财 K-line `end=TRADING_DAY` | snap.date==TRADING_DAY时,市场已收盘,最新价=今日收盘价 ✅ |
| 清单是历史数据时 | `yunhq snap[5]` (prev_close=昨收价) | 东财 K-line `end=TRADING_DAY` | snap.date≠TRADING_DAY时用昨收价 |

### 分流流程图

```
computeMissingPrices(needPrice, listDate)
  │
  对每只成分股并发 fetchSnapQuote()
  │
  ├─ snap.date == TRADING_DAY ?
  │  ├─ ✅ PCF是今天的,市场已收盘 → snap[1](最新价) = 今日收盘价
  │  └─ ❌ PCF是历史数据 → snap[5](昨收价) = 最近收盘价
  │
  └─ 都失败 → 东财 K-line end=TRADING_DAY 兜底
```

### 为什么这么设计

1. **yunhq snap 是上交所官方行情接口**，返回实时 snap 数据
2. 申赎清单在交易结束后才会发布（约 18:00 后），此时 **snap[1] 最新价 = 当日收盘价**
3. 当 `snap.date === TRADING_DAY` 时 → 清单是当天的 → 最新价作为收盘价 ✅
4. 当 `snap.date !== TRADING_DAY` 时 → 清单是历史数据 → 用昨收价 `snap[5]`
5. 边界场景 date 对不齐时，降级到**东财 K-line 带日期参数**的精确查询

## ✅ 已实现功能

| 功能 | 说明 |
|------|------|
| 📋 ETF 成分股展示 | 代码 / 名称 / 数量 / 替代金额 / 金额占比 / 市场 |
| 🏆 Top 5 权重 | 按替代金额排序的前五大持仓 |
| 🔍 搜索过滤 | 在搜索框输入股票代码或名称实时过滤表格 |
| 🔄 实时刷新 | 搜索框输入 ETF 代码 → 点刷新，调上交所接口拉最新数据 |
| 🏷️ ETF 名称 | 从 SSE yunhq snap 接口获取基金全称，降级到东财 suggest |
| 📥 导出 CSV | 含替代金额占比，文件名带日期 |
| ↗️ 列头排序 | 点击任意列表头排序（金额占比按替代金额排序） |
| 📅 清单交易日 | 从 sgInfo API 获取 TRADING_DAY，显示清单对应交易日 |
| 🧮 替代金额补算 | 6/688 开头上交所成分股替代金额为 "-" 时，自动取昨收价 × 数量补算 |
| ⭐ 补算标记 | 补算的替代金额在表格中用黄色底纹 + ★ 标记，统计卡显示"补算"计数 |
| 📊 ETF 价格参考 | Header 显示最新价 / 涨跌幅 / IOPV 净值（来自 yunhq snap） |
| 🧠 日期对齐检查 | yunhq snap 日期与 TRADING_DAY 对齐则用 snap，不对齐降级东财 K-line |
| 📆 数据日期源自 API | 日期不再用浏览器本地时间，改用 yunhq snap 自带 `res.date` + sgInfo `TRADING_DAY`，与股价严格对应 |

## 📁 文件结构

```
sse_etf_monitor_cf/
├── _worker.js          # 🔌 Cloudflare Workers 入口（路由 + API 代理）
├── wrangler.jsonc      # ⚙️  Workers 配置
├── .assetsignore       # 排除 Worker 文件被当作静态资源
├── index.html          # 🌐 主页面
├── style.css           # 🎨 样式表
├── app.js              # ⚡ 前端逻辑（搜索/排序/导出/刷新）
├── data/
│   └── latest.js       # 📦 空壳——首次打开无预读取数据，需手动刷新
├── push_api.ps1
├── push_api.py
├── .gitignore
└── README.md
```

## 🔧 使用说明

### 查询 ETF 成分股
1. 在 **搜索框** 输入上交所 ETF 代码（如 `513310`、`516070`、`588310`）
2. 点 **🔄 刷新** 按钮
3. 等待 1-3 秒，成分股列表、ETF 名称和价格参考自动更新

### 搜索成分股
- 在搜索框输入股票代码或名称关键字，表格实时过滤

### 导出 CSV
- 点 **📥 导出 CSV**，下载含金额占比的 CSV 文件（UTF-8 BOM）

## 📝 待更新（深交所支持）

### 🔴 第一阶段：深交所 ETF 基础支持

- [ ] **深交所数据拉取** — 深交所 ETF（15/16 开头）数据文件为 GBK 编码 TSV 格式，需在 Worker 中新增 `fetchSZSE()` 分支
  - 数据源 URL 格式：`https://www.szse.cn/api/disc/announcement/...`
  - 需要 GBK→UTF-8 转码（Node.js 可使用 `TextDecoder`）
  - TSV 解析与 SSE JSON 格式差异较大，需单独适配
- [ ] **前端路由** — `handleQuery()` 中识别 15/16 开头代码，分流到 `querySZSE()`
- [ ] **深交所行情接口确认** — 调研深交所是否有类似 yunhq 的 snap 实时行情接口
- [ ] **替代金额补算** — 深交所成分股的现金替代金额格式是否与上交所一致，需实测

### 🟡 第二阶段：完善与增强

- [ ] **ETF 名称缓存** — 目前名称从 yunhq snap 实时拉取，可考虑 KV 缓存减少请求
- [ ] **多代码对比** — 同时查看多只 ETF 的成分股对比
- [ ] **历史快照** — 保留不同日期的成分股数据，支持回溯对比
- [ ] **移动端优化** — 表格在手机上显示稍挤，可进一步适配

## 🔧 本地开发

```bash
# 安装 wrangler
npm install -g wrangler

# 本地预览
npx wrangler pages dev . --port 8800

# 部署
npx wrangler deploy
```

## ❓ 常见问题

**Q: 页面打开是空的？**
A: 正常——首次打开无预读取数据，请在搜索框输入 ETF 代码后点"刷新"获取实时数据。

**Q: 刷新后 ETF 名称不显示？**
A: yunhq snap 或东财 suggest 偶尔限流，不影响成分股数据，再次刷新即可。

**Q: 搜索框输入 ETF 代码后表格空了？**
A: 正常——搜索框同时用于过滤成分股，输入 6 位代码可能不匹配任何成分股。点刷新即可查询该 ETF。

**Q: 替代金额那栏显示 "-"？**
A: 6/688 开头的上交所成分股在 API 中不提供替代金额，系统会自动用昨收价 × 数量补算并标记 ★。

**Q: 控制台有报错，但不影响功能？**
A: 以下是已知的非代码类报错：
- `beacon.min.js` ERR_CONNECTION_CLOSED — Cloudflare Pages 自动注入的流量分析脚本，网络波动偶发
- `content_main.js` fetchError — Chrome 内置 AI (LanguageDetector) 扩展自身行为，与页面无关
- `favicon.ico` 404 — 已通过 data URI 内联 SVG favicon 解决

**Q: 可以查深交所 ETF 吗？**
A: 暂不支持。当前仅支持上交所 5 开头的 ETF。
