/* Paycheck Planner for the iPad app - same rules as planner.py on the laptop. Personal accounts only.
   Your changes are saved in the data file (setting "planner"), so both devices show the same plan. */
"use strict";
(function () {
  const OWNER = "Personal";
  const DEFAULTS = { income_extra: [], income_off: [], income_amount: {}, bills_extra: [], bills_off: [], bills_amount: {},
    spend_amount: {}, spend_off: [], savings: { mode: "amount", value: 0 } };
  const MONTH_FREQ = { Monthly: 1, Quarterly: 3, Yearly: 12 }, DAY_FREQ = { Weekly: 7, "Every 2 weeks": 14 };
  const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const ui = { offset: 0 };

  function load() {
    let s = {};
    try { s = JSON.parse(getSetting("planner") || "{}") || {}; } catch { s = {}; }
    const out = JSON.parse(JSON.stringify(DEFAULTS));
    for (const k of Object.keys(DEFAULTS)) if (k in s) out[k] = s[k];
    return out;
  }
  function save(s) { run("INSERT OR REPLACE INTO settings VALUES (?,?)", ["planner", JSON.stringify(s)]); }

  function addMonths(s, n) {
    const d = parseISO(s), y = d.getFullYear(), m = d.getMonth() + n;
    const last = new Date(y, m + 1, 0).getDate();
    return iso(new Date(y, m, Math.min(d.getDate(), last)));
  }
  // Dates of a repeating item from `last` that fall in [start, end)
  function occurrences(last, start, end, { days: dd, months, includeLast } = {}) {
    const out = [];
    for (let k = includeLast ? 0 : 1; k < 2000; k++) {
      const d = dd ? addDays(last, dd * k) : addMonths(last, months * k);
      if (d >= end) break;
      if (d >= start) out.push(d);
    }
    return out;
  }
  const title = k => k.toLowerCase().replace(/(^|[^a-z'])([a-z])/g, (m, a, b) => a + b.toUpperCase());

  function paycheckSources() {
    const groups = new Map();
    for (const t of txns({ owner: OWNER })) if (t.amount > 0 && INCOME.has(t.category)) {
      const k = merchantKey(t.description); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t);
    }
    const out = [];
    for (const [key, ts] of groups) {
      ts.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      if (ts.length < 3) continue;
      const gaps = []; for (let i = 1; i < ts.length; i++) { const g = days(ts[i - 1].date, ts[i].date); if (g > 0) gaps.push(g); }
      if (!gaps.length) continue;
      const g = median(gaps);
      const every = g >= 12 && g <= 17 ? 14 : g >= 5 && g <= 9 ? 7 : g >= 26 && g <= 35 ? 30 : 0;
      if (!every) continue;
      out.push({ key: "auto:" + key, name: title(key), every, last: ts.at(-1).date,
        amount: r2(median(ts.slice(-3).map(t => t.amount))), auto: true });
    }
    return out;
  }
  function incomeItems(s) {
    const items = paycheckSources();
    for (const x of s.income_extra) items.push({ key: x.key, name: x.name, every: +(x.every || 14), last: x.next, amount: +x.amount, auto: false, first_is_next: true });
    for (const it of items) { if (it.key in s.income_amount) it.amount = +s.income_amount[it.key]; it.on = !s.income_off.includes(it.key); }
    return items;
  }
  function nextPayday(it, today) {
    let d = it.first_is_next ? it.last : addDays(it.last, it.every);
    while (d < today) d = addDays(d, it.every);
    return d;
  }

  function plan(offset = 0, today = iso(new Date())) {
    const s = load(), incomes = incomeItems(s), active = incomes.filter(i => i.on);
    if (!active.length) return { needs_setup: true, income: incomes, settings: s };
    const primary = active.reduce((a, b) => (b.amount * 365 / b.every > a.amount * 365 / a.every ? b : a));
    const start = addDays(nextPayday(primary, today), primary.every * offset), end = addDays(start, primary.every);
    const nd = days(start, end);

    const income_rows = [];
    for (const it of incomes)
      for (const d of occurrences(it.last, start, end, { days: it.every, includeLast: !!it.first_is_next }))
        income_rows.push({ key: it.key, name: it.name, date: d, amount: it.amount, on: it.on, auto: it.auto });

    const ts = txns({ owner: OWNER });
    const rec = recurring(ts, today).filter(r => r.active);
    const bill_rows = [], early = [], billKeys = new Set();
    for (const r of rec) {
      const key = `auto:${r.merchant}|${r.account}`; billKeys.add(r.merchant + "\u0001" + r.account);
      const amt = key in s.bills_amount ? +s.bills_amount[key] : r.amount;
      const kw = r.frequency in DAY_FREQ ? { days: DAY_FREQ[r.frequency] } : { months: MONTH_FREQ[r.frequency] };
      for (const d of occurrences(r.last, start, end, kw))
        bill_rows.push({ key, name: title(r.merchant), date: d, amount: amt, on: !s.bills_off.includes(key), auto: true,
          category: r.category, account: r.account, how_often: r.frequency });
      if (offset === 0) for (const d of occurrences(r.last, today, start, kw)) early.push({ name: title(r.merchant), date: d, amount: amt });
    }
    for (const b of s.bills_extra) {
      const amt = b.key in s.bills_amount ? +s.bills_amount[b.key] : +b.amount;
      const occ = b.repeat === "monthly" ? occurrences(b.date, start, end, { months: 1, includeLast: true })
        : b.repeat === "biweekly" ? occurrences(b.date, start, end, { days: 14, includeLast: true })
        : (start <= b.date && b.date < end ? [b.date] : []);
      for (const d of occ) bill_rows.push({ key: b.key, name: b.name, date: d, amount: amt, on: !s.bills_off.includes(b.key), auto: false,
        category: b.category || "", account: "", how_often: { monthly: "Monthly", biweekly: "Every 2 weeks" }[b.repeat] || "One time" });
    }
    bill_rows.sort((a, b) => a.date.localeCompare(b.date));

    const firstThis = today.slice(0, 8) + "01", s3 = addMonths(firstThis, -3);
    const perCat = {};
    for (const t of txns({ owner: OWNER, start: s3, end: addDays(firstThis, -1) }))
      if (!NON_SPENDING.has(t.category) && !billKeys.has(merchantKey(t.description) + "\u0001" + t.account))
        perCat[t.category] = (perCat[t.category] || 0) - t.amount;
    const budgets = budgetsFor(OWNER), billsMonthly = {};
    for (const r of rec) billsMonthly[r.category] = (billsMonthly[r.category] || 0) + r.yearly / 12;
    const spend_rows = [];
    for (const c of [...new Set([...Object.keys(perCat), ...Object.keys(budgets)])].sort()) {
      const monthly = c in budgets ? Math.max(0, budgets[c] - (billsMonthly[c] || 0)) : (perCat[c] || 0) / 3;
      let est = r2(monthly * nd / 30.4);
      const mine = c in s.spend_amount;
      if (mine) est = +s.spend_amount[c];
      if (est < 5 && !mine) continue;
      spend_rows.push({ category: c, amount: est, on: !s.spend_off.includes(c), source: mine ? "your change" : c in budgets ? "budget" : "3-month average" });
    }
    spend_rows.sort((a, b) => b.amount - a.amount);

    const sum = rows => r2(rows.filter(r => r.on).reduce((a, r) => a + r.amount, 0));
    const income = sum(income_rows), bills = sum(bill_rows), spending = sum(spend_rows), sv = s.savings;
    const savings = r2((+sv.value || 0) * (sv.mode === "percent" ? income / 100 : 1));
    return { start, end: addDays(end, -1), days: nd, offset, primary: primary.name, income_rows, bill_rows, spend_rows,
      due_before_payday: early, savings_setting: sv,
      totals: { income, bills, spending, savings, left_over: r2(income - bills - spending - savings) }, income_sources: incomes };
  }

  // ------------------------------------------------------------ view
  const nice = d => parseISO(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const change = fn => { const s = load(); fn(s); save(s); render(); };
  const toggle = (list, key, on) => change(s => { s[list] = s[list].filter(k => k !== key); if (!on) s[list].push(key); });

  function askAmount(label, cur, apply, extra) {
    const inp = h("input", { type: "number", step: "0.01", inputmode: "decimal", value: cur.toFixed(2) });
    sheet(label, h("div", {}, h("div", { class: "field" }, h("span", {}, "Amount for this plan"), inp)),
      [extra, h("button", { class: "btn primary", onclick: () => { const v = parseFloat(inp.value);
        if (!(v >= 0)) { toast("Enter an amount"); return; } closeSheet(); change(s => apply(s, v)); } }, "Save")].filter(Boolean));
    setTimeout(() => inp.focus(), 50);
  }

  function addItem(kind) {
    const name = h("input", { type: "text", placeholder: kind === "bill" ? "e.g. Storage unit" : "e.g. Side job" });
    const amt = h("input", { type: "number", step: "0.01", inputmode: "decimal" });
    const date = h("input", { type: "date", value: iso(new Date()) });
    const rep = h("select", {}, (kind === "bill" ? [["monthly", "Every month"], ["biweekly", "Every 2 weeks"], ["once", "One time"]]
      : [[14, "Every 2 weeks"], [7, "Every week"], [30, "Every month"]]).map(([v, t]) => h("option", { value: v }, t)));
    const f = (l, e) => h("div", { class: "field" }, h("span", {}, l), e);
    sheet(kind === "bill" ? "Add a bill" : "Add a paycheck", h("div", {}, f("Name", name), f("Amount", amt),
      f(kind === "bill" ? "Next due date" : "Next payday", date), f("Repeats", rep)),
      [h("button", { class: "btn primary", onclick: () => {
        const v = parseFloat(amt.value);
        if (!name.value.trim() || !(v > 0) || !date.value) { toast("Enter a name, an amount and a date"); return; }
        const key = "m:" + Math.random().toString(16).slice(2, 10);
        closeSheet();
        change(s => kind === "bill"
          ? s.bills_extra.push({ key, name: name.value.trim(), amount: v, date: date.value, repeat: rep.value, category: "" })
          : s.income_extra.push({ key, name: name.value.trim(), amount: v, next: date.value, every: +rep.value }));
      } }, "Add")]);
    setTimeout(() => name.focus(), 50);
  }

  function row(r, kind, label, sub) {
    const listOff = { income: "income_off", bill: "bills_off", spend: "spend_off" }[kind];
    const key = kind === "spend" ? r.category : r.key;
    const box = h("input", { type: "checkbox", checked: r.on, style: "width:22px;height:22px;margin-right:12px",
      onclick: e => e.stopPropagation(), onchange: e => toggle(listOff, key, e.target.checked) });
    const edit = () => {
      const extra = kind === "spend" && r.source === "your change"
        ? h("button", { class: "btn", onclick: () => { closeSheet(); change(s => delete s.spend_amount[r.category]); } }, "Use the estimate")
        : kind !== "spend" && !r.auto
          ? h("button", { class: "btn danger", onclick: () => { closeSheet(); change(s => {
              const l = kind === "income" ? "income_extra" : "bills_extra"; s[l] = s[l].filter(x => x.key !== r.key); }); } }, "Remove")
          : null;
      askAmount(label, r.amount, (s, v) => { (kind === "income" ? s.income_amount : kind === "bill" ? s.bills_amount : s.spend_amount)[key] = v; }, extra);
    };
    return h("div", { class: "li tap", style: r.on ? "" : "opacity:.5", onclick: edit },
      box, h("div", { class: "main" }, h("div", { class: "l1" }, label), h("div", { class: "l2" }, sub)),
      h("span", { class: "num amt" }, money(r.amount)));
  }
  const list = (rows, empty) => h("div", { class: "list" }, rows.length ? rows : h("div", { class: "li" }, h("span", { class: "muted" }, empty)));

  function view() {
    const p = plan(ui.offset);
    const top = h("div", { class: "filters", style: "margin-bottom:10px;align-items:center" },
      h("button", { class: "btn", disabled: ui.offset === 0, onclick: () => { ui.offset = Math.max(0, ui.offset - 1); render(); } }, "◀"),
      h("b", { style: "font-size:17px" }, p.needs_setup ? "No paychecks found yet" :
        `${ui.offset ? "Paycheck +" + ui.offset : "Next paycheck"}: ${nice(p.start)} → ${nice(p.end)}`),
      h("button", { class: "btn", disabled: !!p.needs_setup, onclick: () => { ui.offset++; render(); } }, "▶"),
      h("button", { class: "btn", onclick: () => addItem("bill") }, "Add a bill"),
      h("button", { class: "btn", onclick: () => addItem("income") }, "Add a paycheck"),
      h("button", { class: "link", onclick: () => confirmSheet("Undo my changes", "Undo all your planner changes (added bills and paychecks, changed amounts, switched-off items and savings)?",
        "Undo", () => { save(JSON.parse(JSON.stringify(DEFAULTS))); render(); }, true) }, "Undo my changes"));
    if (p.needs_setup) return h("div", {}, top, h("div", { class: "warnbox" },
      "I couldn't find a paycheck that arrives every 2 weeks in your Personal accounts. Import a few months of your checking account, or tap “Add a paycheck”."));
    const t = p.totals, sv = p.savings_setting, nxt = plan(ui.offset + 1);
    const warn = [];
    if (p.due_before_payday.length) warn.push(h("div", {}, h("b", {}, `Due before this payday (${money(p.due_before_payday.reduce((a, b) => a + b.amount, 0))})`),
      " - paid from money you already have: " + p.due_before_payday.slice(0, 6).map(b => `${b.name} ${money(b.amount)} on ${nice(b.date)}`).join(", ")));
    if (!nxt.needs_setup && nxt.totals.left_over < 0) warn.push(h("div", {}, h("b", {}, "Heads up: "),
      `the following paycheck (${nice(nxt.start)}) comes up ${money(-nxt.totals.left_over)} short. Consider keeping that much from this one.`));

    const mode = h("div", { class: "seg" }, [["amount", "Fixed amount"], ["percent", "Percent of pay"]].map(([m, l]) =>
      h("button", { class: sv.mode === m || (m === "amount" && sv.mode !== "percent") ? "on" : "", onclick: () => change(s => { s.savings = { mode: m, value: m === "percent" ? Math.min(100, +s.savings.value || 0) : +s.savings.value || 0 }; }) }, l)));
    const val = h("input", { type: "number", step: sv.mode === "percent" ? "1" : "10", inputmode: "decimal", value: +sv.value || 0, style: "width:120px" });
    val.onchange = () => change(s => { let v = Math.max(0, parseFloat(val.value) || 0); if (s.savings.mode === "percent") v = Math.min(100, v); s.savings.value = v; });

    const sec = t => h("div", { class: "section-title" }, t);
    return h("div", {}, top,
      h("p", { class: "muted", style: "margin:0 0 10px" }, "Personal accounts only. Tap an item to change its amount; untick anything that doesn't apply."),
      h("div", { class: "grid kpis" },
        kpi("Paycheck", money(t.income), `${p.income_rows.filter(r => r.on).length} deposit(s)`),
        kpi("Bills due", money(t.bills), `${p.bill_rows.filter(r => r.on).length} bills`),
        kpi("Everyday spending", money(t.spending), `for ${p.days} days`),
        kpi("Savings", money(t.savings), sv.mode === "percent" ? `${+sv.value || 0}% of pay` : "fixed amount"),
        kpi("Left over", money(t.left_over, true), t.left_over >= 0 ? "to spend freely" : "short - see what you can trim", t.left_over >= 0 ? "good" : "bad")),
      warn.length ? h("div", { class: "warnbox", style: "margin-top:12px" }, warn) : null,
      sec("Paychecks this period"), list(p.income_rows.map(r => row(r, "income", r.name, nice(r.date))), "No paychecks in this period"),
      sec("Bills due this period"), list(p.bill_rows.map(r => row(r, "bill", r.name, `${nice(r.date)} · ${r.how_often}`)), "No bills due in this period"),
      sec("Everyday spending for this period"), list(p.spend_rows.map(r => row(r, "spend", r.category, `Based on ${r.source}`)), "Nothing to estimate yet"),
      sec("Savings from this paycheck"), h("div", { class: "card", style: "display:flex;gap:12px;align-items:center;flex-wrap:wrap" },
        mode, val, h("span", { class: "muted" }, sv.mode === "percent" ? "% of this period's pay" : "dollars this period")));
  }

  window.FRPlanner = { plan, load, save };
  window.VIEWS_EXTRA = { ...(window.VIEWS_EXTRA || {}), planner: view };
})();
