"use strict";
// Admin control-plane API. Every route requires an authenticated admin and every write is audited.

function createAdminApi({ db, send, fail, requireUser, readBody, notifyUser }) {
  const num = (v, d, min, max) => {
    const n = v === null || v === undefined || String(v).trim() === "" ? NaN : Number(v);
    return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.floor(n) : d));
  };
  const like = (q) => `%${String(q || "").trim().replace(/[%_]/g, "")}%`;
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;

  function audit(admin, action, entity, entityId, detail, ip) {
    db.prepare("INSERT INTO audit_log(actor_id,actor_name,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)")
      .run(admin.id, admin.name, action, entity, String(entityId ?? ""), detail ? JSON.stringify(detail).slice(0, 1000) : null, ip || null);
  }
  const csvCell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  function sendCsv(res, name, rows) {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const body = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
    res.end(body);
  }

  return async function handle(req, res, url, user, ip) {
    const p = url.pathname;
    if (!p.startsWith("/api/admin/")) return false;
    requireUser(user, ["admin"]);
    const q = url.searchParams;
    const m = req.method;
    let r;

    if (m === "GET" && p === "/api/admin/overview") {
      const series = (table, col = "created_at", where = "1=1") => db.prepare(
        `SELECT date(${col}) AS day, COUNT(*) AS n FROM ${table} WHERE ${where} AND ${col} >= date('now','-29 day') GROUP BY day ORDER BY day`).all();
      return send(res, 200, {
        totals: {
          users: count("SELECT COUNT(*) c FROM users"), customers: count("SELECT COUNT(*) c FROM users WHERE role='customer'"),
          providers: count("SELECT COUNT(*) c FROM users WHERE role='worker'"), verifiedProviders: count("SELECT COUNT(*) c FROM users WHERE role='worker' AND verified=1"),
          suspended: count("SELECT COUNT(*) c FROM users WHERE status='suspended'"),
          jobsOpen: count("SELECT COUNT(*) c FROM jobs WHERE status='open'"), jobsAccepted: count("SELECT COUNT(*) c FROM jobs WHERE status='accepted'"),
          jobsCompleted: count("SELECT COUNT(*) c FROM jobs WHERE status='completed'"), offers: count("SELECT COUNT(*) c FROM offers"),
          reviews: count("SELECT COUNT(*) c FROM reviews"), openTickets: count("SELECT COUNT(*) c FROM support_tickets WHERE status!='resolved'"),
          pendingNid: count("SELECT COUNT(*) c FROM nid_verifications WHERE status='pending'"),
          escrowHeld: count("SELECT COALESCE(SUM(amount),0) c FROM escrows WHERE status='held'"),
          escrowReleased: count("SELECT COALESCE(SUM(amount),0) c FROM escrows WHERE status='released'")
        },
        signups: series("users"), jobsPosted: series("jobs"),
        topCategories: db.prepare("SELECT category AS name, COUNT(*) AS n FROM jobs GROUP BY category ORDER BY n DESC LIMIT 8").all(),
        recentAudit: db.prepare("SELECT id,actor_name,action,entity,entity_id,created_at FROM audit_log ORDER BY id DESC LIMIT 8").all()
      });
    }

    if (m === "GET" && p === "/api/admin/users") {
      const where = ["1=1"], args = [];
      if (q.get("q")) { where.push("(name LIKE ? OR email LIKE ? OR phone LIKE ?)"); args.push(like(q.get("q")), like(q.get("q")), like(q.get("q"))); }
      if (["customer", "worker", "admin"].includes(q.get("role"))) { where.push("role=?"); args.push(q.get("role")); }
      if (["active", "suspended"].includes(q.get("status"))) { where.push("status=?"); args.push(q.get("status")); }
      const limit = num(q.get("limit"), 25, 1, 100), offset = (num(q.get("page"), 1, 1, 100000) - 1) * limit;
      const total = count(`SELECT COUNT(*) c FROM users WHERE ${where.join(" AND ")}`, ...args);
      const rows = db.prepare(`SELECT id,name,email,role,phone,area,category,verified,status,rate,created_at,last_login_at,(google_id IS NOT NULL) AS google
        FROM users WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return send(res, 200, { total, rows });
    }
    const um = p.match(/^\/api\/admin\/users\/(\d+)(?:\/(revoke-sessions))?$/);
    if (um) {
      const id = Number(um[1]);
      const target = db.prepare("SELECT id,name,email,role,status FROM users WHERE id=?").get(id);
      if (!target) fail(404, "User not found.");
      if (m === "POST" && um[2] === "revoke-sessions") {
        const n = db.prepare("DELETE FROM sessions WHERE user_id=?").run(id).changes;
        audit(user, "user.revoke_sessions", "user", id, { sessions: n }, ip);
        return send(res, 200, { ok: true, revoked: n });
      }
      if (m === "PATCH") {
        const b = await readBody(req), sets = [], args = [], changes = {};
        if (id === user.id && (b.status === "suspended" || (b.role && b.role !== "admin"))) fail(400, "You cannot suspend or demote your own account.");
        if (b.role !== undefined) {
          if (!["customer", "worker", "admin"].includes(b.role)) fail(400, "Invalid role.");
          if (target.role === "admin" && b.role !== "admin" && count("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'") <= 1) fail(400, "At least one active admin is required.");
          sets.push("role=?"); args.push(b.role); changes.role = b.role;
        }
        if (b.status !== undefined) {
          if (!["active", "suspended"].includes(b.status)) fail(400, "Invalid status.");
          sets.push("status=?"); args.push(b.status); changes.status = b.status;
        }
        if (b.verified !== undefined) { sets.push("verified=?"); args.push(b.verified ? 1 : 0); changes.verified = !!b.verified; }
        for (const f of ["name", "phone", "area", "category"]) if (typeof b[f] === "string") { sets.push(`${f}=?`); args.push(b[f].trim().slice(0, 120)); changes[f] = b[f].trim().slice(0, 120); }
        if (!sets.length) fail(400, "Nothing to update.");
        db.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).run(...args, id);
        if (changes.status === "suspended") db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
        audit(user, "user.update", "user", id, changes, ip);
        if (changes.verified === true) notifyUser?.(id, "You are verified", "Your provider profile now carries the verified badge.", "system");
        return send(res, 200, { ok: true });
      }
    }

    if (m === "GET" && p === "/api/admin/jobs") {
      const where = ["1=1"], args = [];
      if (q.get("q")) { where.push("(j.title LIKE ? OR j.area LIKE ? OR u.name LIKE ?)"); args.push(like(q.get("q")), like(q.get("q")), like(q.get("q"))); }
      if (["open", "accepted", "completed", "cancelled"].includes(q.get("status"))) { where.push("j.status=?"); args.push(q.get("status")); }
      const limit = num(q.get("limit"), 25, 1, 100), offset = (num(q.get("page"), 1, 1, 100000) - 1) * limit;
      const total = count(`SELECT COUNT(*) c FROM jobs j JOIN users u ON u.id=j.customer_id WHERE ${where.join(" AND ")}`, ...args);
      const rows = db.prepare(`SELECT j.id,j.title,j.category,j.area,j.budget,j.status,j.created_at,u.name AS customer,
        (SELECT COUNT(*) FROM offers o WHERE o.job_id=j.id) AS offers FROM jobs j JOIN users u ON u.id=j.customer_id
        WHERE ${where.join(" AND ")} ORDER BY j.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
      return send(res, 200, { total, rows });
    }
    const jm = p.match(/^\/api\/admin\/jobs\/(\d+)$/);
    if (jm) {
      const id = Number(jm[1]);
      const job = db.prepare("SELECT id,title,status FROM jobs WHERE id=?").get(id);
      if (!job) fail(404, "Task not found.");
      if (m === "PATCH") {
        const b = await readBody(req);
        if (!["open", "accepted", "completed", "cancelled"].includes(b.status)) fail(400, "Invalid status.");
        db.prepare("UPDATE jobs SET status=? WHERE id=?").run(b.status, id);
        audit(user, "job.status", "job", id, { from: job.status, to: b.status }, ip);
        return send(res, 200, { ok: true });
      }
      if (m === "DELETE") {
        if (count("SELECT COUNT(*) c FROM escrows WHERE job_id=? AND status='held'", id)) fail(409, "This task has funds held in escrow. Resolve the escrow first.");
        db.exec("BEGIN");
        try {
          db.prepare("DELETE FROM saved_posts WHERE target_type='job' AND target_id=?").run(id);
          db.prepare("DELETE FROM reviews WHERE job_id=?").run(id);
          db.prepare("DELETE FROM jobs WHERE id=?").run(id);
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        audit(user, "job.delete", "job", id, { title: job.title }, ip);
        return send(res, 200, { ok: true });
      }
    }

    if (m === "GET" && p === "/api/admin/reviews") {
      return send(res, 200, db.prepare(`SELECT r.id,r.rating,r.comment,r.created_at,c.name AS customer,w.name AS provider
        FROM reviews r JOIN users c ON c.id=r.customer_id JOIN users w ON w.id=r.worker_id ORDER BY r.id DESC LIMIT 100`).all());
    }
    const rm = p.match(/^\/api\/admin\/reviews\/(\d+)$/);
    if (m === "DELETE" && rm) {
      if (!db.prepare("DELETE FROM reviews WHERE id=?").run(Number(rm[1])).changes) fail(404, "Review not found.");
      audit(user, "review.delete", "review", rm[1], null, ip);
      return send(res, 200, { ok: true });
    }

    if (m === "GET" && p === "/api/admin/payments") {
      return send(res, 200, {
        escrows: db.prepare(`SELECT e.id,e.job_id,e.amount,e.status,e.created_at,e.released_at,c.name AS customer,w.name AS provider
          FROM escrows e JOIN users c ON c.id=e.customer_id JOIN users w ON w.id=e.worker_id ORDER BY e.id DESC LIMIT 100`).all(),
        transactions: db.prepare(`SELECT t.id,t.type,t.amount,t.payment_method,t.trx_id,t.created_at,u.name AS user
          FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 100`).all()
      });
    }

    if (p === "/api/admin/categories" && m === "GET") {
      return send(res, 200, db.prepare("SELECT c.id,c.name,c.description,(SELECT COUNT(*) FROM jobs j WHERE j.category=c.name) AS tasks FROM categories c ORDER BY c.id").all());
    }
    if (p === "/api/admin/categories" && m === "POST") {
      const b = await readBody(req);
      const name = String(b.name || "").trim().slice(0, 60), desc = String(b.description || "").trim().slice(0, 160);
      if (name.length < 2) fail(400, "Category name is too short.");
      try { db.prepare("INSERT INTO categories(name,description) VALUES(?,?)").run(name, desc); }
      catch (e) { if (String(e.message).includes("UNIQUE")) fail(409, "That category already exists."); throw e; }
      audit(user, "category.create", "category", name, null, ip);
      return send(res, 201, { ok: true });
    }
    const cm = p.match(/^\/api\/admin\/categories\/(\d+)$/);
    if (cm) {
      const id = Number(cm[1]);
      const cat = db.prepare("SELECT id,name FROM categories WHERE id=?").get(id);
      if (!cat) fail(404, "Category not found.");
      if (m === "PATCH") {
        const b = await readBody(req);
        const desc = String(b.description ?? "").trim().slice(0, 160);
        db.prepare("UPDATE categories SET description=? WHERE id=?").run(desc, id);
        audit(user, "category.update", "category", cat.name, null, ip);
        return send(res, 200, { ok: true });
      }
      if (m === "DELETE") {
        const used = count("SELECT (SELECT COUNT(*) FROM jobs WHERE category=?)+(SELECT COUNT(*) FROM users WHERE category=?) c", cat.name, cat.name);
        if (used) fail(409, `${used} tasks or providers still use this category.`);
        db.prepare("DELETE FROM categories WHERE id=?").run(id);
        audit(user, "category.delete", "category", cat.name, null, ip);
        return send(res, 200, { ok: true });
      }
    }

    if (m === "GET" && p === "/api/admin/audit") {
      return send(res, 200, db.prepare("SELECT id,actor_name,action,entity,entity_id,detail,ip,created_at FROM audit_log ORDER BY id DESC LIMIT ?").all(num(q.get("limit"), 100, 1, 500)));
    }

    const em = p.match(/^\/api\/admin\/export\/(users|jobs|tickets)\.csv$/);
    if (m === "GET" && em) {
      const sql = {
        users: "SELECT id,name,email,role,phone,area,category,verified,status,created_at,last_login_at FROM users ORDER BY id",
        jobs: "SELECT j.id,j.title,j.category,j.area,j.budget,j.status,j.created_at,u.name AS customer FROM jobs j JOIN users u ON u.id=j.customer_id ORDER BY j.id",
        tickets: "SELECT id,name,email,subject,status,created_at FROM support_tickets ORDER BY id"
      }[em[1]];
      audit(user, "export." + em[1], em[1], "", null, ip);
      return sendCsv(res, `servinear-${em[1]}-${new Date().toISOString().slice(0, 10)}.csv`, db.prepare(sql).all());
    }
    return false;
  };
}
module.exports = { createAdminApi };
