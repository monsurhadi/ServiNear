"use strict";
(() => {
  const API = String(window.SERVINEAR_API_BASE || "").trim().replace(/\/+$/, "");
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const taka = (n) => "৳" + Number(n || 0).toLocaleString();
  const when = (s) => (s ? new Date(String(s).replace(" ", "T") + (String(s).includes("Z") ? "" : "Z")).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      credentials: "include",
      ...opts,
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) }
    });
    if (opts.raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { status: res.status });
    return data;
  }
  const send = (path, method, body) => api(path, { method, body: JSON.stringify(body || {}) });

  let toastT;
  function toast(msg, err = false) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 3200);
  }
  function ask(title, text, okLabel = "Confirm", danger = true) {
    return new Promise((resolve) => {
      const d = $("#dlg"); $("#dlg-title").textContent = title; $("#dlg-text").innerHTML = text;
      const ok = $("#dlg-ok"); ok.textContent = okLabel; ok.className = "btn " + (danger ? "danger" : "primary");
      d.onclose = () => resolve(d.returnValue === "ok"); d.showModal();
    });
  }
  function showImage(src) { const d = $("#dlg"); $("#dlg-title").textContent = "Document"; $("#dlg-text").innerHTML = `<img alt="" src="${esc(src)}">`; $("#dlg-ok").className = "btn hidden"; d.onclose = () => ($("#dlg-ok").className = "btn danger"); d.showModal(); }

  const pill = (t, kind = "") => `<span class="pill ${kind}">${esc(t)}</span>`;
  const statusKind = { open: "info", accepted: "warn", completed: "ok", cancelled: "bad", active: "ok", suspended: "bad", held: "warn", released: "ok", refunded: "info", pending: "warn", approved: "ok", rejected: "bad", resolved: "ok", reviewing: "warn" };
  const st = (s) => pill(s, statusKind[s] || "");

  const SECTIONS = [
    ["overview", "Overview"], ["users", "Users"], ["tasks", "Tasks"], ["verify", "Verification"], ["payments", "Payments"],
    ["reviews", "Reviews"], ["support", "Support"], ["categories", "Categories"], ["audit", "Audit log"]
  ];
  const S = { view: "overview", me: null, badges: {}, users: { page: 1, q: "", role: "", status: "" }, tasks: { page: 1, q: "", status: "" } };

  function nav() {
    $("#nav").innerHTML = SECTIONS.map(([id, label]) => {
      const n = S.badges[id];
      return `<button data-view="${id}" class="${S.view === id ? "on" : ""}">${label}${n ? `<span class="count">${n}</span>` : ""}</button>`;
    }).join("");
  }
  function go(view) { S.view = view; location.hash = view; nav(); $("#title").textContent = SECTIONS.find((s) => s[0] === view)[1]; $("#top-actions").innerHTML = ""; load(); }

  async function load() {
    const v = $("#view"); v.innerHTML = '<div class="grid kpis"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>';
    try { await VIEWS[S.view](v); } catch (e) {
      if (e.status === 401 || e.status === 403) return gate(e.message);
      v.innerHTML = `<div class="card empty">Could not load this section.<br><small>${esc(e.message)}</small></div>`;
    }
  }

  function table(cols, rows, empty = "Nothing here yet.") {
    if (!rows.length) return `<div class="card empty">${empty}</div>`;
    return `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${c[1](r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  function pager(key, total, limit = 25) {
    const page = S[key].page, pages = Math.max(1, Math.ceil(total / limit));
    return `<div class="pager"><span>${total.toLocaleString()} total · page ${page} of ${pages}</span><span class="acts"><button class="btn sm" data-page="${key}:${page - 1}" ${page <= 1 ? "disabled" : ""}>Previous</button><button class="btn sm" data-page="${key}:${page + 1}" ${page >= pages ? "disabled" : ""}>Next</button></span></div>`;
  }
  function days30() { const out = []; for (let i = 29; i >= 0; i--) out.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10)); return out; }
  function bars(series, label) {
    const map = Object.fromEntries(series.map((r) => [r.day, r.n])), ds = days30(), vals = ds.map((d) => map[d] || 0), max = Math.max(1, ...vals);
    return `<div class="bars" role="img" aria-label="${esc(label)} over the last 30 days">${vals.map((n, i) => `<i style="height:${Math.max(2, (n / max) * 100)}%" title="${ds[i]}: ${n}"></i>`).join("")}</div><div class="axis"><span>30 days ago</span><span>${vals.reduce((a, b) => a + b, 0)} total</span><span>Today</span></div>`;
  }

  const VIEWS = {
    async overview(v) {
      const d = await api("/api/admin/overview"), t = d.totals;
      S.badges = { verify: t.pendingNid, support: t.openTickets }; nav();
      const k = (label, val, sub = "") => `<div class="card kpi"><small>${label}</small><strong>${val}</strong><em>${sub}</em></div>`;
      const maxCat = Math.max(1, ...d.topCategories.map((c) => c.n));
      v.innerHTML = `<div class="grid kpis">
        ${k("Total users", t.users.toLocaleString(), `${t.customers} customers · ${t.providers} providers`)}
        ${k("Verified providers", t.verifiedProviders, `${t.providers ? Math.round((t.verifiedProviders / t.providers) * 100) : 0}% of providers`)}
        ${k("Open tasks", t.jobsOpen, `${t.jobsAccepted} in progress · ${t.jobsCompleted} done`)}
        ${k("Offers", t.offers)}${k("Escrow held", taka(t.escrowHeld), `${taka(t.escrowReleased)} released`)}
        ${k("Pending NID", t.pendingNid, "awaiting review")}${k("Open tickets", t.openTickets)}${k("Suspended", t.suspended, "accounts")}
      </div>
      <div class="grid two">
        <div class="card"><h3>New sign-ups</h3>${bars(d.signups, "Sign-ups")}</div>
        <div class="card"><h3>Tasks posted</h3>${bars(d.jobsPosted, "Tasks posted")}</div>
        <div class="card"><h3>Top categories</h3>${d.topCategories.length ? d.topCategories.map((c) => `<div class="hbar"><span>${esc(c.name)}</span><span><b style="width:${(c.n / maxCat) * 100}%"></b></span><span>${c.n}</span></div>`).join("") : '<div class="empty">No tasks yet.</div>'}</div>
        <div class="card"><h3>Recent admin activity</h3>${d.recentAudit.length ? d.recentAudit.map((a) => `<div style="padding:7px 0;border-bottom:1px solid #f0eadb"><strong>${esc(a.action)}</strong> <span class="sub" style="color:var(--muted)">${esc(a.actor_name)} · ${when(a.created_at)}</span></div>`).join("") : '<div class="empty">No activity yet.</div>'}</div>
      </div>`;
    },

    async users(v) {
      const f = S.users, qs = new URLSearchParams({ page: f.page, q: f.q, role: f.role, status: f.status });
      const d = await api("/api/admin/users?" + qs);
      $("#top-actions").innerHTML = '<button class="btn" data-export="users">Export CSV</button>';
      v.innerHTML = `<div class="tools"><input id="uq" placeholder="Search name, email or phone" value="${esc(f.q)}"><select id="urole"><option value="">All roles</option>${["customer", "worker", "admin"].map((r) => `<option ${f.role === r ? "selected" : ""}>${r}</option>`).join("")}</select><select id="ustatus"><option value="">Any status</option>${["active", "suspended"].map((r) => `<option ${f.status === r ? "selected" : ""}>${r}</option>`).join("")}</select></div>` +
        table([
          ["User", (u) => `<strong>${esc(u.name)}</strong><span class="sub">${esc(u.email)}${u.google ? " · Google" : ""}</span>`],
          ["Role", (u) => pill(u.role === "worker" ? "provider" : u.role, u.role === "admin" ? "info" : "")],
          ["Status", (u) => st(u.status) + (u.role === "worker" ? " " + (u.verified ? pill("verified", "ok") : pill("unverified", "warn")) : "")],
          ["Last login", (u) => when(u.last_login_at)],
          ["Actions", (u) => `<div class="acts">${u.role === "worker" ? `<button class="btn sm" data-act="verify" data-id="${u.id}" data-v="${u.verified ? 0 : 1}">${u.verified ? "Unverify" : "Verify"}</button>` : ""}<button class="btn sm" data-act="${u.status === "active" ? "suspend" : "activate"}" data-id="${u.id}" data-name="${esc(u.name)}">${u.status === "active" ? "Suspend" : "Activate"}</button><button class="btn sm ghost" data-act="role" data-id="${u.id}" data-role="${u.role}">Role</button><button class="btn sm ghost" data-act="revoke" data-id="${u.id}">Sign out</button></div>`]
        ], d.rows, "No users match.") + pager("users", d.total);
    },

    async tasks(v) {
      const f = S.tasks, d = await api("/api/admin/jobs?" + new URLSearchParams({ page: f.page, q: f.q, status: f.status }));
      $("#top-actions").innerHTML = '<button class="btn" data-export="jobs">Export CSV</button>';
      v.innerHTML = `<div class="tools"><input id="tq" placeholder="Search title, area or customer" value="${esc(f.q)}"><select id="tstatus"><option value="">Any status</option>${["open", "accepted", "completed", "cancelled"].map((r) => `<option ${f.status === r ? "selected" : ""}>${r}</option>`).join("")}</select></div>` +
        table([
          ["Task", (j) => `<strong>${esc(j.title)}</strong><span class="sub">${esc(j.category)} · ${esc(j.area)} · by ${esc(j.customer)}</span>`],
          ["Budget", (j) => taka(j.budget)], ["Offers", (j) => j.offers], ["Status", (j) => st(j.status)], ["Posted", (j) => when(j.created_at)],
          ["Actions", (j) => `<div class="acts"><button class="btn sm" data-act="jstatus" data-id="${j.id}" data-s="${j.status}">Status</button><button class="btn sm danger" data-act="jdelete" data-id="${j.id}" data-name="${esc(j.title)}">Delete</button></div>`]
        ], d.rows, "No tasks match.") + pager("tasks", d.total);
    },

    async verify(v) {
      const list = await api("/api/admin/nid-applications");
      v.innerHTML = table([
        ["Applicant", (a) => `<strong>${esc(a.name)}</strong><span class="sub">${esc(a.email)} · ${esc(a.phone || "no phone")}</span>`],
        ["Documents", (a) => `<div class="nidimgs">${[a.nid_front, a.nid_back, a.selfie_nid].filter(Boolean).map((s) => `<img alt="Document" loading="lazy" data-img="${esc(s)}" src="${esc(s)}">`).join("")}</div>`],
        ["Status", (a) => st(a.status)], ["Submitted", (a) => when(a.created_at)],
        ["Actions", (a) => a.status === "pending" ? `<div class="acts"><button class="btn sm primary" data-act="nid" data-id="${a.user_id}" data-a="approve">Approve</button><button class="btn sm danger" data-act="nid" data-id="${a.user_id}" data-a="reject">Reject</button></div>` : "—"]
      ], list, "No verification applications.");
    },

    async payments(v) {
      const d = await api("/api/admin/payments");
      v.innerHTML = `<h3>Escrows</h3>` + table([
        ["Task", (e) => `#${e.job_id}`], ["Customer → Provider", (e) => `${esc(e.customer)} → ${esc(e.provider)}`], ["Amount", (e) => taka(e.amount)], ["Status", (e) => st(e.status)], ["Created", (e) => when(e.created_at)]
      ], d.escrows, "No escrows yet.") + `<h3 style="margin-top:22px">Transactions</h3>` + table([
        ["User", (t) => esc(t.user)], ["Type", (t) => pill(t.type.replace("_", " "))], ["Amount", (t) => taka(t.amount)], ["Method", (t) => esc(t.payment_method || "—")], ["Reference", (t) => esc(t.trx_id || "—")], ["Date", (t) => when(t.created_at)]
      ], d.transactions, "No transactions yet.");
    },

    async reviews(v) {
      const rows = await api("/api/admin/reviews");
      v.innerHTML = table([
        ["Provider", (r) => esc(r.provider)], ["Customer", (r) => esc(r.customer)], ["Rating", (r) => "★".repeat(r.rating) + "☆".repeat(5 - r.rating)],
        ["Comment", (r) => esc(r.comment || "—")], ["Date", (r) => when(r.created_at)],
        ["", (r) => `<button class="btn sm danger" data-act="rdelete" data-id="${r.id}">Remove</button>`]
      ], rows, "No reviews yet.");
    },

    async support(v) {
      const rows = await api("/api/admin/support");
      S.badges.support = rows.filter((r) => r.status !== "resolved").length; nav();
      $("#top-actions").innerHTML = '<button class="btn" data-export="tickets">Export CSV</button>';
      v.innerHTML = table([
        ["From", (t) => `<strong>${esc(t.name)}</strong><span class="sub">${esc(t.email)}</span>`],
        ["Request", (t) => `<strong>${esc(t.subject)}</strong><span class="sub">${esc(t.message.slice(0, 220))}${t.message.length > 220 ? "…" : ""}</span>`],
        ["Status", (t) => st(t.status)], ["Received", (t) => when(t.created_at)],
        ["", (t) => `<div class="acts">${["open", "reviewing", "resolved"].filter((s) => s !== t.status).map((s) => `<button class="btn sm" data-act="ticket" data-id="${t.id}" data-s="${s}">${s === "resolved" ? "Resolve" : s === "reviewing" ? "Review" : "Reopen"}</button>`).join("")}<a class="btn sm ghost" href="mailto:${esc(t.email)}?subject=Re: ${encodeURIComponent(t.subject)}">Reply</a></div>`]
      ], rows, "No support requests.");
    },

    async categories(v) {
      const items = await api("/api/admin/categories");
      v.innerHTML = `<form class="row-form" id="catform"><input name="name" placeholder="New category name" required minlength="2" maxlength="60"><input name="description" placeholder="Short description" maxlength="160"><button class="btn primary">Add category</button></form>` +
        table([["Category", (c) => `<strong>${esc(c.name)}</strong>`], ["Description", (c) => esc(c.description || "—")], ["Tasks", (c) => c.tasks],
          ["", (c) => `<div class="acts"><button class="btn sm" data-act="cedit" data-id="${c.id}" data-d="${esc(c.description || "")}">Edit</button><button class="btn sm danger" data-act="cdelete" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button></div>`]
        ], items);
    },

    async audit(v) {
      const rows = await api("/api/admin/audit?limit=200");
      v.innerHTML = table([["When", (a) => when(a.created_at)], ["Admin", (a) => esc(a.actor_name)], ["Action", (a) => `<strong>${esc(a.action)}</strong>`], ["Target", (a) => esc(a.entity ? `${a.entity} ${a.entity_id}` : "")], ["Detail", (a) => `<code>${esc(a.detail || "")}</code>`], ["IP", (a) => esc(a.ip || "")]], rows, "No admin activity recorded yet.");
    }
  };

  async function exportCsv(kind) {
    try {
      const res = await api(`/api/admin/export/${kind}.csv`, { raw: true });
      if (!res.ok) throw new Error("Export failed.");
      const url = URL.createObjectURL(await res.blob()), a = document.createElement("a");
      a.href = url; a.download = `servinear-${kind}.csv`; a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, true); }
  }

  async function act(el) {
    const { act: a, id } = el.dataset;
    try {
      if (a === "verify") { await send(`/api/admin/users/${id}`, "PATCH", { verified: el.dataset.v === "1" }); toast("Updated"); }
      else if (a === "suspend") { if (!(await ask("Suspend account?", `<b>${esc(el.dataset.name)}</b> will be signed out and hidden from search until reactivated.`, "Suspend"))) return; await send(`/api/admin/users/${id}`, "PATCH", { status: "suspended" }); toast("Account suspended"); }
      else if (a === "activate") { await send(`/api/admin/users/${id}`, "PATCH", { status: "active" }); toast("Account reactivated"); }
      else if (a === "revoke") { const r = await send(`/api/admin/users/${id}/revoke-sessions`, "POST"); toast(`Signed out of ${r.revoked} session(s)`); return; }
      else if (a === "role") { const role = prompt("New role: customer, worker or admin", el.dataset.role); if (!role) return; if (role === "admin" && !(await ask("Grant admin access?", "This user will get full control of the platform.", "Grant admin"))) return; await send(`/api/admin/users/${id}`, "PATCH", { role: role.trim().toLowerCase() }); toast("Role updated"); }
      else if (a === "jstatus") { const s = prompt("Set status: open, accepted, completed or cancelled", el.dataset.s); if (!s) return; await send(`/api/admin/jobs/${id}`, "PATCH", { status: s.trim().toLowerCase() }); toast("Task updated"); }
      else if (a === "jdelete") { if (!(await ask("Delete task?", `Permanently delete <b>${esc(el.dataset.name)}</b> and its offers? This cannot be undone.`, "Delete"))) return; await api(`/api/admin/jobs/${id}`, { method: "DELETE" }); toast("Task deleted"); }
      else if (a === "rdelete") { if (!(await ask("Remove review?", "The review will be permanently removed and the provider's rating recalculated.", "Remove"))) return; await api(`/api/admin/reviews/${id}`, { method: "DELETE" }); toast("Review removed"); }
      else if (a === "nid") { const ok = el.dataset.a === "approve"; if (!(await ask(ok ? "Approve verification?" : "Reject verification?", ok ? "The provider receives the verified badge." : "The application is marked rejected.", ok ? "Approve" : "Reject", !ok))) return; await send("/api/admin/nid/verify", "PATCH", { user_id: Number(id), action: el.dataset.a }); toast(ok ? "Provider verified" : "Application rejected"); }
      else if (a === "ticket") { await send(`/api/admin/support/${id}`, "PATCH", { status: el.dataset.s }); toast("Ticket updated"); }
      else if (a === "cedit") { const d = prompt("Category description", el.dataset.d); if (d === null) return; await send(`/api/admin/categories/${id}`, "PATCH", { description: d }); toast("Category updated"); }
      else if (a === "cdelete") { if (!(await ask("Delete category?", `Remove <b>${esc(el.dataset.name)}</b>? Only possible if no tasks or providers use it.`, "Delete"))) return; await api(`/api/admin/categories/${id}`, { method: "DELETE" }); toast("Category deleted"); }
      load();
    } catch (e) { toast(e.message, true); }
  }

  function gate(msg) {
    $("#shell").classList.add("hidden"); $("#gate").classList.remove("hidden");
    $("#gate-msg").textContent = msg && msg !== "Sign in to continue." ? msg : "Sign in with an administrator account on the main site, then return to this page.";
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    const navBtn = t.closest("[data-view]"); if (navBtn) return go(navBtn.dataset.view);
    const pg = t.closest("[data-page]"); if (pg) { const [k, p] = pg.dataset.page.split(":"); S[k].page = Math.max(1, Number(p)); return load(); }
    const ex = t.closest("[data-export]"); if (ex) return exportCsv(ex.dataset.export);
    const img = t.closest("[data-img]"); if (img) return showImage(img.dataset.img);
    const a = t.closest("[data-act]"); if (a) return act(a);
  });
  let debounce;
  document.addEventListener("input", (e) => {
    const map = { uq: ["users", "q"], urole: ["users", "role"], ustatus: ["users", "status"], tq: ["tasks", "q"], tstatus: ["tasks", "status"] };
    const m = map[e.target.id]; if (!m) return;
    clearTimeout(debounce); debounce = setTimeout(() => { S[m[0]][m[1]] = e.target.value; S[m[0]].page = 1; load(); }, e.target.tagName === "INPUT" ? 300 : 0);
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "catform") return;
    e.preventDefault();
    const f = new FormData(e.target);
    try { await send("/api/admin/categories", "POST", { name: f.get("name"), description: f.get("description") }); toast("Category added"); load(); } catch (err) { toast(err.message, true); }
  });

  (async function start() {
    $("#gate").classList.remove("hidden");
    try {
      const b = await api("/api/bootstrap");
      if (!b.user) return gate("Sign in to continue.");
      if (b.user.role !== "admin") return gate("This account does not have administrator access.");
      S.me = b.user; $("#me").textContent = b.user.email;
      $("#gate").classList.add("hidden"); $("#shell").classList.remove("hidden");
      const first = location.hash.slice(1); go(SECTIONS.some((s) => s[0] === first) ? first : "overview");
    } catch (e) { gate(e.message); }
  })();
})();
