/* Assistant tab for the iPad app: same tools and instructions as the laptop app.
   The API key is stored only in this iPad's browser storage - never in OneDrive or on GitHub. */
"use strict";
(function () {
  const AG = FR.agent;
  const API = () => store.get("fr.apiUrl", "https://api.anthropic.com/v1/messages");
  const r2 = v => Math.round(v * 100) / 100;
  const ownerOf = i => i.owner || "All";
  const monthsBack = n => { const t = new Date(); return iso(new Date(t.getFullYear(), t.getMonth() - (n - 1), 1)); };
  const STEP = { get_overview: "Reading your overview", get_monthly_trend: "Comparing months", get_recurring: "Checking recurring charges",
    get_budget: "Checking budgets", get_accounts: "Looking at accounts", search_transactions: "Searching transactions",
    run_sql: "Digging into the data", propose_change: "Preparing a suggestion" };

  const chat = { messages: [], history: [], proposals: [], busy: false, step: "" };

  const tools = {
    get_overview(i) {
      const owner = ownerOf(i), end = i.end || iso(new Date()), ts = txns({ owner, start: i.start, end });
      const s = summary(ts), nw = netWorth(owner), unc = ts.filter(t => t.category === "Uncategorized");
      return { owner, start: i.start || ts.reduce((m, t) => (t.date < m ? t.date : m), "9999"), end, transactions: ts.length,
        income: r2(s.income), spending: r2(s.spending), net: r2(s.net),
        spending_by_category: byCategory(ts).map(([c, v]) => [c, r2(v)]), top_merchants: topMerchants(ts, 15).map(([m, v, n]) => [m, r2(v), n]),
        uncategorized: { count: unc.length, total: r2(-unc.reduce((a, t) => a + t.amount, 0)) },
        net_worth_today: { assets: r2(nw.assets), debts: r2(nw.liabilities), net: r2(nw.net) } };
    },
    get_monthly_trend(i) {
      const owner = ownerOf(i), n = Math.max(1, Math.min(+(i.months || 6), 36));
      const ts = txns({ owner, start: monthsBack(n), end: iso(new Date()) }), cats = {};
      for (const t of spendingRows(ts)) { const m = t.date.slice(0, 7); (cats[t.category] ||= {}); cats[t.category][m] = (cats[t.category][m] || 0) - t.amount; }
      for (const c in cats) for (const m in cats[c]) cats[c][m] = r2(cats[c][m]);
      const mon = monthly(ts); for (const m in mon) { mon[m].income = r2(mon[m].income); mon[m].spending = r2(mon[m].spending); }
      return { owner, months: mon, spending_by_category_by_month: cats };
    },
    get_recurring(i) {
      const owner = ownerOf(i), ts = txns({ owner }), rec = recurring(ts, iso(new Date())), act = rec.filter(r => r.active);
      return { owner, active_count: act.length, monthly_total: r2(act.reduce((a, r) => a + r.monthly, 0)),
        yearly_total: r2(act.reduce((a, r) => a + r.yearly, 0)),
        recurring: rec.map(r => ({ ...r, amount: r2(r.amount), yearly: r2(r.yearly), monthly: r2(r.monthly) })),
        possible_duplicates: duplicates(ts).slice(0, 30).map(([a, b]) => ({ description: a.description, account: a.account, amount: a.amount,
          dates: [a.date, b.date], transaction_ids: [a.id, b.id] })) };
    },
    get_budget(i) {
      const owner = ownerOf(i), month = i.month || iso(new Date()).slice(0, 7), { rows, end } = budgetReport(owner, month);
      return { owner, month, month_end: end, today: iso(new Date()),
        rows: rows.map(r => ({ category: r.category, budget: r2(r.budget), actual: r2(r.actual), avg3: r2(r.avg3) })) };
    },
    get_accounts(i) {
      return { accounts: netWorth(ownerOf(i)).rows.map(([a, b]) => {
        const s = latestSnapshot(a.id), x = one("SELECT COUNT(*) AS n, MIN(date) AS lo, MAX(date) AS hi FROM transactions WHERE account_id=?", [a.id]);
        return { name: a.name, institution: a.institution, owner: a.owner, type: a.type, balance: r2(b),
          balance_last_checked: s ? s.date : null, transactions: x.n, first_date: x.lo, last_date: x.hi }; }) };
    },
    search_transactions(i) {
      let s = "SELECT t.id, t.date, a.name AS account, a.owner, t.description, t.category, t.amount, t.note FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE 1=1";
      const p = [];
      if (i.text) { s += " AND (t.description LIKE ? OR t.note LIKE ?)"; p.push(`%${i.text}%`, `%${i.text}%`); }
      if (i.category) { s += " AND t.category=?"; p.push(i.category); }
      if (i.account) { s += " AND a.name LIKE ?"; p.push(`%${i.account}%`); }
      if (i.owner && i.owner !== "All") { s += " AND a.owner=?"; p.push(i.owner); }
      if (i.start) { s += " AND t.date>=?"; p.push(i.start); }
      if (i.end) { s += " AND t.date<=?"; p.push(i.end); }
      if (i.min_amount) { s += " AND ABS(t.amount)>=?"; p.push(Math.abs(+i.min_amount)); }
      const rows = q(s + " ORDER BY t.date DESC", p), lim = Math.max(1, Math.min(+(i.limit || 40), 200));
      return { count: rows.length, total_in: r2(rows.filter(r => r.amount > 0).reduce((a, r) => a + r.amount, 0)),
        total_out: r2(rows.filter(r => r.amount < 0).reduce((a, r) => a + r.amount, 0)), rows: rows.slice(0, lim), truncated: rows.length > lim };
    },
    run_sql(i) {
      const sql = (i.sql || "").trim().replace(/;\s*$/, "");
      if (!/^(select|with)\b/i.test(sql) || sql.includes(";") ||
          /\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex)\b/i.test(sql))
        return { error: "Only a single read-only SELECT statement is allowed." };
      const st = db.prepare(sql), rows = []; let cols = [];
      try { while (st.step() && rows.length < 201) { if (!cols.length) cols = st.getColumnNames(); rows.push(st.get()); } }
      finally { st.free(); }
      return { columns: cols, rows: rows.slice(0, 200), truncated: rows.length > 200 };
    },
    propose_change(i) {
      if (i.kind === "set_category" && !(i.transaction_ids?.length && i.category)) return { error: "set_category needs transaction_ids and category" };
      if (i.kind === "add_rule" && !(i.pattern && i.category)) return { error: "add_rule needs pattern and category" };
      if (i.kind === "set_budget" && !(["Personal", "Business"].includes(i.owner) && i.category && i.amount != null)) return { error: "set_budget needs owner, category and amount" };
      chat.proposals.push({ ...i, id: chat.proposals.length + 1, applied: false });
      return { ok: true, note: "Shown to the user with an Apply button. Not applied yet." };
    },
  };

  function applyProposal(p) {
    if (p.kind === "set_category") { const ids = p.transaction_ids.map(Number);
      for (const id of ids) db.run("UPDATE transactions SET category=?, cat_manual=1 WHERE id=?", [p.category, id]); markDirty(); return `Re-categorized ${ids.length} transaction(s).`; }
    if (p.kind === "add_rule") { run("INSERT INTO rules(pattern, category, owner, priority) VALUES (?,?,?,10)", [p.pattern, p.category, p.owner || null]); return `Rule added; ${applyRules()} transactions updated.`; }
    run("INSERT OR REPLACE INTO budgets VALUES (?,?,?)", [p.owner, p.category, +p.amount]); return "Budget set.";
  }

  // Keys pasted on iPad sometimes pick up spaces, line breaks or invisible characters, which make the request fail before it is sent.
  const cleanKey = k => (k || "").replace(/[^\x21-\x7E]/g, "");
  async function callApi(payload) {
    const key = cleanKey(store.get("fr.apiKey", ""));
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("That doesn't look like a complete API key (it should start with sk-ant-). Re-paste it in Settings.");
    let r;
    try {
      r = await fetch(API(), { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json",
        "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify(payload) });
    } catch (e) {
      const online = navigator.onLine === false ? "This iPad is offline." : "";
      throw new Error(`Couldn't reach the Claude API. ${online} Details: ${e && e.message ? e.message : e}`);
    }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error("The API key was rejected. Check it in Assistant settings.");
    if (!r.ok) throw new Error(`Claude API error ${r.status}: ${j?.error?.message || ""}`);
    return j;
  }

  async function ask(text) {
    if (!store.get("fr.apiKey", "")) { settings(); return; }
    chat.history.push(["you", text]); chat.busy = true; chat.step = "Thinking"; render();
    const mark = chat.messages.length;
    chat.messages.push({ role: "user", content: text });
    const today = new Date();
    const system = AG.system + `\nToday is ${today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })} (${iso(today)}). The app's View filter is currently '${state.owner}'.`;
    try {
      for (let round = 0; round < 10; round++) {
        const resp = await callApi({ model: store.get("fr.model", AG.models[0][0]), max_tokens: 4000, system, tools: AG.tools, messages: chat.messages });
        const content = resp.content || [];
        chat.messages.push({ role: "assistant", content });
        const uses = content.filter(b => b.type === "tool_use");
        if (resp.stop_reason !== "tool_use" || !uses.length) {
          chat.history.push(["claude", content.filter(b => b.type === "text").map(b => b.text).join("\n").trim() || "(no answer)"]); break;
        }
        const results = [];
        for (const u of uses) {
          chat.step = STEP[u.name] || "Working"; render();
          let out; try { out = tools[u.name] ? tools[u.name](u.input || {}) : { error: "unknown tool" }; } catch (e) { out = { error: e.message }; }
          let s = JSON.stringify(out); if (s.length > 20000) s = s.slice(0, 20000) + '..."(truncated - narrow the request)"';
          results.push({ type: "tool_result", tool_use_id: u.id, content: s });
        }
        chat.messages.push({ role: "user", content: results });
        if (round === 9) chat.history.push(["claude", "I ran out of steps on that one - try asking something narrower."]);
      }
    } catch (e) {
      chat.messages.length = mark;     // drop the failed turn
      chat.history.push(["error", e.message]);
    }
    chat.busy = false; chat.step = ""; render();
  }

  function settings() {
    const key = h("input", { type: "password", value: store.get("fr.apiKey", ""), placeholder: "sk-ant-..." });
    const model = h("select", {}, AG.models.map(([id, label]) => h("option", { value: id, selected: id === store.get("fr.model", AG.models[0][0]) }, label)));
    sheet("Assistant settings", h("div", {},
      h("div", { class: "field" }, h("span", {}, "Anthropic API key"), key),
      h("div", { class: "field" }, h("span", {}, "Model"), model),
      h("p", { class: "muted" }, "Get a key at console.anthropic.com → API Keys (pay-as-you-go; a review costs a few cents). " +
        "The key stays on this iPad only.")),
      [h("button", { class: "btn", onclick: async () => {
          store.set("fr.apiKey", cleanKey(key.value)); store.set("fr.model", model.value);
          toast("Testing…", 8000);
          try { await callApi({ model: model.value, max_tokens: 5, messages: [{ role: "user", content: "Reply OK" }] }); toast("Connection works ✓", 4000); }
          catch (e) { toast(e.message, 9000); } } }, "Test"),
       h("button", { class: "btn primary", onclick: () => { store.set("fr.apiKey", cleanKey(key.value)); store.set("fr.model", model.value); store.del("fr.apiUrl"); closeSheet(); toast("Saved"); } }, "Save")]);
  }

  // small, safe markdown renderer (escapes everything first)
  function md(src) {
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
    const lines = src.replace(/\r/g, "").split("\n"), out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
        const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        let t = "<div class='scroll-x'><table class='t'><tr>" + cells(l).map(c => `<th>${inline(c)}</th>`).join("") + "</tr>";
        i += 2; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { t += "<tr>" + cells(lines[i]).map(c => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++; }
        i--; out.push(t + "</table></div>"); continue;
      }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) out.push(`<h${Math.min(4, m[1].length + 2)}>${inline(m[2])}</h${Math.min(4, m[1].length + 2)}>`);
      else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { let u = "<ul>"; while (i < lines.length && (m = lines[i].match(/^\s*[-*•]\s+(.*)/))) { u += `<li>${inline(m[1])}</li>`; i++; } i--; out.push(u + "</ul>"); }
      else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { let u = "<ol>"; while (i < lines.length && (m = lines[i].match(/^\s*\d+[.)]\s+(.*)/))) { u += `<li>${inline(m[1])}</li>`; i++; } i--; out.push(u + "</ol>"); }
      else if (/^\s*(---|\*\*\*)\s*$/.test(l)) out.push("<hr>");
      else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
    }
    return out.join("");
  }

  function view() {
    const box = h("div", { class: "chat" });
    if (!chat.history.length) box.append(h("div", { class: "card" }, h("h3", {}, "Ask about your finances"),
      h("p", {}, "I can review your accounts, explain where your money goes, find subscriptions and recurring charges, spot problems like duplicate charges or price increases, suggest savings, and summarize any period - personal or business."),
      h("p", { class: "muted" }, "Your transactions are sent to Anthropic's API to answer. Suggested changes only happen when you tap Apply.")));
    for (const [who, text] of chat.history) {
      if (who === "you") box.append(h("div", { class: "msg you" }, text));
      else if (who === "claude") box.append(h("div", { class: "msg claude", html: md(text) }));
      else if (who === "error") box.append(h("div", { class: "msg err" }, "Problem: " + text));
      else box.append(h("div", { class: "muted", style: "margin:6px 2px" }, text));
    }
    const pend = chat.proposals.filter(p => !p.applied);
    if (pend.length) box.append(h("div", { class: "card", style: "margin-top:10px" }, h("h3", {}, "Suggested changes"),
      h("p", { class: "muted" }, "Nothing changes until you tap Apply."),
      pend.map(p => h("div", { class: "li" }, h("div", { class: "main" }, p.summary),
        h("button", { class: "btn primary", onclick: () => { const m = applyProposal(p); p.applied = true; chat.history.push(["note", "Applied: " + m]); render(); } }, "Apply")))));
    if (chat.busy) box.append(h("div", { class: "muted", style: "margin:10px 2px" }, `${chat.step}…`));
    const input = h("textarea", { rows: 2, placeholder: "Ask anything about your money…", class: "ask" });
    const send = () => { const t = input.value.trim(); if (t && !chat.busy) ask(t); };
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 0);
    return h("div", {},
      h("div", { class: "quick" }, AG.quick.map(([label, prompt]) => h("button", { class: "btn", disabled: chat.busy, onclick: () => ask(prompt) }, label)),
        h("button", { class: "link", onclick: () => { if (!chat.busy) { chat.messages = []; chat.history = []; chat.proposals = []; render(); } } }, "New chat"),
        h("button", { class: "link", onclick: settings }, "Settings")),
      box,
      h("div", { class: "askbar" }, input, h("button", { class: "btn primary", disabled: chat.busy, onclick: send }, "Send")));
  }

  window.VIEWS_EXTRA = { assistant: view };
  window.__assistant = { chat, tools, md };
})();
