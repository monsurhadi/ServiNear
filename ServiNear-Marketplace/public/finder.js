"use strict";
/* ServiNear finder: hero map, provider pins, turn-by-turn directions, Google sign-in.
   Loaded after app.js; relies on its globals: state, api, post, toast, reload, refreshIcons. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DHAKA = [23.78, 90.39];
  const OSRM = "https://router.project-osrm.org/route/v1/driving/";
  const NOMINATIM = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=bd&q=";

  let map, cluster, routeGroup, originMarker, pickMode = false;
  let origin = null, dest = null, boundsOnly = false;
  const markers = new Map();

  const fmtDist = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
  const fmtTime = (s) => { const m = Math.round(s / 60); return m < 60 ? `${Math.max(1, m)} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const compass = (b) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(b / 45) % 8];
  const hasPos = (w) => Number.isFinite(Number(w.latitude)) && Number.isFinite(Number(w.longitude)) && w.latitude && w.longitude;
  const ratingText = (w) => (Number(w.reviews) > 0 ? `★ ${Number(w.rating).toFixed(1)} (${w.reviews})` : "New");
  const money = (n) => (typeof window.money === "function" ? window.money(n) : `৳${Number(n || 0).toLocaleString()}`);

  function stepText(s) {
    const m = s.maneuver || {}, on = s.name ? ` onto ${s.name}` : "", mod = (m.modifier || "").replace("slight ", "bear ");
    switch (m.type) {
      case "depart": return `Head ${m.bearing_after != null ? compass(m.bearing_after) : "out"}${s.name ? " on " + s.name : ""}`;
      case "arrive": return "Arrive at the provider's location";
      case "turn": case "end of road": return /^bear/.test(mod) ? `${mod[0].toUpperCase()}${mod.slice(1)}${on}` : `Turn ${mod}${on}`;
      case "roundabout": case "rotary": return `At the roundabout take exit ${m.exit || ""}${on}`.replace("exit  ", "exit ");
      case "fork": return `Keep ${mod}${on}`;
      case "merge": return `Merge${on}`;
      default: return `Continue${on}`;
    }
  }

  function pinIcon(w, active) {
    return L.divIcon({
      className: "pin-wrap",
      html: `<div class="pin ${w.verified ? "pin-verified" : ""} ${active ? "pin-active" : ""}"><span>${esc(String(w.name || "?").trim().slice(0, 1).toUpperCase())}</span></div>`,
      iconSize: [34, 42], iconAnchor: [17, 40], popupAnchor: [0, -36]
    });
  }

  function popupHtml(w) {
    const dist = state.position && hasPos(w) ? `<span class="pp-chip"><i data-lucide="navigation"></i>${fmtDist(distM(state.position, w))} away</span>` : "";
    return `<div class="pp">
      <div class="pp-top"><strong>${esc(w.name)}</strong>${w.verified ? '<em class="pp-ok">Verified</em>' : ""}</div>
      <div class="pp-sub">${esc(w.category || "Service")} · ${esc(w.area || "")}</div>
      <div class="pp-row"><span class="pp-chip">${ratingText(w)}</span><span class="pp-chip">${money(w.rate)}</span>${dist}</div>
      <button class="pp-btn" type="button" data-dir-id="${w.id}">Get directions</button>
    </div>`;
  }

  function distM(a, b) {
    const R = 6371000, rad = (x) => (x * Math.PI) / 180;
    const la1 = a.latitude ?? a.lat, lo1 = a.longitude ?? a.lng, la2 = b.latitude ?? b.lat, lo2 = b.longitude ?? b.lng;
    const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function ensureMap() {
    if (map || !window.L || !$("#service-map")) return;
    map = L.map("service-map", { scrollWheelZoom: true, zoomControl: false, tap: true })
      .setView(state.position ? [state.position.latitude, state.position.longitude] : DHAKA, 11);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
    cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 48, chunkedLoading: true }).addTo(map);
    routeGroup = L.layerGroup().addTo(map);
    map.on("click", (e) => { if (pickMode) { pickMode = false; map.getContainer().classList.remove("picking"); setOrigin({ lat: e.latlng.lat, lng: e.latlng.lng }, "Pinned on map"); } });
    map.on("moveend", () => { if (boundsOnly) renderList(window.__lastRows || []); });
    new ResizeObserver(() => map.invalidateSize()).observe($("#service-map"));
  }

  function render(rows) {
    ensureMap();
    window.__lastRows = rows;
    if (map) {
      cluster.clearLayers(); markers.clear();
      const pins = [];
      rows.filter(hasPos).slice(0, 1000).forEach((w) => {
        const mk = L.marker([w.latitude, w.longitude], { icon: pinIcon(w), title: w.name, riseOnHover: true });
        mk.bindPopup(() => popupHtml(w), { closeButton: true, maxWidth: 260, autoPanPadding: [24, 90] });
        mk.on("popupopen", () => refreshIcons($(".leaflet-popup")));
        markers.set(String(w.id), mk); pins.push(mk);
      });
      cluster.addLayers(pins);
      if (!window.__fittedOnce && pins.length) { window.__fittedOnce = true; fitResults(rows); }
    }
    renderChips();
    renderList(rows);
  }

  function fitResults(rows = window.__lastRows || []) {
    const pts = rows.filter(hasPos).slice(0, 300).map((w) => [w.latitude, w.longitude]);
    if (!map || !pts.length) return;
    if (state.position) pts.push([state.position.latitude, state.position.longitude]);
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14 });
  }

  function renderChips() {
    const box = $("#finder-chips");
    if (!box || box.dataset.ready || !state.categories?.length) return;
    box.dataset.ready = "1";
    box.innerHTML = state.categories.slice(0, 9).map((c) => `<button type="button" class="chip" data-chip="${esc(c.name)}">${esc(c.name)}</button>`).join("");
  }

  function renderList(rows) {
    const box = $("#finder-results"), count = $("#finder-count");
    if (!box) return;
    let list = rows;
    if (boundsOnly && map) { const b = map.getBounds(); list = rows.filter((w) => hasPos(w) && b.contains([w.latitude, w.longitude])); }
    if (count) count.textContent = `${list.length.toLocaleString()} professional${list.length === 1 ? "" : "s"}${boundsOnly ? " in view" : ""}`;
    if (!list.length) {
      box.innerHTML = `<div class="finder-empty"><strong>No providers found</strong><span>Try another service, clear the area, or zoom the map out.</span></div>`;
      return;
    }
    box.innerHTML = list.slice(0, 40).map((w) => {
      const d = state.position && hasPos(w) ? fmtDist(distM(state.position, w)) : "";
      return `<article class="fr" tabindex="0" data-focus-id="${w.id}">
        <div class="fr-av ${w.verified ? "ok" : ""}">${esc(String(w.name || "?").slice(0, 1))}</div>
        <div class="fr-main">
          <div class="fr-name"><strong>${esc(w.name)}</strong>${w.verified ? '<i data-lucide="badge-check"></i>' : ""}</div>
          <div class="fr-sub">${esc(w.category || "")} · ${esc(w.area || "")}</div>
          <div class="fr-meta"><span>${ratingText(w)}</span><span>${money(w.rate)}</span>${d ? `<span>${d}</span>` : ""}</div>
        </div>
        ${hasPos(w) ? `<button type="button" class="fr-dir" data-dir-id="${w.id}" aria-label="Directions to ${esc(w.name)}"><i data-lucide="navigation"></i></button>` : ""}
      </article>`;
    }).join("");
    refreshIcons(box);
  }

  function focusProvider(id) {
    const mk = markers.get(String(id));
    if (!mk || !map) return;
    cluster.zoomToShowLayer(mk, () => { map.setView(mk.getLatLng(), Math.max(map.getZoom(), 15), { animate: true }); mk.openPopup(); });
  }

  /* ---------- Directions ---------- */
  function panel() { return $("#route-panel"); }
  function openPanel(w) {
    dest = w;
    const p = panel(); if (!p) return;
    p.classList.remove("hidden");
    $("#route-dest").textContent = w.name;
    $("#route-summary").innerHTML = "";
    $("#route-steps").innerHTML = "";
    $("#route-msg").textContent = "";
    $("#route-from").value = origin?.label || "";
    document.body.classList.add("route-open");
  }
  function closePanel() {
    panel()?.classList.add("hidden"); routeGroup?.clearLayers(); document.body.classList.remove("route-open");
    if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
    dest = null; pickMode = false; map?.getContainer().classList.remove("picking");
  }
  function msg(t, kind = "") { const m = $("#route-msg"); if (m) { m.textContent = t; m.dataset.kind = kind; } }

  function setOrigin(o, label) {
    origin = { ...o, label };
    $("#route-from").value = label;
    if (originMarker) map.removeLayer(originMarker);
    originMarker = L.marker([o.lat, o.lng], {
      icon: L.divIcon({ className: "pin-wrap", html: '<div class="me-dot"><i></i></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 900, title: "Your location"
    }).addTo(map);
    if (dest) route();
  }

  function useMyLocation() {
    if (!navigator.geolocation) return msg("GPS isn't available in this browser. Type an address or pin your start on the map.", "warn");
    msg("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.position = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        setOrigin({ lat: pos.coords.latitude, lng: pos.coords.longitude }, "My location");
      },
      () => msg("Location permission was not granted. Type an address or pin your start on the map.", "warn"),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  async function geocode(q) {
    const r = await fetch(NOMINATIM + encodeURIComponent(q), { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("Address lookup failed.");
    const hit = (await r.json())[0];
    if (!hit) throw new Error("We couldn't find that address. Try a landmark or area name.");
    return { lat: Number(hit.lat), lng: Number(hit.lon), label: String(hit.display_name).split(",").slice(0, 2).join(",") };
  }

  async function route() {
    if (!origin || !dest) return;
    routeGroup.clearLayers();
    msg("Calculating the best route…");
    $("#route-summary").innerHTML = ""; $("#route-steps").innerHTML = "";
    const d = { lat: Number(dest.latitude), lng: Number(dest.longitude) };
    const links = `<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${d.lat},${d.lng}&travelmode=driving">Open in Google Maps</a>
      <a target="_blank" rel="noopener" href="https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${origin.lat}%2C${origin.lng}%3B${d.lat}%2C${d.lng}">OpenStreetMap</a>`;
    try {
      const r = await fetch(`${OSRM}${origin.lng},${origin.lat};${d.lng},${d.lat}?overview=full&geometries=geojson&steps=true`, { signal: AbortSignal.timeout(12000) });
      const data = await r.json();
      if (!r.ok || data.code !== "Ok" || !data.routes?.length) throw new Error("no route");
      const rt = data.routes[0];
      const latlngs = rt.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      L.polyline(latlngs, { color: "#fff", weight: 10, opacity: 0.9, lineCap: "round" }).addTo(routeGroup);
      L.polyline(latlngs, { color: "#0e6b5c", weight: 6, opacity: 1, lineCap: "round", className: "route-line" }).addTo(routeGroup);
      map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [40, 40], paddingBottomRight: [40, window.innerWidth <= 900 ? 330 : 40] });
      $("#route-summary").innerHTML = `<div class="rs-big"><strong>${fmtTime(rt.duration)}</strong><span>${fmtDist(rt.distance)} · driving</span></div><div class="rs-links">${links}</div>`;
      $("#route-steps").innerHTML = rt.legs[0].steps.filter((s) => s.distance > 0 || s.maneuver?.type === "arrive")
        .map((s) => `<li><span>${esc(stepText(s))}</span><em>${s.distance ? fmtDist(s.distance) : ""}</em></li>`).join("");
      msg("Travel time is an estimate for driving without live traffic.");
    } catch {
      L.polyline([[origin.lat, origin.lng], [d.lat, d.lng]], { color: "#bd4d2c", weight: 4, dashArray: "8 10" }).addTo(routeGroup);
      map.fitBounds(L.latLngBounds([[origin.lat, origin.lng], [d.lat, d.lng]]), { padding: [60, 60] });
      $("#route-summary").innerHTML = `<div class="rs-big"><strong>${fmtDist(distM(origin, d))}</strong><span>straight-line distance</span></div><div class="rs-links">${links}</div>`;
      msg("Road directions are unavailable right now. Showing the straight line; use the links above for turn-by-turn.", "warn");
    }
  }

  function startDirections(id) {
    const w = (state.workers || []).find((x) => String(x.id) === String(id));
    if (!w || !hasPos(w)) return toast("This provider has not shared a location yet.");
    ensureMap(); map.closePopup();
    if (window.innerWidth <= 900) $("#service-map").scrollIntoView({ behavior: "smooth", block: "center" });
    openPanel(w);
    if (state.position && !origin) setOrigin({ lat: state.position.latitude, lng: state.position.longitude }, "My location");
    else if (origin) route();
    else useMyLocation();
  }

  /* ---------- Google sign-in ---------- */
  const G = { cfg: null, mode: "none" };
  function role() { return $("#register-form")?.elements?.role?.value === "worker" ? "worker" : "customer"; }
  async function onCredential(credential) {
    try {
      const res = await post("/api/auth/google", { credential, role: role() });
      state.user = res.user; $("#auth-dialog")?.close(); await reload();
      toast(`Signed in as ${state.user.name}`);
    } catch (e) { toast(e.message); }
  }
  function loadGsi() {
    return new Promise((ok) => {
      if (window.google?.accounts?.id) return ok(true);
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = () => ok(true); s.onerror = () => ok(false);
      document.head.appendChild(s);
    });
  }
  async function initGoogle() {
    try { G.cfg = await api("/api/config"); } catch { G.cfg = {}; }
    if (!G.cfg.demo) document.querySelectorAll(".demo-access").forEach((el) => el.classList.add("hidden"));
    if (G.cfg.googleClientId && (await loadGsi())) {
      G.mode = "gsi";
      google.accounts.id.initialize({ client_id: G.cfg.googleClientId, callback: (r) => onCredential(r.credential), ux_mode: "popup", auto_select: false });
      ["#google-login-btn", "#google-signup-btn"].forEach((sel) => {
        const btn = $(sel); if (!btn) return;
        const slot = document.createElement("div"); slot.className = "google-slot";
        btn.after(slot); btn.classList.add("hidden");
        google.accounts.id.renderButton(slot, { theme: "outline", size: "large", shape: "pill", text: sel.includes("signup") ? "signup_with" : "signin_with", width: 320, logo_alignment: "left" });
      });
    } else if (G.cfg.googleEnabled) G.mode = "mock";
  }
  function googleClick() {
    if (G.mode === "mock") {
      const email = prompt("Development mode: enter an email to simulate Google sign-in", "dev.user@example.com");
      if (email) onCredential(`mock:${email}:${email.split("@")[0]}`);
    } else toast("Google sign-in isn't set up on this server yet.");
  }

  /* ---------- Wiring ---------- */
  function bind() {
    document.addEventListener("click", (e) => {
      const dir = e.target.closest("[data-dir-id]");
      if (dir) { e.stopPropagation(); return startDirections(dir.dataset.dirId); }
      const chip = e.target.closest("[data-chip]");
      if (chip) {
        const input = $("#service-search"); const on = chip.classList.contains("on");
        document.querySelectorAll("#finder-chips .chip").forEach((c) => c.classList.remove("on"));
        input.value = on ? "" : chip.dataset.chip; if (!on) chip.classList.add("on");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      const row = e.target.closest("[data-focus-id]");
      if (row) focusProvider(row.dataset.focusId);
      if (e.target.closest("#route-close")) closePanel();
      if (e.target.closest("#route-locate")) useMyLocation();
      if (e.target.closest("#route-pick")) { pickMode = true; map.getContainer().classList.add("picking"); msg("Tap the map where you want to start."); }
      if (e.target.closest("#map-fit")) fitResults();
      if (e.target.closest("#google-login-btn,#google-signup-btn")) googleClick();
    }, true);
    $("#route-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#route-from").value.trim();
      if (!q || q === "My location") return useMyLocation();
      try { msg("Looking up that address…"); const g = await geocode(q); setOrigin({ lat: g.lat, lng: g.lng }, g.label); }
      catch (err) { msg(err.message, "warn"); }
    });
    $("#bounds-toggle")?.addEventListener("change", (e) => { boundsOnly = e.target.checked; renderList(window.__lastRows || []); });
    $("#finder-form")?.addEventListener("submit", (e) => { e.preventDefault(); $("#service-search")?.dispatchEvent(new Event("input", { bubbles: true })); window.__fittedOnce = false; render(window.__lastRows || []); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel()?.classList.contains("hidden")) closePanel(); });
  }

  window.ServiMap = { render, fit: fitResults };
  bind();
  initGoogle();
  // Repaint once data has arrived, in case the first render happened before this script loaded.
  const t = setInterval(() => { if (state.workers?.length) { clearInterval(t); try { renderProviders(); } catch {} } }, 300);
  setTimeout(() => clearInterval(t), 15000);
})();
