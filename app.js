/* Finance Review - iPad web app.
   Same data file as the Windows app (OneDrive/Finance Review/finance.db), opened in the browser with SQLite. */
"use strict";

// ============================================================ settings
const CONFIG = {
  clientId: "73da0106-c7c4-4cb3-9589-d4f52d7dd817",                                  // Microsoft app (client) ID - can also be set in More > Settings
  filePath: "Finance Review/finance.db",         // in OneDrive, same as the Windows app
  authority: "https://login.microsoftonline.com/consumers/oauth2/v2.0",
  scopes: "Files.ReadWrite User.Read offline_access",
};
const NON_SPENDING = new Set(FR.nonSpending);
const INCOME = new Set(FR.incomeCats);
const LIABILITY = new Set(FR.liabilityTypes);

// ============================================================ small helpers
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}
const money = (v, signed) => {
  const s = "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < -0.004 ? "-" + s : (signed && v > 0.004 ? "+" + s : s);
};
const kfmt = v => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `$${Math.round(a / 1e3)}k` : a >= 1e3 ? `$${(a / 1e3).toFixed(1)}k` : `$${Math.round(a)}`;
  return v < 0 ? "-" + s : s;
};
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseISO = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const days = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const monthName = (ym, long) => new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1)
  .toLocaleString("en-US", long ? { month: "long", year: "numeric" } : { month: "short", year: "2-digit" });
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(k); } catch { } },
};

function toast(msg, ms = 3000) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function sheet(title, body, actions = []) {
  $("#sheetTitle").textContent = title;
  const b = $("#sheetBody"); b.replaceChildren(body);
  const a = $("#sheetActions"); a.replaceChildren(...actions);
  $("#sheetWrap").hidden = false;
}
function closeSheet() { $("#sheetWrap").hidden = true; }
$("#sheetClose").onclick = closeSheet;
$("#sheetWrap").addEventListener("click", e => { if (e.target.id === "sheetWrap") closeSheet(); });
function confirmSheet(title, text, okText, fn, danger) {
  sheet(title, h("p", {}, text), [
    h("button", { class: "btn", onclick: closeSheet }, "Cancel"),
    h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => { closeSheet(); fn(); } }, okText)]);
}
function showTip(x, y, html) {
  const t = $("#tip"); t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, hh = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + "px";
  t.style.top = Math.max(8, y - hh - 12) + "px";
  clearTimeout(showTip._t); showTip._t = setTimeout(() => (t.hidden = true), 3500);
}
document.addEventListener("scroll", () => ($("#tip").hidden = true), true);

// ============================================================ database
let SQL, db;
function q(sql, p = []) {
  const st = db.prepare(sql); st.bind(p); const out = [];
  while (st.step()) out.push(st.getAsObject());
  st.free(); return out;
}
const one = (sql, p) => q(sql, p)[0];
function run(sql, p = []) { db.run(sql, p); markDirty(); }

function openDb(bytes) {
  db = bytes ? new SQL.Database(new Uint8Array(bytes)) : new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  db.exec(FR.schema);
  const seeded = one("SELECT value FROM settings WHERE key='seeded'");
  if (!seeded) {
    const st = db.prepare("INSERT INTO rules(pattern, category, owner, priority) VALUES (?,?,?,0)");
    for (const [p, c, o] of FR.rules) st.run([p, c, o]);
    st.free();
    db.run("INSERT OR REPLACE INTO settings VALUES ('seeded','1')");
  }
}
const getSetting = k => one("SELECT value FROM settings WHERE key=?", [k])?.value;
const accounts = owner => q("SELECT * FROM accounts WHERE archived=0" + (owner && owner !== "All" ? " AND owner=?" : "") +
  " ORDER BY owner, type, name", owner && owner !== "All" ? [owner] : []);
function txns({ owner, start, end, account, search, category } = {}) {
  let s = "SELECT t.*, a.name AS account, a.owner AS owner, a.type AS account_type FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE 1=1";
  const p = [];
  if (owner && owner !== "All") { s += " AND a.owner=?"; p.push(owner); }
  if (start) { s += " AND t.date>=?"; p.push(start); }
  if (end) { s += " AND t.date<=?"; p.push(end); }
  if (account) { s += " AND t.account_id=?"; p.push(account); }
  if (category) { s += " AND t.category=?"; p.push(category); }
  if (search) { s += " AND (t.description LIKE ? OR t.note LIKE ?)"; p.push(`%${search}%`, `%${search}%`); }
  return q(s + " ORDER BY t.date DESC, t.id DESC", p);
}
const rules = () => q("SELECT * FROM rules ORDER BY priority DESC, LENGTH(pattern) DESC");
function categoryList() {
  const s = new Set(FR.categories);
  for (const t of ["transactions", "rules", "budgets"]) for (const r of q(`SELECT DISTINCT category FROM ${t}`)) s.add(r.category);
  return [...s].sort((a, b) => (a === "Uncategorized") - (b === "Uncategorized") || a.localeCompare(b));
}

// ============================================================ categorizing (same logic as desktop)
const norm = s => (s || "").toUpperCase().replace(/\s+/g, " ").trim();
const rxCache = new Map();
function ruleMatches(pattern, d) {
  let rx = rxCache.get(pattern);
  if (!rx) {
    const p = norm(pattern), esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pre = /[A-Z0-9]/.test(p[0] || "") ? "(?:^|[^A-Z0-9])" : "";
    const post = /[A-Z0-9]/.test(p[p.length - 1] || "") ? "(?![A-Z0-9])" : "";
    rx = new RegExp(pre + esc + post); rxCache.set(pattern, rx);
  }
  return rx.test(d);
}
function categorize(desc, owner, amount, rs) {
  const d = norm(desc);
  for (const r of rs) {
    if (r.owner && r.owner !== owner) continue;
    if (ruleMatches(r.pattern, d)) {
      if (r.category === "Income" && amount < 0) continue;
      return r.category;
    }
  }
  if (amount > 0 && (d.includes("DEPOSIT") || d.includes("ACH CREDIT"))) return "Income";
  return "Uncategorized";
}
function applyRules() {
  const rs = rules(); let n = 0;
  db.run("BEGIN");
  for (const t of txns()) {
    if (t.cat_manual) continue;
    const c = categorize(t.description, t.owner, t.amount, rs);
    if (c !== t.category) { db.run("UPDATE transactions SET category=? WHERE id=?", [c, t.id]); n++; }
  }
  db.run("COMMIT"); markDirty();
  return n;
}

// ============================================================ analysis (ported from analysis.py)
const PREFIX_RX = new RegExp("^(" + ["POS (PURCHASE|DEBIT)?", "DEBIT CARD PURCHASE", "PURCHASE AUTHORIZED ON \\d\\d/\\d\\d",
  "CHECKCARD \\d+", "RECURRING PAYMENT AUTHORIZED ON \\d\\d/\\d\\d", "ACH (DEBIT|WITHDRAWAL)", "PREAUTHORIZED DEBIT",
  "SQ ?\\*", "TST ?\\*", "PAYPAL ?\\*", "PP ?\\*", "SP ?\\*", "DD ?\\*", "WWW\\.", "ELECTRONIC PMT-WEB"].join("|") + ")\\s*");
function merchantKey(desc) {
  let d = (desc || "").toUpperCase();
  for (let i = 0; i < 2; i++) d = d.trim().replace(PREFIX_RX, "");
  d = d.replace(/https?:\/\//g, "")
    .replace(/\b\d{3}[- ]?\d{3}[- ]?\d{4}\b/g, " ")
    .replace(/#\s*\d+|\b[A-Z]*\d[\w*-]*\b/g, " ")
    .replace(/\b(CA|NV|AZ|TX|OR|WA|USA?|US)\b\s*$/, " ")
    .replace(/[^A-Z&'.* -]/g, " ");
  const w = d.split(/\s+/).filter(x => x.length > 1 || x === "&");
  return w.slice(0, 3).join(" ") || (desc || "").toUpperCase().slice(0, 20);
}
const spendingRows = ts => ts.filter(t => !NON_SPENDING.has(t.category));
function byCategory(ts) {
  const m = new Map();
  for (const t of spendingRows(ts)) m.set(t.category, (m.get(t.category) || 0) - t.amount);
  return [...m].filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
}
function summary(ts) {
  const income = ts.filter(t => INCOME.has(t.category)).reduce((s, t) => s + t.amount, 0);
  const spend = spendingRows(ts).reduce((s, t) => s - t.amount, 0);
  return { income, spending: spend, net: income - spend };
}
function monthly(ts) {
  const m = {};
  for (const t of ts) {
    const k = t.date.slice(0, 7); m[k] ||= { income: 0, spending: 0 };
    if (INCOME.has(t.category)) m[k].income += t.amount;
    else if (!NON_SPENDING.has(t.category)) m[k].spending -= t.amount;
  }
  return Object.fromEntries(Object.entries(m).sort());
}
function topMerchants(ts, n = 10) {
  const tot = new Map(), cnt = new Map();
  for (const t of spendingRows(ts)) { const k = merchantKey(t.description); tot.set(k, (tot.get(k) || 0) - t.amount); cnt.set(k, (cnt.get(k) || 0) + 1); }
  return [...tot].filter(([, v]) => v > 0).map(([k, v]) => [k, v, cnt.get(k)]).sort((a, b) => b[1] - a[1]).slice(0, n);
}
const FREQS = [["Weekly", 7, 5, 9, 52], ["Every 2 weeks", 14, 12, 17, 26], ["Monthly", 30.4, 26, 35, 12],
  ["Quarterly", 91, 82, 100, 4], ["Yearly", 365, 340, 390, 1]];
function recurring(ts, asOf) {
  const groups = new Map();
  for (const t of ts) {
    if (t.amount >= 0 || t.category === "Transfer" || t.category === "Credit Card Payment") continue;
    const k = [t.owner, t.account, merchantKey(t.description)].join("\u0001");
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t);
  }
  const out = [];
  for (const [k, g] of groups) {
    const [owner, account, merch] = k.split("\u0001");
    g.sort((a, b) => a.date.localeCompare(b.date));
    if (g.length < 2) continue;
    const dates = g.map(t => t.date), amts = g.map(t => -t.amount);
    const gaps = []; for (let i = 1; i < dates.length; i++) { const d = days(dates[i - 1], dates[i]); if (d > 0) gaps.push(d); }
    if (!gaps.length) continue;
    const mg = median(gaps);
    const f = FREQS.find(f => f[2] <= mg && mg <= f[3]); if (!f) continue;
    const [name, period, lo, hi, perYear] = f;
    if (g.length < (name === "Yearly" ? 2 : 3)) continue;
    const onSched = gaps.filter(x => lo <= x && x <= hi).length / gaps.length;
    const ma = median(amts);
    const steady = amts.filter(a => Math.abs(a - ma) <= Math.max(1, 0.2 * ma)).length / amts.length;
    if (onSched < 0.6 || steady < 0.6) continue;
    const last = dates.at(-1), lastAmt = amts.at(-1), prev = amts.slice(0, -1).slice(-6);
    const flags = [];
    if (prev.length && lastAmt > median(prev) * 1.05 + 0.5) flags.push(`Price up +${(lastAmt - median(prev)).toFixed(2)}`);
    const overdue = days(last, asOf) > hi * 1.5;
    if (overdue) flags.push("Stopped? (no recent charge)");
    out.push({ merchant: merch, owner, account, frequency: name, amount: lastAmt, count: g.length, last,
      next: addDays(last, Math.round(period)), yearly: overdue ? 0 : lastAmt * perYear, monthly: overdue ? 0 : lastAmt * perYear / 12,
      category: g.at(-1).category, flags: flags.join(", "), active: !overdue });
  }
  return out.sort((a, b) => (a.active === b.active ? b.yearly - a.yearly : a.active ? -1 : 1));
}
function duplicates(ts) {
  const by = new Map();
  for (const t of ts) {
    if (t.amount >= 0 || t.category === "Transfer" || t.category === "Credit Card Payment") continue;
    const k = [t.account_id, merchantKey(t.description), t.amount.toFixed(2)].join("|");
    if (!by.has(k)) by.set(k, []); by.get(k).push(t);
  }
  const out = [];
  for (const g of by.values()) {
    g.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < g.length; i++) {
      const d = days(g[i - 1].date, g[i].date);
      if (d >= 0 && d <= 3 && Math.abs(g[i].amount) >= 5) out.push([g[i - 1], g[i]]);
    }
  }
  return out.sort((a, b) => b[1].date.localeCompare(a[1].date));
}
function latestSnapshot(id) { return one("SELECT date, balance FROM balance_snapshots WHERE account_id=? ORDER BY date DESC, id DESC LIMIT 1", [id]); }
function balanceOn(acc, on = "9999-12-31") {
  const snap = latestSnapshot(acc.id);
  const sum = (a, b) => one("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id=? AND date>? AND date<=?", [acc.id, a, b]).s;
  if (snap) return on >= snap.date ? snap.balance + sum(snap.date, on) : snap.balance - sum(on, snap.date);
  return acc.opening_balance + one("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id=? AND date<=?", [acc.id, on]).s;
}
function netWorth(owner, on) {
  let assets = 0, liab = 0; const rows = [];
  for (const a of accounts(owner)) {
    const b = balanceOn(a, on); rows.push([a, b]);
    if (LIABILITY.has(a.type) || b < 0) liab += -b; else assets += b;
  }
  return { assets, liabilities: liab, net: assets - liab, rows };
}
function monthEnds(lo, hi) {
  const out = []; let y = +lo.slice(0, 4), m = +lo.slice(5, 7);
  while (true) {
    const me = iso(new Date(y, m, 0)); out.push(me < hi ? me : hi);
    if (me >= hi) break; m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function netWorthHistory(owner) {
  const r = one("SELECT MIN(date) AS lo, MAX(date) AS hi FROM transactions");
  if (!r || !r.lo) return [];
  return monthEnds(r.lo, r.hi).map(d => [d, netWorth(owner, d).net]);
}
function budgetsFor(owner) { return Object.fromEntries(q("SELECT category, monthly_amount FROM budgets WHERE owner=?", [owner]).map(r => [r.category, r.monthly_amount])); }
function budgetReport(owner, ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const start = ym + "-01", end = iso(new Date(y, m, 0));
  const owners = owner === "All" ? ["Personal", "Business"] : [owner];
  const budgets = {};
  for (const o of owners) for (const [c, v] of Object.entries(budgetsFor(o))) budgets[c] = (budgets[c] || 0) + v;
  const actual = Object.fromEntries(byCategory(txns({ owner, start, end })));
  const s3 = iso(new Date(y, m - 4, 1)), e3 = iso(new Date(y, m - 1, 0));
  const avg = Object.fromEntries(byCategory(txns({ owner, start: s3, end: e3 })).map(([c, v]) => [c, v / 3]));
  const cats = [...new Set([...Object.keys(budgets), ...Object.keys(actual)])]
    .sort((a, b) => (budgets[b] || 0) - (budgets[a] || 0) || (actual[b] || 0) - (actual[a] || 0));
  return { rows: cats.map(c => ({ category: c, budget: budgets[c] || 0, actual: actual[c] || 0, avg3: avg[c] || 0 })), end };
}

// ============================================================ importing (CSV + QFX/OFX)
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function parseDate(s) {
  s = (s || "").trim().replace(/^"|"$/g, ""); if (!s) return null;
  let m, y, mo, d;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/))) [, y, mo, d] = m.map(Number);
  else if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(\s|$)/))) { [, mo, d, y] = m.map(Number); if (y < 100) y += y < 70 ? 2000 : 1900; }
  else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) [, y, mo, d] = m.map(Number);
  else if ((m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]+(\d{4})/))) { d = +m[1]; mo = MON[m[2].toUpperCase()] + 1; y = +m[3]; }
  else if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/))) { mo = MON[m[1].toUpperCase()] + 1; d = +m[2]; y = +m[3]; }
  else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1900)) return null;
  const dt = new Date(y, mo - 1, d); return dt.getMonth() === mo - 1 ? iso(dt) : null;
}
function parseAmount(s) {
  if (s == null) return null;
  s = String(s).trim().replace(/[$,\s]/g, ""); if (!s || s === "-" || s === "--") return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
  if (/CR$/i.test(s)) s = s.slice(0, -2); else if (/DR$/i.test(s)) { neg = true; s = s.slice(0, -2); }
  if (s.endsWith("-")) { neg = true; s = s.slice(0, -1); }
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const v = parseFloat(s); return neg ? -Math.abs(v) : v;
}
function parseCsvText(text) {
  text = text.replace(/^﻿/, "");
  const sample = text.split(/\r?\n/).slice(0, 10).join("\n");
  const delim = [",", ";", "\t", "|"].map(c => [c, sample.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c; }
    else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
class CsvFile {
  constructor(text) {
    const rows = parseCsvText(text);
    this.headerIndex = null;
    for (let i = 0; i < Math.min(15, rows.length); i++) {
      const low = rows[i].map(c => c.trim().toLowerCase());
      if (rows[i].length >= 2 && low.some(c => c.includes("date")) && !rows[i].some(c => parseDate(c))) { this.headerIndex = i; break; }
    }
    if (this.headerIndex == null) {
      const cnt = {}; rows.forEach(r => (cnt[r.length] = (cnt[r.length] || 0) + 1));
      const n = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
      this.headers = Array.from({ length: n }, (_, i) => `Column ${i + 1}`);
      this.data = rows.filter(r => r.length === n);
    } else {
      this.headers = rows[this.headerIndex].map((x, i) => x.trim() || `Column ${i + 1}`);
      this.data = rows.slice(this.headerIndex + 1).filter(r => r.length >= this.headers.length - 1);
    }
    this.mapping = this.guess();
  }
  col(i, n = 30) { return this.data.slice(0, n).map(r => r[i] ?? ""); }
  guess() {
    const low = this.headers.map(x => x.toLowerCase());
    const find = (hints, ex = []) => { for (const hint of hints) for (let i = 0; i < low.length; i++) if (!ex.includes(i) && (low[i] === hint || low[i].includes(hint))) return i; return null; };
    const m = { date: find(["transaction date", "trans date", "posting date", "post date", "posted date", "date"]), description: null, amount: null, debit: null, credit: null };
    if (this.headerIndex == null) {
      for (let i = 0; i < this.headers.length; i++) { const v = this.col(i); if (m.date == null && v.filter(x => parseDate(x)).length > v.length * .8) m.date = i; }
      for (let i = 0; i < this.headers.length; i++) { const v = this.col(i); if (i !== m.date && m.amount == null && v.filter(x => parseAmount(x) != null).length > v.length * .8) m.amount = i; }
      let best = -1;
      for (let i = 0; i < this.headers.length; i++) if (i !== m.date && i !== m.amount) { const L = this.col(i).join("").length; if (L > best) { best = L; m.description = i; } }
      return m;
    }
    m.description = find(["description", "payee", "merchant", "name", "memo", "details", "transaction"], [m.date]);
    const used = [m.date, m.description];
    const amt = find(["amount", "transaction amount", "amt"], used);
    const deb = find(["debit", "withdrawal", "withdrawals", "charge", "charges", "money out", "payment amount"], used);
    const cred = find(["credit", "deposit", "deposits", "money in", "payments/credits"], used);
    if (deb != null && cred != null && deb !== cred && (amt == null || low[deb].includes("debit"))) { m.debit = deb; m.credit = cred; } else m.amount = amt;
    return m;
  }
  parse(m = this.mapping, flip = false) {
    const out = []; let bad = 0;
    for (const r of this.data) {
      const col = k => (m[k] != null && m[k] < r.length ? r[m[k]] : "");
      const d = parseDate(col("date"));
      let amt;
      if (m.debit != null || m.credit != null) {
        const de = parseAmount(col("debit")), cr = parseAmount(col("credit"));
        amt = de == null && cr == null ? null : Math.abs(cr || 0) - Math.abs(de || 0);
      } else amt = parseAmount(col("amount"));
      if (!d || amt == null) { bad++; continue; }
      out.push({ date: d, description: col("description").replace(/\s+/g, " ").trim() || "(no description)", amount: flip ? -amt : amt });
    }
    return { rows: out, bad };
  }
}
function parseOfx(text) {
  const tag = (b, n) => (b.match(new RegExp(`<${n}>([^<\\r\\n]*)`, "i")) || [])[1]?.trim() || "";
  const rows = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi; let m;
  while ((m = re.exec(text))) {
    const b = m[1], d = parseDate(tag(b, "DTPOSTED").slice(0, 8)), amt = parseAmount(tag(b, "TRNAMT"));
    if (!d || amt == null) continue;
    const name = tag(b, "NAME"), memo = tag(b, "MEMO");
    rows.push({ date: d, description: (!memo || name.includes(memo) ? name : `${name} ${memo}`).trim() || "(no description)", amount: amt, fitid: tag(b, "FITID") });
  }
  let balance = null; const lb = text.match(/<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i);
  if (lb) { const b = parseAmount(tag(lb[1], "BALAMT")), d = parseDate(tag(lb[1], "DTASOF").slice(0, 8)); if (b != null && d) balance = [d, b]; }
  return { rows, balance };
}
const shouldFlip = (rows, type) => (type === "Credit Card" || type === "Loan") && rows.length && rows.filter(r => r.amount > 0).length > rows.length * 0.6;
async function sha1(s) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function makeHashes(rows, accId) {
  const seen = new Map();
  for (const r of rows) {
    let key;
    if (r.fitid) key = `fitid|${r.fitid}`;
    else {
      const base = `${r.date}|${r.amount.toFixed(2)}|${r.description.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
      seen.set(base, (seen.get(base) || 0) + 1); key = `${base}|${seen.get(base)}`;
    }
    r.hash = await sha1(`${accId}|${key}`);
  }
  return rows;
}
function insertTxns(accId, rows, filename) {
  db.run("INSERT INTO imports(account_id, filename) VALUES (?,?)", [accId, filename]);
  const imp = one("SELECT last_insert_rowid() AS id").id;
  let added = 0;
  db.run("BEGIN");
  for (const t of rows) {
    db.run("INSERT OR IGNORE INTO transactions(account_id, date, description, amount, hash, import_id) VALUES (?,?,?,?,?,?)",
      [accId, t.date, t.description, Math.round(t.amount * 100) / 100, t.hash, imp]);
    added += db.getRowsModified();
  }
  db.run("COMMIT");
  db.run("UPDATE imports SET added=?, skipped=? WHERE id=?", [added, rows.length - added, imp]);
  markDirty();
  return [added, rows.length - added];
}

// ============================================================ OneDrive sign-in (PKCE, no secrets in the page)
const auth = {
  clientId() { return CONFIG.clientId || store.get("fr.clientId", ""); },
  redirect() { return location.origin + location.pathname; },
  b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  async signIn() {
    if (!this.clientId()) { toast("Add your Microsoft app ID in More > Settings first."); setTab("more"); return; }
    const verifier = this.b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = this.b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = this.b64url(crypto.getRandomValues(new Uint8Array(12)));
    store.set("fr.pkce", { verifier, state });
    const p = new URLSearchParams({ client_id: this.clientId(), response_type: "code", redirect_uri: this.redirect(),
      scope: CONFIG.scopes, code_challenge: challenge, code_challenge_method: "S256", state, prompt: "select_account" });
    location.assign(`${CONFIG.authority}/authorize?${p}`);
  },
  async token(params) {
    const r = await fetch(`${CONFIG.authority}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId(), scope: CONFIG.scopes, ...params }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error || "Sign-in failed");
    store.set("fr.tokens", { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 120) * 1000 });
    return j.access_token;
  },
  async handleRedirect() {
    const u = new URL(location.href), code = u.searchParams.get("code"), err = u.searchParams.get("error_description");
    if (!code && !err) return;
    history.replaceState(null, "", this.redirect());
    if (err) { toast("Microsoft sign-in: " + err, 6000); return; }
    const pk = store.get("fr.pkce"); store.del("fr.pkce");
    if (!pk || pk.state !== u.searchParams.get("state")) { toast("Sign-in expired - please try again."); return; }
    await this.token({ grant_type: "authorization_code", code, redirect_uri: this.redirect(), code_verifier: pk.verifier });
  },
  signedIn() { return !!store.get("fr.tokens"); },
  async access() {
    const t = store.get("fr.tokens"); if (!t) return null;
    if (Date.now() < t.exp) return t.access;
    try { return await this.token({ grant_type: "refresh_token", refresh_token: t.refresh }); }
    catch { store.del("fr.tokens"); return null; }
  },
  signOut() { store.del("fr.tokens"); store.del("fr.etag"); },
};

// ============================================================ OneDrive file sync
const GRAPH = "https://graph.microsoft.com/v1.0/me/drive/root:/" + CONFIG.filePath.split("/").map(encodeURIComponent).join("/");
const sync = { etag: null, dirty: false, saving: false, mode: "none", timer: null, lastLoad: 0 };
function setPill(text, cls) { const p = $("#syncPill"); p.textContent = text; p.className = "pill " + (cls || ""); }
function markDirty() {
  sync.dirty = true;
  if (sync.mode === "onedrive") { setPill("Unsaved changes", "busy"); clearTimeout(sync.timer); sync.timer = setTimeout(saveToOneDrive, 2500); }
  else if (sync.mode === "file") setPill("Unsaved - use More > Save a copy", "err");
}
async function graph(url, opts = {}) {
  const tok = await auth.access();
  if (!tok) { setPill("Sign in to OneDrive", "off"); throw new Error("signin"); }
  return fetch(url, { ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.headers || {}) } });
}
async function loadFromOneDrive(quiet) {
  setPill("Loading…", "busy");
  try {
    const meta = await graph(GRAPH);
    if (meta.status === 404) {
      openDb(null); sync.etag = null; sync.mode = "onedrive"; sync.dirty = true;
      await saveToOneDrive(); toast("Created a new Finance Review file in your OneDrive.");
    } else {
      if (!meta.ok) throw new Error(`OneDrive error ${meta.status}`);
      const m = await meta.json();
      if (quiet && m.eTag === sync.etag) { setPill("Saved to OneDrive", "ok"); return false; }
      const r = await graph(GRAPH + ":/content");
      if (!r.ok) throw new Error(`OneDrive error ${r.status}`);
      openDb(await r.arrayBuffer());
      sync.etag = m.eTag; sync.mode = "onedrive"; sync.dirty = false;
    }
    sync.lastLoad = Date.now();
    setPill("Saved to OneDrive", "ok");
    return true;
  } catch (e) {
    if (e.message !== "signin") { setPill("Offline - can't reach OneDrive", "err"); toast(e.message); }
    return false;
  }
}
async function saveToOneDrive(force) {
  if (sync.mode !== "onedrive" || !sync.dirty || sync.saving) return;
  sync.saving = true; setPill("Saving…", "busy");
  try {
    const headers = { "Content-Type": "application/octet-stream" };
    if (sync.etag && !force) headers["If-Match"] = sync.etag;
    const r = await graph(GRAPH + ":/content", { method: "PUT", headers, body: db.export() });
    if (r.status === 412) {
      setPill("Changed on another device", "err");
      sheet("Your data changed on another device",
        h("p", {}, "The file in OneDrive was updated (probably from your laptop) after this iPad opened it. " +
          "Load the newer copy (your unsaved changes here are lost), or keep this iPad's version (the laptop's latest changes are lost)."),
        [h("button", { class: "btn", onclick: async () => { closeSheet(); sync.dirty = false; await loadFromOneDrive(); render(); } }, "Load newer copy"),
         h("button", { class: "btn danger", onclick: async () => { closeSheet(); sync.saving = false; await saveToOneDrive(true); } }, "Keep this iPad's")]);
      return;
    }
    if (!r.ok) throw new Error(`Save failed (${r.status})`);
    const j = await r.json();
    sync.etag = j.eTag; sync.dirty = false;
    setPill("Saved to OneDrive", "ok");
  } catch (e) {
    if (e.message !== "signin") { setPill("Not saved - offline?", "err"); clearTimeout(sync.timer); sync.timer = setTimeout(saveToOneDrive, 15000); }
  } finally { sync.saving = false; }
}
document.addEventListener("visibilitychange", async () => {
  if (sync.mode !== "onedrive") return;
  if (document.hidden) { if (sync.dirty) saveToOneDrive(); }
  else if (!sync.dirty && Date.now() - sync.lastLoad > 15000) { if (await loadFromOneDrive(true)) render(); }
});
$("#syncPill").onclick = () => {
  if (sync.mode === "onedrive") { if (sync.dirty) saveToOneDrive(); else loadFromOneDrive(true).then(c => c && render()); }
  else setTab("more");
};

// ============================================================ filters
const state = { tab: store.get("fr.tab", "home"), owner: store.get("fr.owner", "All"), period: store.get("fr.period", "Last 3 months"),
  txnSearch: "", txnCat: "", txnAcc: "", budgetMonth: null };
function periodRange() {
  const t = new Date(), first = new Date(t.getFullYear(), t.getMonth(), 1), p = state.period;
  const back = n => new Date(first.getFullYear(), first.getMonth() - n, 1);
  if (p === "This month") return [iso(first), iso(t)];
  if (p === "Last month") return [iso(back(1)), iso(new Date(first - 86400000))];
  const m = p.match(/^Last (\d+) months$/); if (m) return [iso(back(+m[1] - 1)), iso(t)];
  if (p === "This year") return [`${t.getFullYear()}-01-01`, iso(t)];
  if (p === "Last year") return [`${t.getFullYear() - 1}-01-01`, `${t.getFullYear() - 1}-12-31`];
  return [null, null];
}
function periodLabel() {
  const [s, e] = periodRange(); if (!s) return "all time";
  const a = monthName(s.slice(0, 7)), b = monthName(e.slice(0, 7)); return a === b ? a : `${a} – ${b}`;
}

// ============================================================ charts (SVG with tap tooltips)
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; }
function tipOn(el, html, onTap) {
  el.style.cursor = "pointer";
  el.addEventListener("click", ev => { showTip(ev.clientX, ev.clientY, html); if (onTap) onTap(); });
  el.addEventListener("mouseenter", ev => showTip(ev.clientX, ev.clientY, html));
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); }
function hbarChart(items, onPick) {
  if (!items.length) return h("div", { class: "empty" }, "No spending in this period.");
  if (items.length > 10) items = [...items.slice(0, 9), ["Other", items.slice(9).reduce((s, x) => s + x[1], 0)]];
  const total = items.reduce((s, x) => s + x[1], 0), W = 560, rowH = 30, L = 150, R = 60, H = items.length * rowH + 10;
  const max = Math.max(...items.map(x => x[1])), sc = (W - L - R) / max;
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Spending by category" });
  items.forEach(([c, v], i) => {
    const y = 5 + i * rowH;
    g.append(svg("text", { x: L - 8, y: y + rowH / 2 + 4, "text-anchor": "end", "font-size": 13, fill: "#0b0b0b" }, c.length > 22 ? c.slice(0, 21) + "…" : c));
    const w = Math.max(2, v * sc);
    const bar = svg("rect", { x: L, y: y + 6, width: w, height: rowH - 12, rx: 4, fill: "#2a78d6" });
    const hit = svg("rect", { x: 0, y, width: W, height: rowH, fill: "transparent" });
    g.append(bar, svg("text", { x: L + w + 6, y: y + rowH / 2 + 4, "font-size": 12, fill: "#52514e" }, kfmt(v)), hit);
    tipOn(hit, `<b>${c}</b><br>${money(v)} · ${Math.round(v / total * 100)}% of spending${onPick && c !== "Other" ? "<br><i>Tap again to see transactions</i>" : ""}`,
      onPick && c !== "Other" ? (() => { let armed = false; return () => { if (armed) onPick(c); armed = true; setTimeout(() => (armed = false), 2500); }; })() : null);
  });
  return g;
}
function groupedChart(months, a, b) {
  if (!months.length) return h("div", { class: "empty" }, "No data yet.");
  const W = 560, H = 230, L = 46, B = 34, T = 10, max = niceMax(Math.max(...a, ...b, 1));
  const cw = (W - L - 8) / months.length, bw = Math.min(22, cw * 0.36), y = v => T + (H - T - B) * (1 - v / max);
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Income vs spending by month" });
  for (let i = 0; i <= 4; i++) {
    const v = max * i / 4;
    g.append(svg("line", { x1: L, x2: W - 4, y1: y(v), y2: y(v), stroke: "#e6e5e0" }),
      svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#52514e" }, kfmt(v)));
  }
  months.forEach((m, i) => {
    const cx = L + cw * i + cw / 2;
    const r1 = svg("rect", { x: cx - bw - 1, y: y(a[i]), width: bw, height: Math.max(0, y(0) - y(a[i])), rx: 3, fill: "#2a78d6" });
    const r2 = svg("rect", { x: cx + 1, y: y(b[i]), width: bw, height: Math.max(0, y(0) - y(b[i])), rx: 3, fill: "#eb6834" });
    const hit = svg("rect", { x: cx - cw / 2, y: T, width: cw, height: H - T - B + 20, fill: "transparent" });
    g.append(r1, r2, svg("text", { x: cx, y: H - 14, "text-anchor": "middle", "font-size": 11, fill: "#52514e" }, monthName(m)), hit);
    tipOn(hit, `<b>${monthName(m, true)}</b><br>Income ${money(a[i])}<br>Spending ${money(b[i])}<br>Net ${money(a[i] - b[i], true)}`);
  });
  return h("div", {}, h("div", { class: "legend" }, h("span", {}, h("i", { style: "background:#2a78d6" }), "Income"),
    h("span", {}, h("i", { style: "background:#eb6834" }), "Spending")), g);
}
function lineChart(pts) {
  if (pts.length < 2) return h("div", { class: "empty" }, "Not enough history yet.");
  const W = 900, H = 300, L = 56, B = 28, T = 14, R = 48, ys = pts.map(p => p[1]);
  let lo = Math.min(...ys), hi = Math.max(...ys); const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad;
  const x = i => L + (W - L - R) * i / (pts.length - 1), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Net worth by month" });
  for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4;
    g.append(svg("line", { x1: L, x2: W - R + 10, y1: y(v), y2: y(v), stroke: "#e6e5e0" }), svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#52514e" }, kfmt(v))); }
  g.append(svg("polyline", { points: pts.map((p, i) => `${x(i)},${y(p[1])}`).join(" "), fill: "none", stroke: "#2a78d6", "stroke-width": 2.5, "stroke-linejoin": "round" }));
  const step = Math.ceil(pts.length / 8);
  pts.forEach((p, i) => {
    g.append(svg("circle", { cx: x(i), cy: y(p[1]), r: 4, fill: "#2a78d6", stroke: "#fcfcfb", "stroke-width": 2 }));
    if (i % step === 0 || i === pts.length - 1) g.append(svg("text", { x: x(i), y: H - 8, "text-anchor": "middle", "font-size": 11, fill: "#52514e" }, monthName(p[0].slice(0, 7))));
    const hit = svg("circle", { cx: x(i), cy: y(p[1]), r: 16, fill: "transparent" });
    g.append(hit); tipOn(hit, `<b>${parseISO(p[0]).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</b><br>Net worth ${money(p[1])}`);
  });
  g.append(svg("text", { x: x(pts.length - 1) + 6, y: y(ys.at(-1)) - 8, "font-size": 12, fill: "#0b0b0b" }, kfmt(ys.at(-1))));
  return g;
}

// ============================================================ views
const kpi = (t, v, s, cls) => h("div", { class: "card kpi" }, h("div", { class: "t" }, t), h("div", { class: "v " + (cls || "") }, v), h("div", { class: "s" }, s || ""));
const amtCell = v => h("span", { class: "num amt " + (v > 0 ? "good" : v < 0 ? "bad" : "") }, money(v));

function needData() {
  if (db) return null;
  const box = h("div", { class: "empty" }, h("h2", {}, "Welcome"),
    h("p", {}, "Sign in with the Microsoft account that has your OneDrive. This app opens the same data file as Finance Review on your laptop."),
    h("button", { class: "btn primary", onclick: () => auth.signIn() }, "Sign in to OneDrive"),
    h("p", { class: "muted", style: "margin-top:24px" }, "Just looking? "),
    h("button", { class: "btn", onclick: openLocalFile }, "Open a .db file from Files"));
  return box;
}

function viewHome() {
  const [start, end] = periodRange(), ts = txns({ owner: state.owner, start, end }), s = summary(ts), nw = netWorth(state.owner);
  const unc = ts.filter(t => t.category === "Uncategorized");
  const now = new Date(), t0 = iso(new Date(now.getFullYear(), now.getMonth() - 11, 1));
  const mon = monthly(txns({ owner: state.owner, start: t0, end: iso(now) })), ms = Object.keys(mon);
  return h("div", {},
    unc.length ? h("div", { class: "warnbox" }, `${unc.length} transactions (${money(-unc.reduce((a, t) => a + t.amount, 0))}) are uncategorized and counted as spending.`,
      h("button", { onclick: () => { state.txnCat = "Uncategorized"; setTab("txns"); } }, "Review")) : null,
    h("div", { class: "grid kpis" },
      kpi("Income", money(s.income), periodLabel()), kpi("Spending", money(s.spending), periodLabel()),
      kpi("Income minus spending", money(s.net, true), periodLabel(), s.net >= 0 ? "good" : "bad"),
      kpi("Net worth (today)", money(nw.net), `${money(nw.assets)} assets − ${money(nw.liabilities)} debts`)),
    h("div", { class: "grid two", style: "margin-top:12px" },
      h("div", { class: "card" }, h("h3", {}, `Spending by category · ${periodLabel()}`),
        hbarChart(byCategory(ts), c => { state.txnCat = c; setTab("txns"); })),
      h("div", { class: "card" }, h("h3", {}, "Income vs spending · last 12 months"),
        groupedChart(ms, ms.map(m => mon[m].income), ms.map(m => mon[m].spending)))),
    h("div", { class: "section-title" }, "Top merchants this period"),
    h("div", { class: "list" }, topMerchants(ts, 10).map(([m, v, c]) =>
      h("div", { class: "li tap", onclick: () => { state.txnSearch = m.split(" ")[0]; state.txnCat = ""; setTab("txns"); } },
        h("div", { class: "main" }, h("div", { class: "l1" }, m), h("div", { class: "l2" }, `${c} visit${c > 1 ? "s" : ""} · avg ${money(v / c)}`)),
        h("span", { class: "num amt" }, money(v))))),
    h("div", { class: "row-btns" }, h("button", { class: "btn primary", onclick: startImport }, "Import a statement")));
}

function viewTxns() {
  const [start, end] = periodRange();
  const ts = txns({ owner: state.owner, start, end, account: state.txnAcc || null, search: state.txnSearch || null, category: state.txnCat || null });
  const search = h("input", { type: "search", placeholder: "Search descriptions…", value: state.txnSearch });
  search.addEventListener("input", () => { state.txnSearch = search.value; clearTimeout(viewTxns._t); viewTxns._t = setTimeout(render, 250); });
  const accSel = h("select", {}, h("option", { value: "" }, "All accounts"), accounts(state.owner).map(a => h("option", { value: a.id, selected: String(a.id) === String(state.txnAcc) }, a.name)));
  accSel.onchange = () => { state.txnAcc = accSel.value; render(); };
  const catSel = h("select", {}, h("option", { value: "" }, "All categories"), categoryList().map(c => h("option", { selected: c === state.txnCat }, c)));
  catSel.onchange = () => { state.txnCat = catSel.value; render(); };
  const list = h("div", { class: "list" });
  let lastDate = null; const MAX = 400;
  for (const t of ts.slice(0, MAX)) {
    if (t.date !== lastDate) { lastDate = t.date; list.append(h("div", { class: "datehead" }, parseISO(t.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }))); }
    list.append(h("div", { class: "li tap", onclick: () => editTxn(t) },
      h("div", { class: "main" }, h("div", { class: "l1" }, t.description),
        h("div", { class: "l2" }, h("span", { class: "tag" + (t.category === "Uncategorized" ? " unc" : "") }, t.category), ` ${t.account}${t.note ? " · " + t.note : ""}`)),
      amtCell(t.amount)));
  }
  const inn = ts.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0), out = ts.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  return h("div", {},
    search, h("div", { class: "filters", style: "margin:10px 0" }, accSel, catSel,
      (state.txnSearch || state.txnCat || state.txnAcc) ? h("button", { class: "link", onclick: () => { state.txnSearch = state.txnCat = state.txnAcc = ""; render(); } }, "Clear filters") : null),
    h("div", { class: "muted", style: "margin-bottom:8px" }, `${ts.length} transactions · in ${money(inn)} · out ${money(out)}${ts.length > MAX ? ` · showing first ${MAX}` : ""}`),
    ts.length ? list : h("div", { class: "empty" }, "No transactions match."));
}

function editTxn(t) {
  let chosen = t.category;
  const cats = h("div", { class: "cats" }, categoryList().map(c => {
    const b = h("button", { class: c === chosen ? "on" : "", onclick: () => { chosen = c; [...cats.children].forEach(x => x.classList.toggle("on", x === b)); } }, c); return b; }));
  const newCat = h("input", { type: "text", placeholder: "Or type a new category" });
  const note = h("input", { type: "text", value: t.note || "", placeholder: "Note" });
  const mkRule = h("input", { type: "checkbox", checked: true });
  const key = merchantKey(t.description);
  sheet(t.description, h("div", {},
    h("p", { class: "muted" }, `${parseISO(t.date).toLocaleDateString()} · ${t.account} (${t.owner}) · `, amtCell(t.amount)),
    h("div", { class: "field" }, h("span", {}, "Category"), cats, newCat),
    h("label", { class: "field", style: "flex-direction:row;align-items:center;gap:8px" }, mkRule,
      h("span", { style: "font-size:15px;color:inherit" }, `Also use this category for everything from “${key}” (makes a rule)`)),
    h("div", { class: "field" }, h("span", {}, "Note"), note),
    t.cat_manual ? h("button", { class: "link", onclick: () => { run("UPDATE transactions SET cat_manual=0 WHERE id=?", [t.id]); applyRules(); closeSheet(); render(); } }, "Let rules decide this category again") : null),
    [h("button", { class: "btn danger", onclick: () => confirmSheet("Delete transaction?", t.description, "Delete", () => { run("DELETE FROM transactions WHERE id=?", [t.id]); render(); }, true) }, "Delete"),
     h("button", { class: "btn primary", onclick: () => {
       const cat = newCat.value.trim() || chosen;
       run("UPDATE transactions SET category=?, cat_manual=1, note=? WHERE id=?", [cat, note.value, t.id]);
       if (mkRule.checked && cat !== t.category && cat !== "Uncategorized") {
         run("INSERT INTO rules(pattern, category, owner, priority) VALUES (?,?,?,10)", [key, cat, t.owner]);
         const n = applyRules(); toast(`Rule added · ${n} more updated`);
       }
       closeSheet(); render(); } }, "Save")]);
}

function viewRecurring() {
  const ts = txns({ owner: state.owner }), rec = recurring(ts, iso(new Date())), act = rec.filter(r => r.active);
  const subs = act.filter(r => r.category === "Subscriptions");
  const dups = duplicates(ts).slice(0, 30);
  return h("div", {},
    h("div", { class: "grid kpis" }, kpi("Recurring per month", money(act.reduce((s, r) => s + r.monthly, 0))),
      kpi("Per year", money(act.reduce((s, r) => s + r.yearly, 0))),
      kpi("Active", String(act.length), `${subs.length} subscriptions (${money(subs.reduce((s, r) => s + r.monthly, 0))}/mo)`)),
    h("p", { class: "muted" }, "Found from your full history: same merchant, regular schedule, about the same amount. Tap one to see its charges."),
    h("div", { class: "list" }, rec.map(r => h("div", { class: "li tap", style: r.active ? "" : "opacity:.6", onclick: () => { state.txnSearch = r.merchant.split(" ")[0]; state.txnCat = ""; state.period = "All time"; $("#period").value = "All time"; setTab("txns"); } },
      h("div", { class: "main" }, h("div", { class: "l1" }, r.merchant),
        h("div", { class: "l2" }, `${r.frequency} · ${r.owner} · last ${r.last}${r.active ? ` · next ~${r.next}` : ""}`),
        r.flags ? h("div", { class: "l2", style: "color:var(--warn)" }, r.flags) : null),
      h("div", { class: "num" }, h("div", { class: "amt" }, money(r.amount)), h("div", { class: "l2" }, r.active ? money(r.yearly) + "/yr" : "—"))))),
    h("div", { class: "section-title" }, "Possible duplicate charges"),
    dups.length ? h("div", { class: "list" }, dups.map(([a, b]) => h("div", { class: "li" },
      h("div", { class: "main" }, h("div", { class: "l1" }, a.description), h("div", { class: "l2" }, `${a.date} and ${b.date} · ${a.account}`)), amtCell(a.amount))))
      : h("p", { class: "muted" }, "None found."));
}

function viewAccounts() {
  const nw = netWorth(state.owner);
  return h("div", {},
    h("div", { class: "grid kpis" }, kpi("Assets", money(nw.assets)), kpi("Debts", money(nw.liabilities)), kpi("Net worth", money(nw.net))),
    h("div", { class: "row-btns" }, h("button", { class: "btn", onclick: () => editAccount() }, "Add account")),
    h("div", { class: "list" }, nw.rows.map(([a, b]) => {
      const snap = latestSnapshot(a.id);
      return h("div", { class: "li tap", onclick: () => accountMenu(a, b) },
        h("div", { class: "main" }, h("div", { class: "l1" }, a.name),
          h("div", { class: "l2" }, `${a.owner} ${a.type}${a.institution ? " · " + a.institution : ""} · `,
            snap ? `balance checked ${snap.date}` : h("span", { style: "color:var(--warn)" }, "tap to set current balance"))),
        amtCell(b));
    })),
    h("div", { class: "card", style: "margin-top:12px" }, h("h3", {}, "Net worth by month"), lineChart(netWorthHistory(state.owner))));
}
function accountMenu(a, bal) {
  const liab = LIABILITY.has(a.type);
  const amt = h("input", { type: "number", step: "0.01", inputmode: "decimal", value: (liab ? -bal : bal).toFixed(2) });
  const date = h("input", { type: "date", value: iso(new Date()) });
  sheet(a.name, h("div", {},
    h("div", { class: "field" }, h("span", {}, liab ? "Amount you owe now" : "Current balance"), amt),
    h("div", { class: "field" }, h("span", {}, "As of"), date),
    h("p", { class: "muted" }, "Copy this from your bank's app. Earlier and later balances are worked out from your transactions.")),
    [h("button", { class: "btn", onclick: () => { closeSheet(); editAccount(a); } }, "Edit account"),
     h("button", { class: "btn primary", onclick: () => {
       const v = parseFloat(amt.value); if (isNaN(v)) return;
       run("INSERT INTO balance_snapshots(account_id, date, balance) VALUES (?,?,?)", [a.id, date.value, liab ? -v : v]);
       closeSheet(); render(); } }, "Save balance")]);
}
function editAccount(a, after) {
  const name = h("input", { type: "text", value: a?.name || "" }), inst = h("input", { type: "text", value: a?.institution || "", placeholder: "e.g. Chase, Amex" });
  const type = h("select", {}, FR.accountTypes.map(t => h("option", { selected: a?.type === t }, t)));
  const owner = h("select", {}, ["Personal", "Business"].map(o => h("option", { selected: a?.owner === o }, o)));
  sheet(a ? "Edit account" : "New account", h("div", {},
    h("div", { class: "field" }, h("span", {}, "Name"), name), h("div", { class: "field" }, h("span", {}, "Bank / issuer"), inst),
    h("div", { class: "field" }, h("span", {}, "Type"), type), h("div", { class: "field" }, h("span", {}, "Personal or business"), owner)),
    [a ? h("button", { class: "btn danger", onclick: () => confirmSheet("Delete account?", `Delete “${a.name}” and all its transactions?`, "Delete", () => { run("DELETE FROM accounts WHERE id=?", [a.id]); render(); }, true) }, "Delete") : null,
     h("button", { class: "btn primary", onclick: () => {
       if (!name.value.trim()) { toast("Give the account a name."); return; }
       let id = a?.id;
       if (a) run("UPDATE accounts SET name=?, institution=?, type=?, owner=? WHERE id=?", [name.value.trim(), inst.value.trim(), type.value, owner.value, a.id]);
       else { run("INSERT INTO accounts(name, institution, type, owner, opening_balance) VALUES (?,?,?,?,0)", [name.value.trim(), inst.value.trim(), type.value, owner.value]); id = one("SELECT last_insert_rowid() AS id").id; }
       if (a) applyRules();
       closeSheet(); if (after) after(id); else render(); } }, "Save")].filter(Boolean));
}

function viewBudget() {
  const now = new Date();
  const lo = one("SELECT MIN(date) AS d FROM transactions")?.d || iso(now);
  const months = []; for (let d = new Date(now.getFullYear(), now.getMonth(), 1); iso(d).slice(0, 7) >= lo.slice(0, 7); d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) months.push(iso(d).slice(0, 7));
  if (!state.budgetMonth || !months.includes(state.budgetMonth)) state.budgetMonth = months[0];
  const sel = h("select", {}, months.map(m => h("option", { value: m, selected: m === state.budgetMonth }, monthName(m, true))));
  sel.onchange = () => { state.budgetMonth = sel.value; render(); };
  const editable = state.owner !== "All";
  const { rows, end } = budgetReport(state.owner, state.budgetMonth);
  const tb = rows.reduce((s, r) => s + r.budget, 0), ts = rows.filter(r => r.budget).reduce((s, r) => s + r.actual, 0);
  const cur = state.budgetMonth === iso(now).slice(0, 7), frac = cur ? now.getDate() / +end.slice(8) : null;
  const ask = (cat, val) => {
    if (!editable) { toast("Pick Personal or Business at the top to edit budgets."); return; }
    const inp = h("input", { type: "number", step: "10", inputmode: "decimal", value: val ? Math.round(val) : "" });
    sheet(`Budget · ${cat}`, h("div", {}, h("div", { class: "field" }, h("span", {}, `Monthly budget (${state.owner}). Leave empty to remove.`), inp)),
      [h("button", { class: "btn primary", onclick: () => { const v = parseFloat(inp.value);
        if (!v || v <= 0) run("DELETE FROM budgets WHERE owner=? AND category=?", [state.owner, cat]);
        else run("INSERT OR REPLACE INTO budgets VALUES (?,?,?)", [state.owner, cat, v]);
        closeSheet(); render(); } }, "Save")]);
    setTimeout(() => inp.focus(), 50);
  };
  return h("div", {},
    h("div", { class: "filters", style: "margin-bottom:10px" }, sel,
      editable ? h("button", { class: "btn", onclick: () => {
        const cats = categoryList().filter(c => !NON_SPENDING.has(c) && c !== "Uncategorized");
        const pick = h("div", { class: "cats" }, cats.map(c => h("button", { onclick: () => ask(c, budgetsFor(state.owner)[c]) }, c)));
        sheet("Set a budget for…", pick); } }, "Set a budget") : null,
      editable ? h("button", { class: "btn", onclick: () => { let n = 0;
        for (const r of rows) if (!r.budget && r.avg3 >= 10 && r.category !== "Uncategorized") { run("INSERT OR REPLACE INTO budgets VALUES (?,?,?)", [state.owner, r.category, Math.round(r.avg3 / 10 + .5) * 10]); n++; }
        toast(`Set ${n} budgets from your 3-month average`); render(); } }, "Fill blanks from 3-mo avg") : null),
    !editable ? h("p", { class: "muted" }, "Showing Personal + Business together. Pick one at the top to edit.") : null,
    h("div", { class: "grid kpis" }, kpi("Budgeted", money(tb)), kpi("Spent", money(ts), "on budgeted categories"),
      kpi("Left", money(tb - ts), frac ? `${Math.round(frac * 100)}% of the month gone` : "", tb - ts >= 0 ? "good" : "bad")),
    h("div", { class: "list", style: "margin-top:12px" }, rows.map(r => {
      const pct = r.budget ? r.actual / r.budget : 0;
      return h("div", { class: "li tap", onclick: () => ask(r.category, r.budget || r.avg3) },
        h("div", { class: "main" }, h("div", { class: "l1" }, r.category),
          r.budget ? h("div", { class: "bar" + (pct > 1 ? " over" : ""), style: "margin:6px 0 3px" }, h("i", { style: `width:${Math.min(100, pct * 100)}%` })) : null,
          h("div", { class: "l2" }, r.budget ? `${money(r.actual)} of ${money(r.budget)} · ${Math.round(pct * 100)}%` : `${money(r.actual)} spent · no budget`, ` · 3-mo avg ${money(r.avg3)}`)),
        r.budget ? h("span", { class: "num amt " + (r.budget - r.actual >= 0 ? "good" : "bad") }, money(r.budget - r.actual)) : null);
    })));
}

function viewMore() {
  const cid = h("input", { type: "text", value: auth.clientId(), placeholder: "Application (client) ID from Azure" });
  return h("div", {},
    h("div", { class: "section-title" }, "Data"),
    h("div", { class: "card" },
      h("p", {}, sync.mode === "onedrive" ? `Using ${CONFIG.filePath} in your OneDrive.` : sync.mode === "file" ? "Using a file opened from Files (not syncing)." : "No data open."),
      h("div", { class: "row-btns" },
        h("button", { class: "btn primary", onclick: startImport }, "Import a statement"),
        auth.signedIn() ? h("button", { class: "btn", onclick: async () => { if (sync.dirty) await saveToOneDrive(); if (await loadFromOneDrive()) render(); } }, "Reload from OneDrive")
          : h("button", { class: "btn", onclick: () => auth.signIn() }, "Sign in to OneDrive"),
        h("button", { class: "btn", onclick: openLocalFile }, "Open a .db file"),
        db ? h("button", { class: "btn", onclick: saveCopy }, "Save a copy") : null,
        auth.signedIn() ? h("button", { class: "btn danger", onclick: () => { auth.signOut(); location.reload(); } }, "Sign out") : null)),
    db ? viewRules() : null,
    h("div", { class: "section-title" }, "Settings"),
    h("div", { class: "card" },
      h("div", { class: "field" }, h("span", {}, "Microsoft app (client) ID - from the setup guide"), cid),
      h("button", { class: "btn", onclick: () => { store.set("fr.clientId", cid.value.trim()); toast("Saved"); } }, "Save")),
    h("p", { class: "muted", style: "margin-top:16px" }, "Tip: in Safari, tap Share › Add to Home Screen to use this like an app."));
}
function viewRules() {
  const mine = rules().filter(r => r.priority > 0);
  return h("div", {},
    h("div", { class: "section-title" }, "Your category rules"),
    h("p", { class: "muted" }, "Made when you re-categorize a transaction. Built-in rules for common stores and trucking costs are also applied."),
    mine.length ? h("div", { class: "list" }, mine.map(r => h("div", { class: "li" },
      h("div", { class: "main" }, h("div", { class: "l1" }, `“${r.pattern}” → ${r.category}`), h("div", { class: "l2" }, r.owner || "Personal and Business")),
      h("button", { class: "link", style: "color:var(--bad)", onclick: () => { run("DELETE FROM rules WHERE id=?", [r.id]); applyRules(); render(); } }, "Remove"))))
      : h("p", { class: "muted" }, "None yet."),
    h("div", { class: "row-btns" }, h("button", { class: "btn", onclick: () => { const n = applyRules(); toast(`${n} transactions re-categorized`); render(); } }, "Re-apply all rules")));
}

// ---------------------------------------------------------------- import flow
function startImport() {
  if (!db) { toast("Open your data first."); return; }
  const f = $("#filePick"); f.accept = ".csv,.txt,.ofx,.qfx,.qbo,text/csv"; f.multiple = false;
  f.onchange = async () => { const file = f.files[0]; f.value = ""; if (file) importFile(file); };
  f.click();
}
async function importFile(file) {
  const text = await file.text();
  const isOfx = /\.(ofx|qfx|qbo)$/i.test(file.name) || /<OFX>/i.test(text.slice(0, 2000));
  let csv = null, ofx = null;
  try { if (isOfx) ofx = parseOfx(text); else csv = new CsvFile(text); } catch (e) { toast("Couldn't read that file."); return; }
  const fn = file.name.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const score = a => a.name.toLowerCase().split(/\s+/).filter(w => w.length > 2 && fn.includes(w)).length;
  let accId = [...accounts()].sort((a, b) => score(b) - score(a))[0]?.id;
  let flip = false, mapping = csv ? { ...csv.mapping } : null, saveBal = !!ofx?.balance;
  const body = h("div", {}), status = h("p", {}), preview = h("div", { class: "list" });
  const accSel = h("select", {}); const fill = () => { accSel.replaceChildren(...accounts().map(a => h("option", { value: a.id, selected: a.id === accId }, `${a.name} (${a.owner} ${a.type})`))); };
  fill();
  const flipBox = h("input", { type: "checkbox" });
  const acc = () => accounts().find(a => a.id === +accSel.value);
  const rowsNow = () => csv ? csv.parse(mapping, flip) : { rows: ofx.rows.map(r => ({ ...r, amount: flip ? -r.amount : r.amount })), bad: 0 };
  const autoFlip = () => { if (csv && acc()) { flip = shouldFlip(csv.parse(mapping, false).rows, acc().type); flipBox.checked = flip; } };
  const refresh = () => {
    const { rows, bad } = rowsNow(); const a = acc();
    const out = rows.filter(r => r.amount < 0).reduce((s, r) => s + r.amount, 0), inn = rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    status.innerHTML = `<b>${rows.length}</b> transactions${rows.length ? ` from ${rows.reduce((m, r) => r.date < m ? r.date : m, "9")} to ${rows.reduce((m, r) => r.date > m ? r.date : m, "0")}` : ""}. Out ${money(out)} · in ${money(inn)}.` +
      (bad ? ` <span class="bad">${bad} rows couldn't be read - check the columns.</span>` : "") +
      (!a ? " <b>Add an account first.</b>" : LIABILITY.has(a.type) && inn > -out ? ' <span class="bad">Purchases look positive - try “Flip signs”.</span>' : "");
    preview.replaceChildren(...rows.slice(0, 40).map(r => h("div", { class: "li" }, h("div", { class: "main" }, h("div", { class: "l1" }, r.description), h("div", { class: "l2" }, r.date)), amtCell(r.amount))));
  };
  accSel.onchange = () => { accId = +accSel.value; autoFlip(); refresh(); };
  flipBox.onchange = () => { flip = flipBox.checked; refresh(); };
  body.append(
    h("div", { class: "field" }, h("span", {}, "Import into account"), h("div", { class: "filters", style: "margin:0" }, accSel,
      h("button", { class: "btn", onclick: () => editAccount(null, id => { accId = id; sheet(`Import ${file.name}`, body, actions); fill(); autoFlip(); refresh(); }) }, "New account"))));
  if (csv) {
    const opts = ["(none)", ...csv.headers];
    const grid = h("div", { class: "grid", style: "grid-template-columns:repeat(auto-fit,minmax(140px,1fr))" });
    for (const [k, label] of [["date", "Date"], ["description", "Description"], ["amount", "Amount"], ["debit", "Debit / money out"], ["credit", "Credit / money in"]]) {
      const s = h("select", {}, opts.map((o, i) => h("option", { value: i - 1, selected: (mapping[k] ?? -1) === i - 1 }, o)));
      s.onchange = () => { mapping[k] = +s.value < 0 ? null : +s.value; autoFlip(); refresh(); };
      grid.append(h("label", { class: "field" }, h("span", {}, label), s));
    }
    body.append(grid, h("p", { class: "muted" }, "Use one Amount column, or separate Debit and Credit columns."));
  }
  body.append(h("label", { class: "field", style: "flex-direction:row;align-items:center;gap:8px" }, flipBox, h("span", { style: "font-size:15px;color:inherit" }, "Flip signs (if purchases show as money in)")));
  if (ofx?.balance) { const cb = h("input", { type: "checkbox", checked: true }); cb.onchange = () => (saveBal = cb.checked);
    body.append(h("label", { class: "field", style: "flex-direction:row;align-items:center;gap:8px" }, cb, h("span", { style: "font-size:15px;color:inherit" }, `Save ending balance ${money(ofx.balance[1])} on ${ofx.balance[0]}`))); }
  body.append(status, preview);
  const actions = [h("button", { class: "btn", onclick: closeSheet }, "Cancel"), h("button", { class: "btn primary", onclick: async () => {
    const a = acc(); if (!a) { toast("Pick or add an account."); return; }
    const rows = await makeHashes(rowsNow().rows.map(r => ({ ...r })), a.id);
    const [added, skipped] = insertTxns(a.id, rows, file.name);
    if (ofx?.balance && saveBal) run("INSERT INTO balance_snapshots(account_id, date, balance) VALUES (?,?,?)", [a.id, ...ofx.balance]);
    applyRules(); closeSheet(); render();
    toast(`${added} added to ${a.name}${skipped ? ` · ${skipped} were already there` : ""}`, 4500);
  } }, "Import")];
  autoFlip(); refresh();
  sheet(`Import ${file.name}`, body, actions);
}

// ---------------------------------------------------------------- local file (no OneDrive)
function openLocalFile() {
  const f = $("#filePick"); f.accept = ".db,.sqlite,application/octet-stream,application/x-sqlite3"; f.multiple = false;
  f.onchange = async () => {
    const file = f.files[0]; f.value = ""; if (!file) return;
    try { openDb(await file.arrayBuffer()); } catch { toast("That doesn't look like a Finance Review file."); return; }
    sync.mode = "file"; sync.dirty = false; setPill("Local file (not syncing)", "off"); render();
  };
  f.click();
}
function saveCopy() {
  const blob = new Blob([db.export()], { type: "application/octet-stream" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `finance-${iso(new Date())}.db` });
  document.body.append(a); a.click(); a.remove();
  if (sync.mode === "file") { sync.dirty = false; setPill("Local file (not syncing)", "off"); }
}

// ============================================================ shell
const VIEWS = { home: viewHome, txns: viewTxns, recurring: viewRecurring, accounts: viewAccounts, budget: viewBudget, more: viewMore, ...(window.VIEWS_EXTRA || {}) };
function setTab(t) { state.tab = t; store.set("fr.tab", t); render(); scrollTo(0, 0); }
function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === state.tab));
  document.querySelectorAll("#ownerSeg button").forEach(b => b.classList.toggle("on", b.dataset.v === state.owner));
  $("#period").value = state.period;
  const main = $("#main");
  const gate = state.tab !== "more" ? needData() : null;
  try { main.replaceChildren(gate || VIEWS[state.tab]()); }
  catch (e) { console.error(e); main.replaceChildren(h("div", { class: "empty" }, "Something went wrong: " + e.message)); }
}
document.querySelectorAll("#tabs button").forEach(b => (b.onclick = () => setTab(b.dataset.tab)));
document.querySelectorAll("#ownerSeg button").forEach(b => (b.onclick = () => { state.owner = b.dataset.v; store.set("fr.owner", state.owner); state.txnAcc = ""; render(); }));
$("#period").onchange = e => { state.period = e.target.value; store.set("fr.period", state.period); render(); };
window.addEventListener("beforeunload", e => { if (sync.dirty && sync.mode === "onedrive") { saveToOneDrive(); e.preventDefault(); } });

(async function start() {
  render();
  SQL = await initSqlJs({ locateFile: f => f + "?v=202610311734" });
  try { await auth.handleRedirect(); } catch (e) { toast(e.message, 6000); }
  if (auth.signedIn()) { await loadFromOneDrive(); }
  else setPill("Not signed in", "off");
  render();
})();
window.__fr = { get db() { return db; }, openDb, render, sync, auth, applyRules, merchantKey, categorize, parseDate, CsvFile };
