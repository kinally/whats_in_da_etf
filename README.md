# ETF 成分股查看器 — Cloudflare Workers + Pages 版

> 监控上交所 ETF 成分股变动，部署在 Cloudflare Workers + Pages 上全球加速。
> 线上示例：[inetf.ch0c0u.site](https://inetf.ch0c0u.site)

## 🗺️ 架构

```
你电脑 (本地)  ───push──→  GitHub 仓库 (kinally/whats_in_da_etf)
                              │
                              └──→  Cloudflare Workers + Pages
                                      │
                                      ├─ 静态资源 (index.html / app.js / style.css)
                                      ├─ data/latest.js (静态快照)
                                      └─ /api/query (Worker) ─→ 上交所 API (成分股/行情/净值)
                                                                └→ 东财 API (备选补算)
```

## 📁 文件结构

```
whats_in_da_etf/
├── _worker.js            # ⚡ Cloudflare Worker 入口（路由/API代理/并发分流）
├── index.html            # 🌐 主页面
├── style.css             # 🎨 样式表（含 Toast/Modal 组件）
├── app.js                # ⚡ 前端逻辑（搜索/排序/导出/刷新/Toast）
├── data/
│   └── latest.js         # 📦 初始成分股快照（`ETF_DATA` 全局变量）
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

| 功能 | 操作 | 说明 |
|------|------|------|
| 📋 成分股列表 | 打开页面自动显示 | 按替代金额降序排列 |
| 🏆 前 5 大权重 | 页面顶部卡片 | 按替代金额排序显示 |
| 🔍 搜索 ETF 代码 | 搜索框输入代码后点「刷新」 | 查询任意 5 开头上交所 ETF |
| 🔍 过滤成分股 | 搜索框输入代码/名称 | 表格实时过滤 |
| 🏷️ ETF 行情 | 刷新成功后显示 | 最新价/涨跌幅/IOPV 净值 |
| 🧮 替代金额补算 | 自动 | 缺失的替代金额用昨收价×数量补算 |
| ↕️ 排序 | 点击列头 | 按该列升降序排列 |
| 📥 导出 CSV | 点「导出 CSV」 | 含 BOM 的 UTF-8 CSV，Excel 可直接打开 |
| 📂 载入历史数据 | 点「载入历史数据」 | 选择 JSON 快照文件加载 |

## 🔧 Worker API 详情

`/api/query?code=513310` 内部串联的 API 调用：

1. **上交所成分股** `query.sse.com.cn` → 成分股清单
2. **上交所申赎清单** `query.sse.com.cn` → 交易日信息
3. **SSE yunhq snap** `yunhq.sse.com.cn` → ETF 自身行情 + 成分股昨收价
4. **东财 K-line** `push2his.eastmoney.com` → 备选补算缺失价格
5. **东财 suggest** `searchadapter.eastmoney.com` → ETF 名称降级获取

所有对外请求限并发 5，防止 API 封禁。

## ❓ 常见问题

**Q: 点刷新后返回 502 Bad Gateway？**
A: 上交所 API 有 WAF 防护，可能拦截 CF 边缘节点 IP。Worker 已模拟完整浏览器请求头绕过，如仍失败可以稍后再试。持续失败可能是上交所接口变更。

**Q: 页面空白 / 没有数据？**
A: F12 → Console 看看有没有报错。检查 `data/latest.js` 是否存在。

**Q: 浏览器控制台报 `ERR_BLOCKED_BY_CLIENT`？**
A: 浏览器插件（广告拦截器）拦截了 CDN 资源，不影响功能。

**Q: 「补算」是什么意思？**
A: 上交所每天上午 8:30 更新申赎清单，但部分成分股可能缺失替代金额。Worker 会自动用该股 T-1 收盘价 × 数量补算，并在表格中用 ★ 标记、底色高亮。

---

> 💡 有问题提 Issue，或回家慢慢修。
