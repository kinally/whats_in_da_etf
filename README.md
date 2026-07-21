# ETF 成分股查看器 — Cloudflare Workers + Pages 版

> 监控上交所（SSE）与深交所（SZSE）ETF 成分股变动，部署在 Cloudflare Workers + Pages 上全球加速。
> 线上示例：[inetf.ch0c0u.site](https://inetf.ch0c0u.site)

## 🗺️ 架构

```
你电脑 (本地)  ───push──→  GitHub 仓库 (kinally/whats_in_da_etf)
                              │
                              └──→  Cloudflare Workers + Pages
                                      │
                                      ├─ 静态资源 (index.html / app.js / style.css)
                                      ├─ data/latest.js (静态快照)
                                      └─ /api/query (Worker)
                                           ├─ 上交所 (5xxxxx) → SSE API + 东财
                                           └─ 深交所 (15xxxx/16xxxx) → SZSE PCF + 东财 + Yahoo Finance
```

## 📁 文件结构

```
whats_in_da_etf/
├── _worker.js            # ⚡ Cloudflare Worker 入口（路由/API代理/并发分流/沪深双引擎）
├── index.html            # 🌐 主页面（含现金统计卡片）
├── style.css             # 🎨 样式表（含 Toast/Modal/现金高亮 组件）
├── app.js                # ⚡ 前端逻辑（搜索/排序/导出/刷新/Toast/现金高亮）
├── data/
│   └── latest.js         # 📦 初始成分股快照（`ETF_DATA` 全局变量）
├── SZSE_PLAN.md          # 📄 深交所支持方案文档
├── wrangler.jsonc        # 🔧 Wrangler 配置文件
├── .assetsignore
├── .gitignore
└── README.md             # 📖 本说明文件
```

## 🚀 本地开发

### 前置条件

| 工具 | 验证命令 |
|------|---------|
| Node.js (≥18) | `node -v` |
| Git | `git --version` |
| Wrangler | `npx wrangler --version` |

### 本地预览

```bash
# 启动本地 Workers + Pages 开发环境（含 Worker Function）
npx wrangler pages dev . --port 8800
```

浏览器访问 http://localhost:8800

## ✅ 功能说明

### 通用功能

| 功能 | 操作 | 说明 |
|------|------|------|
| 📋 成分股列表 | 打开页面自动显示 | 按替代金额降序排列 |
| 🏆 前 5 大权重 | 页面顶部卡片 | 按替代金额排序显示（排除申赎现金） |
| 🔍 搜索 ETF 代码 | 搜索框输入代码后点「刷新」 | 支持上交所 5 开头 / 深交所 15/16 开头 |
| 🔍 过滤成分股 | 搜索框输入代码/名称 | 表格实时过滤 |
| 🧮 替代金额补算 | 自动 | 缺失的替代金额自动补算，黄色底纹 + ★ 标记 |
| ↕️ 排序 | 点击列头 | 按该列升降序排列 |
| 📥 导出 CSV | 点「导出 CSV」 | 含 BOM 的 UTF-8 CSV，Excel 可直接打开 |
| 📂 载入历史数据 | 点「载入历史数据」 | 选择 JSON 快照文件加载 |
| 🔔 交易所披露提示 | 页脚显示 | SSE 披露时间 8:30 |

### 上交所（SSE）特有功能

| 功能 | 说明 |
|------|------|
| 🏷️ ETF 行情（Header） | 显示最新价 / 涨跌幅 / IOPV 净值（来自 yunhq.sse.com.cn） |
| 📅 清单交易日 | 从 sgInfo API 获取 TRADING_DAY |

### 深交所（SZSE）特有功能

| 功能 | 说明 |
|------|------|
| 📄 PCF 文件解析 | 从深交所官网拉取 GBK 编码的申购赎回清单，自动解析固定宽度表格 |
| 📅 日期回溯 | 自动向前回溯 10 个自然日查找最近交易日 PCF 文件 |
| 💰 申赎现金高亮 | 159900 申赎现金行金色高亮 + 独立统计 |
| 🌐 境外股票补算 | 美股/港股等境外成分股通过 Yahoo Finance 查价，investing.com 兜底 |
| 💱 自动汇率换算 | 按市场（USD/HKD/JPY…）自动取汇率转人民币 |

## 🔧 Worker API 详情

`/api/query?code=513310` 或 `/api/query?code=159032`

### 上交所（5xxxxx）数据链路

1. **上交所成分股** `query.sse.com.cn` → 成分股清单
2. **上交所申赎清单** `query.sse.com.cn` → 交易日信息
3. **SSE yunhq snap** `yunhq.sse.com.cn` → ETF 自身行情 + 成分股昨收价
4. **东财 K-line** `push2his.eastmoney.com` → 备选补算缺失价格
5. **东财 suggest** `searchadapter.eastmoney.com` → ETF 名称降级获取

### 深交所（15xxxx/16xxxx）数据链路

1. **深交所 PCF 文件** `reportdocs.static.szse.cn` → 申购赎回清单（GBK → UTF-8）
2. **东财 K-line** `push2his.eastmoney.com` → 内地成分股昨收价
3. **Yahoo Finance** `query1.finance.yahoo.com` → 境外成分股昨收价（主方案）
4. **investing.com** `cn.investing.com` → 境外成分股昨收价（备选方案）
5. **exchangerate-api** `api.exchangerate-api.com` → 汇率换算（USD/CNY, HKD/CNY …）
6. **东财 suggest** `searchadapter.eastmoney.com` → ETF 名称获取

### 并发控制

所有对外请求限并发 5（境外票限 3），防止 API 封禁。

### 替代金额计算

**上交所（SSE）：** `替代金额 = 数量 × 昨收价`

**深交所（SZSE）：** `替代金额 = 数量 × 昨收价 × (1 + 申购现金替代保证金率)`

- 若 PCF 中"申购替代金额"已填（非 0）→ 直接使用
- 若未填且股份数量 > 0 → 按公式补算
- 159900 申赎现金 → 使用文件自带金额，高亮显示
- 境外股票 → 价格 × 汇率 → 人民币

## ❓ 常见问题

**Q: 点刷新后返回 502 Bad Gateway？**
A: 上交所 API 有 WAF 防护，可能拦截 CF 边缘节点 IP。Worker 已模拟完整浏览器请求头绕过，如仍失败可以稍后再试。持续失败可能是上交所接口变更。

**Q: 深交所 ETF 查询返回"不提供申购赎回清单"？**
A: 16 开头部分基金为 LOF 而非 ETF，PCF 文件不存在。可尝试其他 15/16 开头代码。

**Q: 页面空白 / 没有数据？**
A: F12 → Console 看看有没有报错。检查 `data/latest.js` 是否存在。

**Q: 浏览器控制台报 `ERR_BLOCKED_BY_CLIENT`？**
A: 浏览器插件（广告拦截器）拦截了 CDN 资源，不影响功能。

**Q: 「补算」是什么意思？**
A: 部分成分股缺失替代金额。Worker 会自动用该股 T-1 收盘价 × 数量补算，并在表格中用 ★ 标记、底色高亮。深交所还会加上保证金率。

**Q: 境外股票替代金额怎么算的？**
A: 通过 Yahoo Finance 获取美元/港币收盘价，再按当日汇率换算成人民币，最后套用保证金率公式。

**Q: 159900 申赎现金是什么？**
A: 基金公司预留的现金头寸，非真实持仓。表格中用金色高亮 + 💰 标记，独立统计，不计入 Top 5 权重。

---

## 📜 近期变更记录

| 日期 | 变更 | 说明 |
|------|------|------|
| 2026-07-21 | 修复 parsePCF 列映射 | 改用正则匹配替代 indexOf 切片，解决中文字符宽度偏移问题 |
| 2026-07-21 | SZSE ETF 行情接入 | 东财 push2 实时行情（最新价/涨跌幅/昨收） |
| 2026-07-21 | 新增深交所（SZSE）支持 | `querySZSE()` / `findLatestSZSE()` / `parsePCF()` |
| 2026-07-21 | 境外股票价格查询 | Yahoo Finance 主方案 + investing.com 备选 |
| 2026-07-21 | 汇率自动换算 | 按市场（USD/HKD/JPY）分流，转人民币入账 |
| 2026-07-21 | 申赎现金高亮 | 159900 行金色高亮 + 独立统计 |
| 2026-07-03 | 修复 SSE API 请求头 | 添加浏览器头绕过 WAF 502 拦截 |
| 2026-07-03 | Toast 替换 alert | 底部弹出，不打断操作 |
| 2026-06-17 | 上交所替代金额用 T-1 收盘价 | 补算逻辑修正 |
| 2026-06-17 | asyncPool 并发控制 | 限制最大 5 并发请求 |

---

> 💡 有问题提 Issue，或回家慢慢修。