# ETF 成分股查看器 — Cloudflare Pages 版

> 🏠 **本版本无需 Python 后端**，可直接部署到 Cloudflare Pages 上运行。
> 适合在公司电脑、平板、手机上直接访问使用。

## 🗺️ 部署总览

```
你电脑 (本地)   ───push──→   GitHub 仓库   ───→   Cloudflare Pages (全球 CDN)
                                                      │
                                                      ├─ 静态文件 (index.html / app.js / style.css)
                                                      └─ Function  ─→ 上交所 API (实时数据)
```

## 📋 前置条件

| 项目 | 说明 |
|------|------|
| GitHub 账号 | 没有的话去 [github.com](https://github.com) 免费注册一个 |
| Cloudflare 账号 | 没有的话去 [dash.cloudflare.com](https://dash.cloudflare.com) 免费注册 |
| 本机 Git | 已安装（`git --version` 验证） |
| 网络 | 🏠 在家操作就行，不需要公司网络 |

---

## 🚀 部署步骤（手把手）

### 第 1 步：在 GitHub 上新建仓库

1. 浏览器打开 https://github.com/new
2. **Repository name** 填 `sse-etf-cf`
3. 选 **Public**（免费就行，Private 也可以）
4. 其他全部默认，点 **Create repository**

### 第 2 步：把本文件夹推送到 GitHub

打开你电脑的终端（命令提示符或 PowerShell），依次执行：

```bash
# 进入 CF 项目目录
cd F:\AtomCode\sse_etf_monitor_cf

# 初始化 Git 仓库
git init

# 添加所有文件
git add .

# 提交
git commit -m "🎉 init: ETF 成分股查看器 CF 版"

# 关联 GitHub 仓库
# （把 yourname 换成你的 GitHub 用户名）
git remote add origin https://github.com/yourname/sse-etf-cf.git

# 推送到 GitHub
git push -u origin main
```

> 🔑 如果提示登录，按提示在浏览器中登录 GitHub 授权即可。

### 第 3 步：在 Cloudflare Pages 部署

1. 浏览器打开 https://dash.cloudflare.com/ → 登录
2. 左侧菜单选 **Workers & Pages**
3. 点 **Pages** 标签（不是 Workers）
4. 点蓝色按钮 **连接到 Git**
5. 如果没连过 GitHub，点 **连接 GitHub** → 授权 Cloudflare 访问你的仓库
6. 在弹出的仓库列表中找到 `sse-etf-cf` → 点 **开始设置**

### 第 4 步：构建设置

| 设置项 | 值 |
|--------|-----|
| 项目名称 | 自动生成，也可以改成 `sse-etf` |
| 框架预设 | **None** |
| 构建命令 | **留空**（不需要） |
| 构建输出目录 | **`/`**（根目录，默认就是这个） |
| 根目录 | **留空** |

其他都不用管 → 点 **保存并部署**

### 第 5 步：等待部署完成

⏳ 等大约 30 秒，看到绿色 **✅ 部署成功** 就搞定了。

点那个 **访问站点** 按钮（或者分配给你的域名，类似 `sse-etf-xxx.pages.dev`），就能看到页面了。

---

## ✅ 验证功能

| 功能 | 怎么测试 | 预期结果 |
|------|---------|---------|
| 初始数据 | 打开页面 | 显示成分股列表 |
| 🔍 搜索 | 在搜索框输入股票代码 | 表格实时过滤 |
| 🏆 前五大权重 | 看页面顶部 | 按权重排序显示前 5 |
| 🔄 实时刷新 | 点 **刷新** 按钮 | 等待片刻，数据更新（右上角日期变化） |
| 📥 导出 CSV | 点 **导出 CSV** | 浏览器下载一个 CSV 文件，可用 Excel 打开 |

---

## 📁 文件结构

```
sse_etf_monitor_cf/
├── index.html              # 🌐 主页面
├── style.css               # 🎨 样式表
├── app.js                  # ⚡ 前端逻辑（搜索/排序/导出/刷新）
├── data/
│   └── latest.js           # 📦 初始成分股快照（静态数据）
├── functions/
│   └── api/
│       └── query.js        # 🔌 Cloudflare Function — 代理上交所实时接口
└── README.md               # 📖 本说明文件
```

---

## 🔧 后续维护

### 更新初始快照

如果你从 Python 版导出新的 JSON 快照，想替换 CF 版的初始数据：

```bash
# 1. 把导出的 JSON 复制到 data/ 目录下
# 2. 手动编辑 data/latest.js，把文件内容改成：
window.__ETF_LATEST = { ...你的 JSON 数据... };

# 3. 推送到 GitHub
git add .
git commit -m "📦 更新初始快照"
git push
```

CF 会自动重新部署，约 1 分钟后生效。

### 修改基金代码

默认监控 `513310`，如果想改成别的 ETF：

- 编辑 `data/latest.js` 里的 `fundCode` 字段
- 编辑 `functions/api/query.js` 第 10 行的默认值 `"513310"`
- 提交推送即可

### 本地预览（可选）

需要安装 Wrangler CLI：

```bash
npx wrangler pages dev . --port 8800
```

然后浏览器访问 http://localhost:8800

---

## ❓ 常见问题

**Q: 点刷新后等很久才出数据？**
A: CF 免费版有冷启动，第一次请求需要 1–3 秒加载 Function 运行环境。之后再用就快了。你也可以在 Cloudflare Dashboard 把这个项目升级到付费 Worker（$5/月）就没冷启动了。

**Q: 页面空白 / 没有数据？**
A: 检查浏览器控制台（F12 → Console）有没有报错。常见原因：
- 部署时构建输出目录没选对（应该是 `/`）
- `data/latest.js` 文件缺失

**Q: 可以在手机上访问吗？**
A: 可以！部署成功后给你的那个 `*.pages.dev` 链接在任何浏览器都能打开，手机平板都行。

**Q: 公司电脑能访问吗？**
A: 可以，CF 部署在全球 CDN 上，任何有网络的设备都能打开。**但「刷新」功能依赖 CF Function 去抓上交所——如果公司网络限制了出口，Function 是跑在 CF 服务器上的，不影响。**

---

> 💡 有任何问题，回家继续搞就行，这堆文件扔这儿跑不了。
