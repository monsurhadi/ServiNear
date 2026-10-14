"use strict";

let savedAlertPreference = "off";
try { savedAlertPreference = window.localStorage.getItem("servinear-alerts") || "off"; } catch {}
const state = { user: null, workers: [], categories: [], jobs: [], offers: [], page: "discover", selectedJob: null, taskLimit: 20, providerLimit: 24, position: null, map: null, markers: null, authMode: "login", alertOnly: savedAlertPreference === "on" };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = (value) => value == null ? "Budget flexible" : `৳${Number(value).toLocaleString("en-BD")}`;
const dateLabel = (value) => new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(`${String(value).replace(" ", "T")}Z`));
const categoryOptions = (placeholder = "Choose a category") => `<option value="">${placeholder}</option>${state.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("")}`;
const API_BASE = String(window.SERVINEAR_API_BASE || "").trim().replace(/\/+$/, "");

async function api(path, options = {}) {
  if (!API_BASE) {
    throw new Error("API URL is not configured. Set SERVINEAR_API_BASE in runtime-config.js or Vercel environment variables.");
  }

  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers
  };

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers
    });
  } catch (error) {
    console.error("ServiNear API connection failed:", error);
    throw new Error("Cannot reach the ServiNear API. Check the backend, Cloudflare Tunnel URL, and backend CORS settings.");
  }

  const data = response.status === 204
    ? {}
    : await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || `Request failed (HTTP ${response.status}).`);
  }

  return data;
}
const post = (path, body, method = "POST") => api(path, { method, body: JSON.stringify(body) });
function refreshIcons(root = document) { if (window.lucide) window.lucide.createIcons({ root }); }
function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 3200); }
function showError(node, message) { if (node) { node.textContent = message; node.classList.add("error"); } else toast(message); }
function showSuccess(node, message) { if (node) { node.textContent = message; node.classList.remove("error"); node.classList.add("success"); } else toast(message); }
async function reload() { Object.assign(state, await api("/api/bootstrap")); renderAll(); }

function routeFromPath() {
  const path = location.pathname.replace(/\/$/, "") || "/";
  if (/^\/tasks\/\d+$/.test(path)) { state.selectedJob = Number(path.split("/").pop()); return "task-detail"; }
  return ({ "/": "discover", "/categories": "categories", "/jobs": "jobs", "/hot-offers": "hot", "/about": "about", "/how-it-works": "how", "/help": "help", "/profile": "profile", "/admin": "admin" })[path] || "discover";
}
function navigate(path) {
  if (path === "#post") return openJobDialog();
  history.pushState({}, "", path); state.page = routeFromPath(); window.scrollTo(0, 0); renderPage();
}
function setActivePage() {
  $$(".page-view").forEach((view) => view.classList.toggle("hidden", view.dataset.page !== state.page));
  $$(".nav-link[data-route]").forEach((link) => link.classList.toggle("active", link.getAttribute("href") === location.pathname));
}
function renderAll() {
  state.page = routeFromPath();
  $("#auth-button").textContent = state.user ? "Log out" : "Log in";
  $("#profile-link span").textContent = state.user ? state.user.name.split(" ")[0] : "My profile";
  $("#profile-link").classList.toggle("hidden", !state.user);
  $("#admin-link").classList.toggle("hidden", state.user?.role !== "admin");
  renderCategoryOptions(); renderFeaturedCategories(); renderProviders(); renderTasks(); renderHotTasks(); renderPage();
}
function renderCategoryOptions() {
  $("#job-category").innerHTML = categoryOptions(); $("#worker-category").innerHTML = categoryOptions();
  $("#task-category-filter").innerHTML = `<option value="">All categories</option>${state.categories.map((c) => `<option>${escapeHtml(c.name)}</option>`).join("")}`;
}
function categoryTile(category, featured = false) {
  const icon = ({ Cleaning: "sparkles", Electrical: "zap", Plumbing: "wrench", Appliances: "refrigerator", Painting: "paintbrush", Handyman: "hammer", Carpentry: "ruler", "Building & Construction": "construction", Removals: "truck", Delivery: "package", Gardening: "flower-2", Assembly: "settings", Auto: "car-front", Beauty: "heart", Tutoring: "book-open", Cooking: "cooking-pot", "Food Delivery": "bike", Photography: "camera", "Computers & IT": "monitor", "Audio Visual": "headphones" })[category.name] || "briefcase-business";
  return `<button class="category-tile ${featured ? "featured-tile" : ""}" data-category="${escapeHtml(category.name)}"><span class="category-icon"><i data-lucide="${icon}"></i></span><strong>${escapeHtml(category.name)}</strong>${featured ? `<small>${escapeHtml(category.description)}</small>` : ""}</button>`;
}
function renderFeaturedCategories() { $("#featured-categories").innerHTML = state.categories.slice(0, 8).map((category) => categoryTile(category, true)).join(""); refreshIcons($("#featured-categories")); }
function renderCategories() { $("#all-categories").innerHTML = state.categories.map((category) => categoryTile(category)).join(""); refreshIcons($("#all-categories")); }
function haversine(a, b) { const rad = Math.PI / 180; const dLat = (b.latitude - a.latitude) * rad; const dLng = (b.longitude - a.longitude) * rad; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2; return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
function filteredProviders() {
  const query = $("#service-search").value.trim().toLowerCase(); const area = $("#area-search").value.trim().toLowerCase(); const verified = $("#verified-filter").checked; const sort = $("#sort-filter").value;
  const rows = state.workers.filter((worker) => (!verified || worker.verified) && (!query || `${worker.category} ${worker.name} ${worker.bio}`.toLowerCase().includes(query)) && (!area || worker.area.toLowerCase().includes(area) || state.position));
  if (sort === "distance" && state.position) rows.sort((a, b) => haversine(state.position, a) - haversine(state.position, b));
  if (sort === "rating") rows.sort((a, b) => b.rating - a.rating || b.verified - a.verified);
  if (sort === "price") rows.sort((a, b) => a.rate - b.rate);
  return rows;
}
function renderProviders() {
  if (!$("#provider-list")) return;
  const rows = filteredProviders(); const visible = rows.slice(0, state.providerLimit);
  $("#provider-summary").textContent = `${rows.length.toLocaleString()} professionals match your search.`;
  $("#provider-empty").classList.toggle("hidden", rows.length > 0);
  $("#provider-list").innerHTML = visible.map((w) => `<article class="provider-card"><div class="provider-avatar">${escapeHtml(w.name.slice(0, 1))}</div><div class="provider-main"><div class="provider-name-row"><h3>${escapeHtml(w.name)}</h3>${w.verified ? '<span class="verified-badge"><i data-lucide="badge-check"></i> Verified</span>' : ""}</div><p class="provider-category">${escapeHtml(w.category)} <span>·</span> ${escapeHtml(w.area)}</p><p class="provider-bio">${escapeHtml(w.bio || "Local service professional")}</p><div class="provider-meta"><span><i data-lucide="star"></i> ${Number(w.rating || 0).toFixed(1)} (${w.reviews})</span><span><i data-lucide="briefcase-business"></i> ${w.experience || 1}+ years</span><span class="availability">${escapeHtml(w.availability || "Available")}</span></div></div><div class="provider-price"><small>Starting from</small><strong>${money(w.rate)}</strong></div></article>`).join("");
  $("#provider-more").classList.toggle("hidden", rows.length <= state.providerLimit); refreshIcons($("#provider-list")); renderMap(rows);
}
function renderMap(rows = filteredProviders()) {
  if (!window.L || !$("#service-map")) return;
  if (!state.map) { state.map = L.map("service-map", { scrollWheelZoom: false }).setView(state.position ? [state.position.latitude, state.position.longitude] : [23.78, 90.39], 10); L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(state.map); state.markers = L.layerGroup().addTo(state.map); }
  state.markers.clearLayers(); rows.filter((w) => w.latitude && w.longitude).slice(0, 150).forEach((w) => L.marker([w.latitude, w.longitude]).bindPopup(`<strong>${escapeHtml(w.name)}</strong><br>${escapeHtml(w.category)} · ${escapeHtml(w.area)}`).addTo(state.markers));
  setTimeout(() => state.map.invalidateSize(), 100);
}
function jobCard(job, active = false) {
  return `<button class="task-card ${active ? "selected" : ""}" data-task-id="${job.id}"><span class="task-card-top"><strong>${escapeHtml(job.title)}</strong><b>${money(job.budget)}</b></span><span class="task-card-meta"><span>${escapeHtml(job.category)}</span><span>${escapeHtml(job.area)}</span><span>${job.offer_count} ${job.offer_count === 1 ? "offer" : "offers"}</span></span><span class="task-card-bottom"><span class="status-pill status-${job.status}">${escapeHtml(job.status)}</span><time>${dateLabel(job.created_at)}</time></span></button>`;
}
function filteredJobs() {
  const q = $("#task-search")?.value.trim().toLowerCase() || ""; const category = $("#task-category-filter")?.value || ""; const sort = $("#task-sort")?.value || "newest";
  const rows = state.jobs.filter((job) => job.status === "open" && (!category || job.category === category) && (!q || `${job.title} ${job.details} ${job.area} ${job.category}`.toLowerCase().includes(q)));
  if (sort === "budget") rows.sort((a, b) => (b.budget || 0) - (a.budget || 0)); else if (sort === "offers") rows.sort((a, b) => a.offer_count - b.offer_count); else rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return rows;
}
function renderTasks() {
  if (!$("#task-list")) return;
  const rows = filteredJobs(); $("#task-list").innerHTML = rows.slice(0, state.taskLimit).map((job) => jobCard(job, state.selectedJob === job.id)).join("") || '<div class="empty-state"><strong>No tasks found</strong><span>Try another category or search.</span></div>';
  $("#task-more").classList.toggle("hidden", rows.length <= state.taskLimit);
  if (state.selectedJob && state.page === "jobs") renderTaskPreview(state.jobs.find((job) => job.id === state.selectedJob));
}
function renderTaskPreview(job) {
  const panel = $("#task-preview"); if (!job) { panel.innerHTML = '<div class="preview-placeholder"><strong>Choose a task</strong><span>Its description will appear here.</span></div>'; return; }
  panel.innerHTML = `<span class="status-pill status-${job.status}">${escapeHtml(job.status)}</span><h2>${escapeHtml(job.title)}</h2><div class="task-detail-meta"><span>${escapeHtml(job.category)}</span><span>${escapeHtml(job.area)}</span><span>${dateLabel(job.created_at)}</span></div><div class="budget-panel"><div><small>Budget</small><strong>${money(job.budget)}</strong></div><button class="button button-rust" data-go-task="${job.id}">View task</button></div><h3>Description</h3><p>${escapeHtml(job.details)}</p><div class="poster-line">Posted by ${escapeHtml(job.customer_name)}</div>${job.contact_phone ? `<p class="private-contact">Phone: ${escapeHtml(job.contact_phone)}<br>Address: ${escapeHtml(job.exact_address)}</p>` : '<p class="privacy-note">Exact address and phone are shared after the customer accepts your offer.</p>'}`;
}
function renderHotTasks() { $("#hot-task-list").innerHTML = state.jobs.filter((job) => job.status === "open").sort((a, b) => b.offer_count - a.offer_count).slice(0, 12).map((job) => jobCard(job)).join("") || '<div class="empty-state">No open tasks right now.</div>'; }
function renderTaskDetail(id) {
  const job = state.jobs.find((item) => item.id === id); const root = $("#task-detail-root");
  if (!job) { root.innerHTML = '<div class="empty-state"><h2>Task not found</h2><a href="/jobs" data-route>Back to tasks</a></div>'; return; }
  const relatedOffers = state.offers.filter((offer) => offer.job_id === id);
  const canSeeOffers = state.user?.role === "customer" && job.customer_id === state.user.id;
  const selected = relatedOffers.find((offer) => offer.status === "accepted");
  const assignedProvider = state.user?.role === "worker" && selected?.worker_id === state.user.id;
  const canReview = canSeeOffers && job.status === "completed" && !selected?.reviewed;
  root.innerHTML = `<article class="task-detail-page"><div class="task-detail-main"><span class="status-pill status-${job.status}">${escapeHtml(job.status)} task</span><p class="eyebrow">${escapeHtml(job.category)} · POSTED ${dateLabel(job.created_at)}</p><h1>${escapeHtml(job.title)}</h1><div class="task-detail-meta"><span><i data-lucide="map-pin"></i> ${escapeHtml(job.area)}</span><span><i data-lucide="calendar-days"></i> ${dateLabel(job.created_at)}</span><span><i data-lucide="user-round"></i> ${escapeHtml(job.customer_name)}</span></div><div class="budget-panel"><div><small>Customer budget</small><strong>${money(job.budget)}</strong></div>${state.user?.role === "worker" && job.status === "open" ? `<button class="button button-rust" data-make-offer="${id}">Make an offer</button>` : ""}</div><h2>Task description</h2><p class="task-description">${escapeHtml(job.details)}</p>${job.contact_phone ? `<section class="contact-reveal"><h3><i data-lucide="shield-check"></i> Customer contact</h3><p>Shared with the customer’s accepted provider.</p><a href="tel:${escapeHtml(job.contact_phone)}">${escapeHtml(job.contact_phone)}</a><p>${escapeHtml(job.exact_address || "")}</p></section>` : '<p class="privacy-note">The customer’s exact address and phone stay private until they accept an offer.</p>'}${assignedProvider && job.status === "accepted" ? `<button class="button button-teal" data-complete-task="${id}">Mark task complete</button>` : ""}${canReview ? `<form class="review-form" data-review-task="${id}"><h2>Review this provider</h2><label class="form-field">Rating<select name="rating" required><option value="5">5 · Excellent</option><option value="4">4 · Good</option><option value="3">3 · Okay</option><option value="2">2 · Not great</option><option value="1">1 · Poor</option></select></label><label class="form-field">Review<textarea name="comment" maxlength="600" rows="3" placeholder="Share useful feedback"></textarea></label><button class="button button-rust">Submit review</button></form>` : ""}</div><aside class="offer-side"><h2>${canSeeOffers ? `Offers (${relatedOffers.length})` : "Offer"}</h2>${canSeeOffers ? (relatedOffers.map((offer) => `<article class="offer-card"><div class="offer-card-title"><strong>${escapeHtml(offer.worker_name)}</strong>${offer.worker_verified ? '<span class="verified-badge">Verified</span>' : ""}</div><div class="offer-price">${money(offer.price)}</div><p>${escapeHtml(offer.message)}</p><small>${dateLabel(offer.created_at)}</small>${offer.status === "pending" && job.status === "open" ? `<button class="button button-teal" data-accept-offer="${offer.id}">Accept offer</button>` : `<span class="status-pill status-${offer.status}">${escapeHtml(offer.status)}</span>`}</article>`).join("") || '<p class="muted-copy">No offers yet. Providers can make an offer from this page.</p>') : state.user?.role === "worker" ? `<p>Offer a clear price and explain what is included.</p>${job.status === "open" ? '<button class="button button-rust full-width" data-make-offer="' + id + '">Make an offer</button>' : '<p>This task is not accepting offers.</p>'}` : '<p>Sign in as a provider to make an offer, or sign in as the task customer to review offers.</p>'}${selected && state.user?.role === "customer" ? `<div class="accepted-banner"><strong>Offer accepted</strong><p>${escapeHtml(selected.worker_name)} is selected. Contact details are available on this page.</p></div>` : ""}</aside></article>`;
  refreshIcons(root);
}
function renderProfile() {
  const title = $("#profile-title"); const subtitle = $("#profile-subtitle"); const root = $("#profile-workspace");
  if (!state.user) { title.textContent = "My profile"; subtitle.textContent = "Sign in to manage your account."; root.innerHTML = '<div class="empty-state"><strong>Your workspace is ready when you sign in.</strong><button class="button button-teal" data-open-auth>Log in or sign up</button></div>'; $("#profile-auth").classList.remove("hidden"); return; }
  const isCustomer = state.user.role === "customer"; title.textContent = isCustomer ? "Customer workspace" : state.user.role === "admin" ? "Admin workspace" : "Provider workspace"; subtitle.textContent = `${state.user.name} · ${state.user.email}`; $("#profile-auth").classList.add("hidden");
  if (state.user.role === "admin") { root.innerHTML = '<div class="empty-state"><strong>Manage verification and support requests.</strong><button class="button button-teal" data-go-admin>Open admin workspace</button></div>'; return; }
  const myJobs = state.jobs.filter((job) => isCustomer ? job.customer_id === state.user.id : state.offers.some((offer) => offer.job_id === job.id && offer.worker_id === state.user.id));
  const myOffers = state.offers.filter((offer) => offer.worker_id === state.user.id);
  let tabs;
  if (isCustomer) tabs = `<button class="profile-tab active" data-profile-tab="posts">My posts <span>${myJobs.length}</span></button><button class="profile-tab" data-profile-tab="offers">Bids received <span>${state.offers.filter((offer) => myJobs.some((job) => job.id === offer.job_id)).length}</span></button><button class="profile-tab" data-profile-tab="account">Account &amp; contact</button>`;
  else tabs = `<button class="profile-tab active" data-profile-tab="alerts">Job alerts</button><button class="profile-tab" data-profile-tab="bids">My bids <span>${myOffers.length}</span></button><button class="profile-tab" data-profile-tab="history">Post history <span>${myJobs.length}</span></button><button class="profile-tab" data-profile-tab="account">Profile</button>`;
  root.innerHTML = `<div class="profile-tabs" role="tablist">${tabs}</div><div class="profile-panel" id="profile-panel"></div>`; renderProfilePanel(isCustomer ? "posts" : "alerts");
}
function renderProfilePanel(tab) {
  const panel = $("#profile-panel"); if (!panel || !state.user) return;
  const jobs = state.jobs.filter((job) => state.user.role === "customer" ? job.customer_id === state.user.id : state.offers.some((offer) => offer.job_id === job.id && offer.worker_id === state.user.id));
  const offers = state.offers.filter((offer) => state.user.role === "customer" ? jobs.some((job) => job.id === offer.job_id) : offer.worker_id === state.user.id);
  if (tab === "account") { panel.innerHTML = `<form id="profile-form" class="form-grid profile-form"><label class="form-field">Name<input name="name" required value="${escapeHtml(state.user.name)}"></label><label class="form-field">Phone<input name="phone" required value="${escapeHtml(state.user.phone || "")}"></label><label class="form-field">Area<input name="area" required value="${escapeHtml(state.user.area || "")}"></label><label class="form-field">Private address<input name="address" value="${escapeHtml(state.user.address || "")}"></label>${state.user.role === "worker" ? `<label class="form-field">Category<select name="category">${categoryOptions()}${state.categories.some((c) => c.name === state.user.category) ? "" : ""}</select></label><label class="form-field">Starting rate<input name="rate" type="number" min="1" value="${Number(state.user.rate || 500)}"></label><label class="form-field field-span">About your work<input name="bio" value="${escapeHtml(state.user.bio || "")}"></label>` : ""}<button class="button button-teal field-span">Save profile</button></form>`; if (state.user.role === "worker") $("#profile-form [name=category]").value = state.user.category; }
  else if (tab === "alerts") { const matches = state.jobs.filter((job) => job.status === "open" && (!state.alertOnly || job.category === state.user.category)); panel.innerHTML = `<div class="profile-panel-head"><div><h2>Job alerts</h2><p>Open tasks ${state.alertOnly ? `in ${escapeHtml(state.user.category || "your category")}` : "across all categories"}.</p></div><label class="toggle-control"><input id="alert-toggle" type="checkbox" ${state.alertOnly ? "checked" : ""}><span class="toggle-track"></span><span>My category only</span></label></div><div class="task-list">${matches.slice(0, 30).map((job) => jobCard(job)).join("") || '<p class="muted-copy">No matching open tasks.</p>'}</div>`; }
  else if (tab === "posts" || tab === "history") { panel.innerHTML = `<div class="profile-panel-head"><div><h2>${tab === "posts" ? "My posts" : "Post history"}</h2><p>${jobs.length} task${jobs.length === 1 ? "" : "s"} in your activity.</p></div>${state.user.role === "customer" ? '<button class="button button-rust" data-open-job>Post a task</button>' : ""}</div><div class="task-list">${jobs.map((job) => jobCard(job)).join("") || '<p class="muted-copy">No task activity yet.</p>'}</div></div>`; }
  else if (tab === "offers" || tab === "bids") { panel.innerHTML = `<div class="profile-panel-head"><div><h2>${tab === "offers" ? "Bids received" : "My bids"}</h2><p>${offers.length} offer${offers.length === 1 ? "" : "s"}.</p></div></div><div class="offer-list">${offers.map((offer) => { const job = state.jobs.find((item) => item.id === offer.job_id); return `<article class="offer-card"><div class="offer-card-title"><strong>${escapeHtml(state.user.role === "customer" ? offer.worker_name : job?.title || "Task")}</strong><span class="status-pill status-${offer.status}">${escapeHtml(offer.status)}</span></div><div class="offer-price">${money(offer.price)}</div><p>${escapeHtml(offer.message)}</p><a class="text-link" href="/tasks/${offer.job_id}" data-route>View task</a>${state.user.role === "customer" && offer.status === "pending" ? `<button class="button button-teal" data-accept-offer="${offer.id}">Accept offer</button>` : ""}</article>`; }).join("") || '<p class="muted-copy">No offers yet.</p>'}</div>`; }
  refreshIcons(panel);
}
async function renderAdmin() {
  if (!state.user || state.user.role !== "admin") { $("#admin-stats").innerHTML = '<div class="empty-state">Sign in with an admin account to open platform operations.</div>'; $("#admin-list").innerHTML = ""; $("#admin-tickets").innerHTML = ""; return; }
  try {
    const [stats, tickets] = await Promise.all([api("/api/admin/summary"), api("/api/admin/support")]);
    $("#admin-stats").innerHTML = Object.entries({ Accounts: stats.users, Providers: stats.providers, Customers: stats.customers, "Open tasks": stats.openJobs, "Awaiting verification": stats.pending, "Open requests": stats.tickets }).map(([label, count]) => `<div class="admin-stat"><strong>${Number(count).toLocaleString()}</strong><span>${label}</span></div>`).join("");
    $("#admin-list").innerHTML = state.workers.filter((w) => !w.verified).slice(0, 50).map((w) => `<article class="admin-row"><div><strong>${escapeHtml(w.name)}</strong><small>${escapeHtml(w.category)} · ${escapeHtml(w.area)}</small></div><button class="button button-outline" data-verify="${w.id}">Verify</button></article>`).join("") || '<p class="muted-copy">No providers waiting for verification.</p>';
    $("#admin-tickets").innerHTML = tickets.map((ticket) => `<article class="admin-row ticket-row"><div><strong>${escapeHtml(ticket.subject)}</strong><small>${escapeHtml(ticket.name)} · ${escapeHtml(ticket.email)}</small><p>${escapeHtml(ticket.message)}</p></div><select data-ticket-status="${ticket.id}"><option ${ticket.status === "open" ? "selected" : ""}>open</option><option ${ticket.status === "reviewing" ? "selected" : ""}>reviewing</option><option ${ticket.status === "resolved" ? "selected" : ""}>resolved</option></select></article>`).join("") || '<p class="muted-copy">No support requests.</p>';
  } catch (error) { showError($("#admin-stats"), error.message); }
}
function renderPage() {
  setActivePage();
  if (state.page === "categories") renderCategories();
  if (state.page === "jobs") renderTasks();
  if (state.page === "task-detail") renderTaskDetail(state.selectedJob);
  if (state.page === "hot") renderHotTasks();
  if (state.page === "profile") renderProfile();
  if (state.page === "admin") renderAdmin();
  refreshIcons();
}

function openAuth(mode = "login") { state.authMode = mode; updateAuthMode(); $("#auth-message").textContent = ""; $("#auth-dialog").showModal(); }
function updateAuthMode() {
  const register = state.authMode === "register"; $("#auth-title").textContent = register ? "Create your account" : "Welcome back"; $("#auth-submit").textContent = register ? "Create account" : "Log in";
  ["name-field", "role-field", "phone-field", "area-field", "address-field"].forEach((id) => { const field = $(`#${id}`); field.classList.toggle("hidden", !register); field.querySelector("input")?.toggleAttribute("required", register); });
  $("#worker-fields").classList.toggle("hidden", !register || $("#auth-form [name=role]").value !== "worker");
  $$("[data-auth-mode]").forEach((button) => button.classList.toggle("active", button.dataset.authMode === state.authMode));
}
function openJobDialog() {
  if (!state.user) return openAuth("login"); if (state.user.role !== "customer") return toast("Only customer accounts can post tasks.");
  const form = $("#job-form"); form.reset(); form.elements.area.value = state.user.area || ""; form.elements.contact_phone.value = state.user.phone || ""; form.elements.exact_address.value = state.user.address || ""; $("#job-message").textContent = ""; $("#job-dialog").showModal();
}
function openOfferDialog(jobId) {
  if (!state.user) return openAuth("login"); if (state.user.role !== "worker") return toast("Sign in as a service provider to make an offer.");
  const job = state.jobs.find((item) => item.id === Number(jobId)); if (!job) return;
  $("#offer-form").dataset.jobId = job.id; $("#offer-form").reset(); $("#offer-job-title").textContent = job.title; $("#offer-job-details").textContent = `${job.category} · ${job.area} · customer budget ${money(job.budget)}`; $("#offer-message").textContent = ""; $("#offer-dialog").showModal();
}
function bindEvents() {
  document.addEventListener("click", async (event) => {
    const route = event.target.closest("a[data-route]"); if (route) { event.preventDefault(); navigate(route.getAttribute("href")); return; }
    if (event.target.closest("[data-open-job]")) { event.preventDefault(); return openJobDialog(); }
    if (event.target.closest("[data-open-auth]")) return openAuth();
    if (event.target.closest("[data-close-dialog]")) return event.target.closest("dialog").close();
    const mode = event.target.closest("[data-auth-mode]"); if (mode) { state.authMode = mode.dataset.authMode; return updateAuthMode(); }
    const demo = event.target.closest("[data-demo]"); if (demo) { const account = { customer: "customer@servinear.local", worker: "worker@servinear.local", admin: "admin@servinear.local" }[demo.dataset.demo]; $("#auth-form [name=email]").value = account; $("#auth-form [name=password]").value = "ServiNear123!"; state.authMode = "login"; updateAuthMode(); return; }
    const category = event.target.closest("[data-category]"); if (category) { $("#service-search").value = category.dataset.category; state.page = "discover"; history.pushState({}, "", "/"); setActivePage(); renderProviders(); window.scrollTo(0, 0); return; }
    if (event.target.closest("[data-view-jobs]")) return navigate("/jobs");
    if (event.target.closest("[data-go-admin]")) return navigate("/admin");
    const task = event.target.closest("[data-task-id]"); if (task) { if (state.page !== "jobs") return navigate(`/tasks/${task.dataset.taskId}`); state.selectedJob = Number(task.dataset.taskId); renderTasks(); renderTaskPreview(state.jobs.find((job) => job.id === state.selectedJob)); return; }
    const goTask = event.target.closest("[data-go-task]"); if (goTask) return navigate(`/tasks/${goTask.dataset.goTask}`);
    const makeOffer = event.target.closest("[data-make-offer]"); if (makeOffer) return openOfferDialog(makeOffer.dataset.makeOffer);
    const accept = event.target.closest("[data-accept-offer]"); if (accept) { try { await post(`/api/offers/${accept.dataset.acceptOffer}/accept`, {}); await reload(); toast("Offer accepted. Contact details are now shared with the selected provider."); } catch (error) { toast(error.message); } return; }
    const complete = event.target.closest("[data-complete-task]"); if (complete) { try { await post(`/api/jobs/${complete.dataset.completeTask}/complete`, {}); await reload(); if (state.page === "task-detail") renderTaskDetail(state.selectedJob); toast("Task marked complete. The customer can now leave a review."); } catch (error) { toast(error.message); } return; }
    const verify = event.target.closest("[data-verify]"); if (verify) { try { await post(`/api/admin/workers/${verify.dataset.verify}/verify`, { verified: true }, "PATCH"); await reload(); toast("Provider verified."); } catch (error) { toast(error.message); } return; }
    const toggle = event.target.closest(".dropdown-toggle"); if (toggle) { const menu = toggle.nextElementSibling; menu.classList.toggle("open"); toggle.setAttribute("aria-expanded", menu.classList.contains("open")); }
  });
  window.addEventListener("popstate", () => { state.page = routeFromPath(); renderPage(); });
  $("#auth-button").addEventListener("click", async () => { if (!state.user) return openAuth(); try { await post("/api/auth/logout", {}); state.user = null; await reload(); toast("You are logged out."); } catch (error) { toast(error.message); } });
  $("#auth-form [name=role]").addEventListener("change", updateAuthMode);
  $("#auth-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); const endpoint = state.authMode === "register" ? "/api/auth/register" : "/api/auth/login"; try { const result = await post(endpoint, values); state.user = result.user; $("#auth-dialog").close(); await reload(); toast(`Welcome${state.user.name ? `, ${state.user.name.split(" ")[0]}` : ""}.`); } catch (error) { showError($("#auth-message"), error.message); } });
  $("#job-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); if (values.shareLocation === "on" && !state.position) return showError($("#job-message"), "Choose Near me first to attach GPS coordinates."); if (state.position && values.shareLocation === "on") { values.latitude = state.position.latitude; values.longitude = state.position.longitude; } delete values.shareLocation; try { await post("/api/jobs", values); $("#job-dialog").close(); await reload(); navigate("/profile"); toast("Your task is live. Providers can now make offers."); } catch (error) { showError($("#job-message"), error.message); } });
  $("#offer-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); try { await post(`/api/jobs/${form.dataset.jobId}/offers`, values); $("#offer-dialog").close(); await reload(); if (state.page === "task-detail") renderTaskDetail(state.selectedJob); toast("Your offer has been sent."); } catch (error) { showError($("#offer-message"), error.message); } });
  $("#support-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = event.currentTarget; try { await post("/api/support", Object.fromEntries(new FormData(form))); form.reset(); if (state.user) { form.elements.name.value = state.user.name; form.elements.email.value = state.user.email; } showSuccess($("#support-message"), "Your request is saved. The admin team can review it in the platform workspace."); } catch (error) { showError($("#support-message"), error.message); } });
  $("#provider-search").addEventListener("submit", (event) => { event.preventDefault(); state.providerLimit = 24; renderProviders(); });
  ["#service-search", "#area-search", "#verified-filter", "#sort-filter"].forEach((selector) => $(selector).addEventListener("input", () => { state.providerLimit = 24; renderProviders(); }));
  ["#task-search", "#task-category-filter", "#task-sort"].forEach((selector) => $(selector).addEventListener("input", () => { state.taskLimit = 20; renderTasks(); }));
  $("#provider-more").addEventListener("click", () => { state.providerLimit += 24; renderProviders(); }); $("#task-more").addEventListener("click", () => { state.taskLimit += 20; renderTasks(); });
  $("#locate-button").addEventListener("click", () => { if (!navigator.geolocation) return toast("GPS is not available in this browser."); navigator.geolocation.getCurrentPosition((position) => { state.position = { latitude: position.coords.latitude, longitude: position.coords.longitude }; $("#area-search").value = ""; $("#sort-filter").value = "distance"; renderProviders(); state.map?.setView([state.position.latitude, state.position.longitude], 12); toast("Nearby results are sorted by distance."); }, () => toast("Location permission was not granted."), { enableHighAccuracy: true, timeout: 10000 }); });
  $("#map-recenter").addEventListener("click", () => state.map?.setView(state.position ? [state.position.latitude, state.position.longitude] : [23.78, 90.39], state.position ? 12 : 10));
  $("#profile-workspace").addEventListener("click", (event) => { const tab = event.target.closest("[data-profile-tab]"); if (tab) { $$(".profile-tab").forEach((el) => el.classList.toggle("active", el === tab)); return renderProfilePanel(tab.dataset.profileTab); } });
  $("#profile-workspace").addEventListener("change", async (event) => { if (event.target.id === "alert-toggle") { state.alertOnly = event.target.checked; try { window.localStorage.setItem("servinear-alerts", state.alertOnly ? "on" : "off"); } catch {} return renderProfilePanel("alerts"); } if (event.target.matches("[data-ticket-status]")) { try { await post(`/api/admin/support/${event.target.dataset.ticketStatus}`, { status: event.target.value }, "PATCH"); toast("Support status updated."); } catch (error) { toast(error.message); } } });
  $("#admin-tickets").addEventListener("change", async (event) => { if (!event.target.matches("[data-ticket-status]")) return; try { await post(`/api/admin/support/${event.target.dataset.ticketStatus}`, { status: event.target.value }, "PATCH"); toast("Support status updated."); } catch (error) { toast(error.message); } });
  $("#profile-workspace").addEventListener("submit", async (event) => { if (event.target.id !== "profile-form") return; event.preventDefault(); try { const result = await post("/api/profile", Object.fromEntries(new FormData(event.target)), "PATCH"); state.user = result.user; await reload(); toast("Profile updated."); } catch (error) { toast(error.message); } });
  $("#task-detail-root").addEventListener("submit", async (event) => { const form = event.target.closest("[data-review-task]"); if (!form) return; event.preventDefault(); try { await post(`/api/jobs/${form.dataset.reviewTask}/review`, Object.fromEntries(new FormData(form))); await reload(); renderTaskDetail(state.selectedJob); toast("Thanks. Your review has been saved."); } catch (error) { toast(error.message); } });
  $("#menu-button").addEventListener("click", () => $("#main-nav").classList.toggle("open"));
}

async function init() {
  try {
    bindEvents();
    Object.assign(state, await api("/api/bootstrap"));
    if (state.user && $("#support-form")) { $("#support-form").elements.name.value = state.user.name; $("#support-form").elements.email.value = state.user.email; }
    renderAll();
  } catch (error) { console.error(error); toast(`App could not start: ${error.message}`); }
}
init();
