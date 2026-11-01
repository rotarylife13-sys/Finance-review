/* App lock for the iPad: the same username + password as the laptop (hash stored in the shared data file),
   plus Face ID through a passkey kept in this iPad's Keychain. This locks the app's screens; it does not
   encrypt the data file. */
"use strict";
(function () {
  const ITER = 310000;
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const lock = { locked: false, hiddenAt: 0, last: Date.now() };

  async function pbkdf2(password, salt, iter) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
  }
  async function hashPassword(pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return `pbkdf2_sha256$${ITER}$${b64(salt)}$${b64(await pbkdf2(pw, salt, ITER))}`;
  }
  async function verifyPassword(pw, stored) {
    try {
      const [algo, it, salt, hsh] = stored.split("$");
      if (algo !== "pbkdf2_sha256") return false;
      const dk = await pbkdf2(pw, unb64(salt), +it), want = unb64(hsh);
      if (dk.length !== want.length) return false;
      let diff = 0; for (let i = 0; i < dk.length; i++) diff |= dk[i] ^ want[i];
      return diff === 0;
    } catch { return false; }
  }

  // Login settings live in the data file (shared with the laptop); a copy is cached so the lock works before/without loading.
  function info() {
    if (window.__fr && window.__fr.db) {
      const g = k => { try { return one("SELECT value FROM settings WHERE key=?", [k])?.value || ""; } catch { return ""; } };
      const i = { user: g("lock_user"), hash: g("lock_hash"), minutes: +(g("lock_minutes") || 10) };
      store.set("fr.lockCache", i);
      return i;
    }
    return store.get("fr.lockCache", { user: "", hash: "", minutes: 10 });
  }
  const enabled = () => !!info().hash;
  const passkeyId = () => store.get("fr.passkey", null);
  const canFaceId = () => !!(window.PublicKeyCredential && navigator.credentials);

  async function createPasskey(user) {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Finance Review", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: user || "finance-review", displayName: user || "Finance Review" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      timeout: 60000 } });
    store.set("fr.passkey", b64(cred.rawId));
  }
  async function faceId() {
    const id = passkeyId(); if (!id) return false;
    const a = await navigator.credentials.get({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: unb64(id) }], userVerification: "required", timeout: 60000 } });
    const flags = new Uint8Array(a.response.authenticatorData)[32];
    return !!(flags & 0x04);                 // "user verified" (Face ID / Touch ID / passcode) bit
  }

  // ---------------------------------------------------------------- lock screen
  const el = document.getElementById("lockScreen");
  function show() {
    const i = info();
    lock.locked = true;
    document.body.classList.add("locked");
    const user = h("input", { type: "text", value: i.user, placeholder: "Username", autocomplete: "username", autocapitalize: "off" });
    const pw = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
    const msg = h("p", { class: "lockmsg" });
    let fails = 0, waitUntil = 0;
    const tryPw = async () => {
      if (Date.now() < waitUntil) { msg.textContent = `Too many tries. Wait ${Math.ceil((waitUntil - Date.now()) / 1000)} seconds.`; return; }
      msg.textContent = "Checking…";
      const ok = user.value.trim().toLowerCase() === (i.user || "").toLowerCase() && await verifyPassword(pw.value, i.hash);
      if (ok) return hide();
      fails++; pw.value = ""; if (fails >= 5) waitUntil = Date.now() + 30000 * (fails - 4);
      msg.textContent = "Wrong username or password.";
    };
    const tryFace = async () => {
      msg.textContent = "";
      try { if (await faceId()) return hide(); msg.textContent = "Touch ID / Face ID didn't verify. Try again or use your password."; }
      catch (e) { msg.textContent = e.name === "NotAllowedError" ? "Cancelled." : "Touch ID / Face ID isn't available: " + e.message; }
    };
    pw.addEventListener("keydown", e => { if (e.key === "Enter") tryPw(); });
    const hasFace = canFaceId() && passkeyId();
    el.replaceChildren(h("div", { class: "lockcard" },
      h("h2", {}, "Finance Review"), h("p", { class: "muted" }, "Locked"),
      hasFace ? h("button", { class: "btn primary big", onclick: tryFace }, "Unlock with Touch ID / Face ID") : null,
      hasFace ? h("p", { class: "muted", style: "text-align:center" }, "or sign in with your password") : null,
      user, pw, h("button", { class: "btn " + (hasFace ? "" : "primary") + " big", onclick: tryPw }, "Sign in"), msg,
      h("button", { class: "link", onclick: async () => {
        if (hasFace) {
          try { if (await faceId()) { hide(); setTab("more"); toast("Set a new password under Security", 5000); return; } } catch { }
        }
        msg.textContent = "Use Touch ID / Face ID to confirm it's you, or reset the password from Finance Review on your laptop.";
      } }, "Forgot password?")));
    el.hidden = false;
    if (!i.user) user.focus();
  }
  function hide() {
    lock.locked = false; lock.last = Date.now(); lock.unlockedOnce = true;
    el.hidden = true; el.replaceChildren();
    document.body.classList.remove("locked");
  }
  function lockNow() { if (enabled()) show(); }

  // auto-lock: after N minutes in the background or without touches
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) lock.hiddenAt = Date.now();
    else if (enabled() && !lock.locked && lock.hiddenAt) {
      const m = info().minutes;
      if (m && Date.now() - lock.hiddenAt > m * 60000) show();
    }
  });
  ["pointerdown", "keydown", "scroll"].forEach(ev => document.addEventListener(ev, () => (lock.last = Date.now()), true));
  setInterval(() => { const m = info().minutes; if (enabled() && !lock.locked && m && Date.now() - lock.last > m * 60000) show(); }, 15000);

  // ---------------------------------------------------------------- settings section (More tab)
  function settingsView() {
    const i = info(), on = !!i.hash;
    const user = h("input", { type: "text", value: i.user, placeholder: "Username", autocapitalize: "off" });
    const cur = h("input", { type: "password", placeholder: "Current password" });
    const p1 = h("input", { type: "password", placeholder: on ? "New password (leave blank to keep)" : "Password (8+ characters)", autocomplete: "new-password" });
    const p2 = h("input", { type: "password", placeholder: "Repeat password", autocomplete: "new-password" });
    const mins = h("select", {}, [["1 minute", 1], ["5 minutes", 5], ["10 minutes", 10], ["30 minutes", 30], ["1 hour", 60], ["Never", 0]]
      .map(([l, m]) => h("option", { value: m, selected: m === (on ? i.minutes : 10) }, l)));
    const face = h("input", { type: "checkbox", checked: !!passkeyId(), disabled: !canFaceId() });
    const save = async () => {
      if (!user.value.trim()) return toast("Enter a username");
      if (on && !(await verifyPassword(cur.value, i.hash))) return toast("Your current password is wrong");
      if (p1.value || !on) {
        if (p1.value.length < 8) return toast("Use at least 8 characters for the password");
        if (p1.value !== p2.value) return toast("The two passwords don't match");
        run("INSERT OR REPLACE INTO settings VALUES ('lock_hash', ?)", [await hashPassword(p1.value)]);
      }
      run("INSERT OR REPLACE INTO settings VALUES ('lock_user', ?)", [user.value.trim()]);
      run("INSERT OR REPLACE INTO settings VALUES ('lock_minutes', ?)", [String(mins.value)]);
      if (face.checked && !passkeyId()) {
        try { await createPasskey(user.value.trim()); toast("Touch ID / Face ID turned on"); }
        catch (e) { face.checked = false; toast("Touch ID / Face ID wasn't set up: " + (e.message || e.name), 6000); }
      } else if (!face.checked && passkeyId()) store.del("fr.passkey");
      info(); toast("Sign-in saved"); render();
    };
    const off = async () => {
      if (!(await verifyPassword(cur.value, i.hash))) return toast("Enter your current password to turn sign-in off");
      for (const k of ["lock_user", "lock_hash", "lock_minutes"]) run("DELETE FROM settings WHERE key=?", [k]);
      store.del("fr.passkey"); info(); toast("Sign-in turned off"); render();
    };
    return h("div", {},
      h("div", { class: "section-title" }, "Security"),
      h("div", { class: "card" },
        h("p", { class: "muted", style: "margin-top:0" }, "Ask for a username and password when the app opens and after it sits unused. " +
          "The same login works in Finance Review on your laptop. This locks the app; it doesn't encrypt the data file."),
        h("div", { class: "field" }, h("span", {}, "Username"), user),
        on ? h("div", { class: "field" }, h("span", {}, "Current password"), cur) : null,
        h("div", { class: "field" }, h("span", {}, on ? "New password" : "Password"), p1, p2),
        h("div", { class: "field" }, h("span", {}, "Lock after no use for"), mins),
        h("label", { class: "field", style: "flex-direction:row;align-items:center;gap:8px" }, face,
          h("span", { style: "font-size:15px;color:inherit" }, canFaceId() ? "Unlock with Touch ID / Face ID on this iPad" : "Touch ID / Face ID isn't available in this browser")),
        h("div", { class: "row-btns" }, h("button", { class: "btn primary", onclick: save }, on ? "Save" : "Turn on sign-in"),
          on ? h("button", { class: "btn", onclick: lockNow }, "Lock now") : null,
          on ? h("button", { class: "btn danger", onclick: off }, "Turn off sign-in") : null)));
  }

  // after the data file loads: lock if sign-in was turned on elsewhere (e.g. on the laptop) and we haven't unlocked yet
  function checkAfterLoad() { info(); if (enabled() && !lock.locked && !lock.unlockedOnce) show(); }
  window.FRLock = { show, hide, lockNow, enabled, info, settingsView, verifyPassword, hashPassword, checkAfterLoad, get locked() { return lock.locked; } };
  if (enabled()) show();       // lock immediately on open, before any data is shown
})();
