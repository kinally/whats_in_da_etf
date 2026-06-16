/* ========== app.js ========== */

let allData = [];         // 当前展示的原始数组
let fullPackage = null;   // 完整的 JSON 包
let sortKey = "QUANTITY";
let sortAsc = false;

/* ---------- 初始化: 从 latest.js 加载 ---------- */
function initFromGlobals() {
  if (typeof ETF_DATA !== "undefined" && ETF_DATA && ETF_DATA.components) {
    fullPackage = ETF_DATA;
    allData = ETF_DATA.components;
    renderAll();
  }
  // else: DOMContentLoaded 安全兜底——可能在 DOM 前调用了
}

/* ---------- 主渲染入口 ---------- */
function renderAll() {
  if (!fullPackage || !allData.length) return;
  renderHeader(fullPackage);
  renderStats(allData);
  renderTopHoldings(allData);
  renderTable(allData);
}

/* ---------- Header ---------- */
function renderHeader(pkg) {
  document.getElementById("etfCode").textContent = pkg.fundCode;
  // ETF 名称
  const nameEl = document.getElementById("etfName");
  if (pkg.etfName) {
    nameEl.textContent = pkg.etfName;
    nameEl.style.display = "";
  } else {
    nameEl.textContent = "";
    nameEl.style.display = "none";
  }
  // ETF 价格参考（最新价/涨跌幅/IOPV）
  const priceEl = document.getElementById("etfPriceInfo");
  if (pkg.etfPrice && pkg.etfPrice.last != null) {
    const p = pkg.etfPrice;
    const chgCls = p.chgRate >= 0 ? 'chg-up' : 'chg-down';
    const chgSign = p.chgRate >= 0 ? '+' : '';
    priceEl.innerHTML =
      `<span class="price-last">${p.last.toFixed(3)}</span>` +
      `<span class="${chgCls}">${chgSign}${p.chgRate.toFixed(2)}%</span>` +
      `<span class="price-iopv">IOPV ${p.iopv.toFixed(4)}</span>`;
    priceEl.style.display = "";
  } else {
    priceEl.style.display = "none";
  }
  // 查询日期 + 清单交易日
  const dateHtml = "📅 " + escapeHtml(pkg.fetchedAt)
    + (pkg.listDate ? ' <span class="list-date">📋 ' + escapeHtml(pkg.listDate) + ' 申赎清单</span>' : '');
  document.getElementById("fetchDate").innerHTML = dateHtml;
}

/* ---------- Stats ---------- */
function renderStats(data) {
  const sse = data.filter(d => d._MARKET_CN === "上交所").length;
  const szse = data.filter(d => d._MARKET_CN === "深交所").length;
  const oversea = data.filter(d => d._MARKET_CN === "境外").length;
  const computed = data.filter(d => d._AMOUNT_SOURCE === "calc").length;

  document.getElementById("statTotal").textContent = data.length;
  document.getElementById("statSse").textContent = sse;
  document.getElementById("statSzse").textContent = szse;
  document.getElementById("statOversea").textContent = oversea;
  document.getElementById("statComputed").textContent = computed;
}

/* ---------- Top 5 Holdings ---------- */
function renderTopHoldings(data) {
  const sorted = [...data].sort((a, b) => parseNum(b.SUBSTITUTION_CASH_AMOUNT) - parseNum(a.SUBSTITUTION_CASH_AMOUNT));
  const top5 = sorted.slice(0, 5);
  const totalAmt = data.reduce((s, d) => s + parseNum(d.SUBSTITUTION_CASH_AMOUNT), 0);

  const list = document.getElementById("topList");
  list.innerHTML = top5.map((item, i) => {
    const rankEmoji = ["🥇","🥈","🥉","4️⃣","5️⃣"][i] || `${i+1}.`;
    const amt = parseNum(item.SUBSTITUTION_CASH_AMOUNT);
    const pct = totalAmt > 0 ? (amt / totalAmt * 100) : 0;
    return `
      <div class="top-item">
        <span class="top-rank">${rankEmoji}</span>
        <div class="top-info">
          <div class="top-name">${escapeHtml(item.INSTRUMENT_NAME)}</div>
          <div class="top-code">${escapeHtml(item.INSTRUMENT_ID)}</div>
        </div>
        <span class="top-market">${escapeHtml(item._MARKET_CN)}</span>
        <span class="top-qty">${fmtNum(item.QUANTITY)} 股</span>
        <span class="top-pct">${pct.toFixed(2)}%</span>
      </div>`;
  }).join("");
}

/* ---------- Table ---------- */
function renderTable(data, sortKey_, sortAsc_) {
  sortKey = sortKey_ || sortKey;
  sortAsc = sortAsc_ !== undefined ? sortAsc_ : sortAsc;

  const totalSubCash = data.reduce((s, d) => s + parseNum(d.SUBSTITUTION_CASH_AMOUNT), 0);

  const sorted = [...data].sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (sortKey === "QUANTITY" || sortKey === "SUBSTITUTION_CASH_AMOUNT") {
      va = parseNum(va);
      vb = parseNum(vb);
    } else {
      va = (va || "").toString();
      vb = (vb || "").toString();
    }
    return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });

  const tbody = document.getElementById("tableBody");
  tbody.innerHTML = sorted.map(item => {
    const mktClass = item._MARKET_CN === "上交所" ? "sse"
      : item._MARKET_CN === "深交所" ? "szse" : "oversea";
    const subCashPct = totalSubCash > 0 ? (parseNum(item.SUBSTITUTION_CASH_AMOUNT) / totalSubCash * 100) : 0;
    const isCalc = item._AMOUNT_SOURCE === "calc";
    const amtClass = isCalc ? 'num amt-calc' : 'num amt-api';
    const calcStar = isCalc ? ' ★' : '';
    return `<tr${isCalc ? ' class="row-calc"' : ''}>
      <td>${escapeHtml(item.INSTRUMENT_ID)}${calcStar}</td>
      <td><strong>${escapeHtml(item.INSTRUMENT_NAME)}</strong></td>
      <td class="num">${fmtNum(item.QUANTITY)}</td>
      <td class="${amtClass}">${fmtMoney(item.SUBSTITUTION_CASH_AMOUNT)}</td>
      <td class="num">${subCashPct.toFixed(2)}%</td>
      <td><span class="market-tag ${mktClass}">${escapeHtml(item._MARKET_CN)}</span></td>
    </tr>`;
  }).join("");

  // 更新排序箭头
  document.querySelectorAll(".data-table th").forEach(th => {
    const key = th.dataset.sort;
    th.classList.remove("sorted-asc", "sorted-desc");
    if (key === sortKey) {
      th.classList.add(sortAsc ? "sorted-asc" : "sorted-desc");
    }
  });
}

/* ---------- 点击列头排序 ---------- */
document.addEventListener("click", function(e) {
  const th = e.target.closest("th[data-sort]");
  if (!th) return;
  try {
    const key = th.dataset.sort;
    if (key === sortKey) sortAsc = !sortAsc;
    else { sortKey = key; sortAsc = true; }
    const query = document.getElementById("searchBox").value;
    const filtered = filterData(allData, query);
    renderTable(filtered, sortKey, sortAsc);
  } catch (err) {
    console.error("排序出错:", err);
  }
});

/* ---------- 搜索过滤 ---------- */
function filterTable() {
  const query = document.getElementById("searchBox").value;
  const filtered = filterData(allData, query);
  renderTable(filtered, sortKey, sortAsc);
}

function filterData(data, query) {
  if (!query) return data;
  const q = query.trim().toLowerCase();
  return data.filter(d =>
    (d.INSTRUMENT_ID || "").toLowerCase().includes(q) ||
    (d.INSTRUMENT_NAME || "").toLowerCase().includes(q)
  );
}

/* ---------- 文件选择器 ---------- */
function loadFromFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const pkg = JSON.parse(e.target.result);
      if (!pkg.components || !pkg.components.length) throw new Error("empty");
      fullPackage = pkg;
      allData = pkg.components;
      document.getElementById("searchBox").value = "";
      renderAll();
    } catch (err) {
      alert("❌ 文件格式不对，请选择由 fetch_etf.py 生成的 JSON 文件");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

/* ---------- 刷新最新数据（调服务器 API 真实抓取） ---------- */
async function reloadLatest() {
  // 输入框有值就当作 ETF 代码查询，否则用当前基金代码
  const searchBox = document.getElementById("searchBox");
  const code = (searchBox && searchBox.value.trim()) || (fullPackage ? fullPackage.fundCode : "");
  if (!code) return alert("❌ 请在搜索框输入基金代码");

  const btn = document.querySelector(".reload-btn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ 刷新中..."; }

  try {
    const resp = await fetch(`/api/query?code=${code}`);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);

    const rows = data.rows || [];

    fullPackage = {
      fundCode: code,
      etfName: data.etfName || "",
      listDate: data.listDate || "",
      etfPrice: data.etfPrice || null,
      fetchedAt: new Date().toISOString().slice(0, 10),
      components: rows
    };
    allData = rows;
    // 如果搜索框里是刚才查询的ETF代码，清空它（避免排序时被过滤成空表）
    const sb = document.getElementById("searchBox");
    if (sb && sb.value.trim() === code) {
      sb.value = "";
    }
    renderAll();
  } catch (e) {
    alert("❌ 刷新失败: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔄 刷新"; }
  }
}

/* ---------- 空状态 ---------- */
function showEmpty(msg) {
  document.getElementById("app").innerHTML = `
    <div class="empty-state">
      <div style="font-size:48px;margin-bottom:12px;">📭</div>
      <p>${msg}</p>
    </div>`;
}

/* ---------- 导出 CSV ---------- */
function exportData() {
  if (!allData || !allData.length) return alert("❌ 没有可导出的数据");

  const pkg = fullPackage || {};
  const fundCode = pkg.fundCode || "ETF";
  const etfName = pkg.etfName || "";
  const fetchedAt = pkg.fetchedAt || "";

  // 列头
  const headers = ["代码", "名称", "数量", "替代金额(元)", "金额占比", "市场", "替代标志"];
  // 字段映射
  const fields = ["INSTRUMENT_ID", "INSTRUMENT_NAME", "QUANTITY",
                   "SUBSTITUTION_CASH_AMOUNT", "_SUB_CASH_PCT", "_MARKET_CN", "_FLAG_CN"];

  const esc = v => {
    const s = (v || "").toString().trim();
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  // 元数据头（加 # 号可被Excel/Sheets忽略）
  const meta = [
    `# ETF: ${fundCode} ${etfName}  |  ${fetchedAt}`,
    `# 成分股数: ${allData.length}`,
    ""
  ];

  // 计算总替代金额，用于金额占比
  const totalSubCash = allData.reduce((s, d) => s + parseNum(d.SUBSTITUTION_CASH_AMOUNT), 0);

  const rows = allData.map(row => {
    const subCashPct = totalSubCash > 0 ? (parseNum(row.SUBSTITUTION_CASH_AMOUNT) / totalSubCash * 100).toFixed(2) + "%" : "0.00%";
    return fields.map(f => {
      if (f === "_SUB_CASH_PCT") return esc(subCashPct);
      return esc(row[f]);
    }).join(",");
  });

  const csv = meta.join("\n") + headers.join(",") + "\n" + rows.join("\n");

  // 下载
  const bom = "\uFEFF"; // BOM 让 Excel 正确识别 UTF-8
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const today = new Date().toISOString().slice(0, 10);
  a.download = `${fundCode}_${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------- 工具函数 ---------- */
function parseNum(v) {
  if (!v) return 0;
  const s = v.toString().replace(/,/g, "").trim();
  return parseFloat(s) || 0;
}

function fmtNum(v) {
  if (!v) return "0";
  const n = parseNum(v);
  return n.toLocaleString("zh-CN");
}

function fmtMoney(v) {
  if (!v) return "-";
  const s = v.toString().trim();
  if (!s || s === '-') return "-";
  const n = parseFloat(s);
  if (isNaN(n)) return "-";
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(s) {
  if (!s) return "";
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ---------- 安全初始兜底 ---------- */
document.addEventListener("DOMContentLoaded", function() {
  // 如果 onload 已经触发了，data 已经有了，这里不会重复渲染
  if (!allData || !allData.length) {
    setTimeout(initFromGlobals, 50);
  }
});
