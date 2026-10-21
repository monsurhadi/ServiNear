"use strict";

// ==========================================================================
// 1. STATE & UTILITIES
// ==========================================================================


const PROFESSION_ICONS = [
  { id: "videographer", symbol: "📷", label: "Videographer" },
  { id: "bike_owner", symbol: "🏍️", label: "Bike Owner" },
  { id: "student", symbol: "🎓", label: "Student" },
  { id: "unemployed", symbol: "🍲", label: "Unemployed" },
  { id: "female", symbol: "💄", label: "Female" },
  { id: "teacher", symbol: "📚", label: "Teacher" },
  { id: "bd_citizen", symbol: "🇧🇩", label: "BD Citizen" }
];

let savedAlertPreference = "off";
try { savedAlertPreference = window.localStorage.getItem("servinear-alerts") || "off"; } catch {}

let savedLang = "bn";
try { savedLang = window.localStorage.getItem("servinear_lang") || "bn"; } catch {}

const state = {
  user: null,
  workers: [],
  categories: [],
  jobs: [],
  offers: [],
  page: "discover",
  selectedJob: null,
  taskLimit: 20,
  providerLimit: 24,
  position: null,
  map: null,
  markers: null,
  authMode: "login",
  alertOnly: savedAlertPreference === "on",
  lang: savedLang,
  notifications: [],
  unreadNotifications: 0,
  unreadMessages: 0,
  savedCount: 0,
  savedPosts: { tasks: [], workers: [] },
  savedTab: "tasks",
  inbox: {
    threads: [],
    activePeerId: null,
    activeJobId: null,
    filter: "all",
    search: ""
  },
  nidUploads: {
    front: null,
    back: null,
    selfie: null
  },
  adminInspectTarget: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const money = (value) => value == null ? (state.lang === "bn" ? "বাজেট পরিবর্তনশীল" : "Budget flexible") : `৳${Number(value).toLocaleString("en-BD")}`;

const dateLabel = (value) => {
  if (!value) return "";
  try {
    const d = new Date(String(value).replace(" ", "T") + (String(value).endsWith("Z") ? "" : "Z"));
    return new Intl.DateTimeFormat(state.lang === "bn" ? "bn-BD" : "en-US", { dateStyle: "medium" }).format(d);
  } catch {
    return String(value);
  }
};

const timeAgo = (dateStr) => {
  if (!dateStr) return "";
  try {
    const d = new Date(String(dateStr).replace(" ", "T") + (String(dateStr).endsWith("Z") ? "" : "Z"));
    const sec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (sec < 60) return state.lang === "bn" ? "এইমাত্র" : "just now";
    if (sec < 3600) return state.lang === "bn" ? `${Math.floor(sec / 60)} মি. আগে` : `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return state.lang === "bn" ? `${Math.floor(sec / 3600)} ঘণ্টা আগে` : `${Math.floor(sec / 3600)}h ago`;
    return state.lang === "bn" ? `${Math.floor(sec / 86400)} দিন আগে` : `${Math.floor(sec / 86400)}d ago`;
  } catch {
    return "";
  }
};

const categoryOptions = (placeholder = "Choose a category") => 
  `<option value="">${placeholder}</option>${state.categories.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join("")}`;

const API_BASE = String(window.SERVINEAR_API_BASE || "").trim().replace(/\/+$/, "");

async function api(path, options = {}) {
  if (!API_BASE) {
    throw new Error("API URL is not configured. Set SERVINEAR_API_BASE in runtime-config.js or Vercel environment variables.");
  }

  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    "ngrok-skip-browser-warning": "true",
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

function refreshIcons(root = document) {
  if (window.lucide) window.lucide.createIcons({ root });
}

function toast(message) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 3200);
}

function showError(node, message) {
  if (node) {
    node.textContent = message;
    node.classList.add("error");
  } else toast(message);
}

function showSuccess(node, message) {
  if (node) {
    node.textContent = message;
    node.classList.remove("error");
    node.classList.add("success");
  } else toast(message);
}

// ==========================================================================
// 2. INTERNATIONALIZATION (BANGLA & ENGLISH)
// ==========================================================================

const I18N = {
  en: {
    heroPill: "BANGLADESH'S INDEPENDENT LOCAL SERVICES",
    directContactBadge: "Verified Workers · Direct Pay · Zero Commission",
    directContactSub: "Local community marketplace connecting tradespeople and neighbors.",
    heroTitle: "Find trusted local help <em>in minutes.</em>",
    heroSub: "Compare verified tradespeople, view open job offers, or post a request with zero platform fees.",
    searchPlaceholder: "What help do you need? (e.g. Electrician, AC Repair, Cleaning)",
    areaPlaceholder: "Area or Road (e.g. Dhanmondi, Mirpur 10)",
    findHelpBtn: "Find help",
    postTaskCta: "Post a task",
    nearMeBtn: "Near me",
    verifiedOnly: "Verified profiles only",
    sortLabel: "Sort:",
    sortRecommended: "Recommended",
    sortDistance: "Closest to me",
    sortRating: "Highest rating",
    sortPrice: "Lowest starting rate",
    viewAllCategories: "View all categories →",
    popularCategories: "POPULAR CATEGORIES",
    exploreByTrade: "Explore by trade",
    exploreSub: "From AC servicing to domestic electricians, hire experienced specialists directly.",
    browseAllTradesBtn: "Browse all trades",
    liveMapTitle: "Dhaka & Regional Service Map",
    liveMapSub: "Click any marker to inspect provider profiles in that location.",
    recenterMap: "Recenter map",
    notifTitle: "Notifications",
    markRead: "Mark all read",
    noNotifs: "No new notifications.",
    inboxTitle: "Inbox",
    allThreads: "All",
    chatsFilter: "Chats",
    ordersFilter: "Orders",
    requestsFilter: "Requests",
    searchInboxPh: "Search conversations...",
    selectConversation: "Select a conversation to start messaging",
    typeMessagePh: "Type your message...",
    sendBtn: "Send",
    savedEyebrow: "BOOKMARKS & ARCHIVE",
    savedTitle: "Saved Posts & Professionals",
    savedSub: "Review all the tasks and service providers you bookmarked for later.",
    tabSavedTasks: "Saved Tasks",
    tabSavedWorkers: "Saved Professionals",
    profileTitle: "My Profile",
    editProfileBtn: "Edit Profile",
    getVerifiedBtn: "Get Verified",
    navSearch: "Search Tasks",
    navNearby: "Hire Nearby People",
    navHelp: "Help Requests",
    navInbox: "Inbox Chat",
    navTrending: "Trending Posts",
    navDokan: "Dokan Pat / Services",
    navOrders: "My Orders & Bids",
    navSaved: "Saved Posts",
    navVerify: "Get Verified",
    navSupport: "Support Team",
    postsCount: "Posts",
    bidsCount: "Bids",
    savedCountLabel: "Saved",
    loginBtn: "Log in",
    logoutBtn: "Log out",
    signupBtn: "Create Account",
    myProfile: "My Profile",
    postTaskNav: "Post a task",
    footerAbout: "About",
    footerCategories: "Categories",
    footerTasks: "Help Requests",
    footerHelpline: "Helpline"
  },
  bn: {
    heroPill: "বাংলাদেশের স্বাধীন স্থানীয় সার্ভিস নেটওয়ার্ক",
    directContactBadge: "যাচাইকৃত কর্মী · সরাসরি পেমেন্ট · জিরো কমিশন",
    directContactSub: "দক্ষ কারিগর ও প্রতিবেশীদের সরাসরি সংযুক্ত করার আধুনিক উন্মুক্ত প্ল্যাটফর্ম।",
    heroTitle: "নিকটস্থ দক্ষ সেবা খুঁজুন <em>মুহূর্তেই।</em>",
    heroSub: "যাচাইকৃত পেশাজীবী দেখুন, পোস্ট করা কাজের রেট যাচাই করুন বা বিনামূল্যে আপনার কাজের পোস্ট দিন।",
    searchPlaceholder: "কী সেবা প্রয়োজন? (যেমন: ইলেক্ট্রিশিয়ান, এসি মেরামত, ক্লিনিং)",
    areaPlaceholder: "এলাকা বা রোড (যেমন: ধানমন্ডি, মিরপুর ১০)",
    findHelpBtn: "খুঁজুন",
    postTaskCta: "কাজের পোস্ট দিন",
    nearMeBtn: "আমার কাছে",
    verifiedOnly: "শুধুমাত্র যাচাইকৃত প্রোফাইল",
    sortLabel: "সাজান:",
    sortRecommended: "প্রস্তাবিত",
    sortDistance: "নিকটবর্তী দূরত্ব",
    sortRating: "সেরা রেটিং",
    sortPrice: "কম রেট",
    viewAllCategories: "সব ক্যাটাগরি দেখুন →",
    popularCategories: "জনপ্রিয় ক্যাটাগরি",
    exploreByTrade: "পেশাভিত্তিক সেবা",
    exploreSub: "এসি সার্ভিসিং থেকে হাউস ক্লিনিং—অভিজ্ঞ প্রফেশনালদের সাথে সরাসরি যোগাযোগ করুন।",
    browseAllTradesBtn: "সব পেশা দেখুন",
    liveMapTitle: "ঢাকা ও আঞ্চলিক সার্ভিস ম্যাপ",
    liveMapSub: "যেকোনো মার্কার ক্লিক করে ওই এলাকার সার্ভিস প্রোভাইডারদের প্রোফাইল দেখুন।",
    recenterMap: "ম্যাপ রিসেন্টার",
    notifTitle: "নোটিফিকেশন",
    markRead: "সব পড়া হয়েছে",
    noNotifs: "নতুন কোনো নোটিফিকেশন নেই।",
    inboxTitle: "ইনবক্স চ্যাট",
    allThreads: "সব",
    chatsFilter: "চ্যাট",
    ordersFilter: "অর্ডার",
    requestsFilter: "রিকোয়েস্ট",
    searchInboxPh: "কথোপকথন খুঁজুন...",
    selectConversation: "মেসেজ দেখতে বা পাঠাতে বামপাশ থেকে চ্যাট নির্বাচন করুন",
    typeMessagePh: "আপনার বার্তা লিখুন...",
    sendBtn: "পাঠান",
    savedEyebrow: "বুকমার্ক ও সংরক্ষিত তালিকা",
    savedTitle: "সংরক্ষিত পোস্ট ও পেশাজীবী",
    savedSub: "পরবর্তীতে যোগাযোগের জন্য সেভ করে রাখা কাজের পোস্ট ও প্রোভাইডার তালিকা।",
    tabSavedTasks: "সংরক্ষিত কাজসমূহ",
    tabSavedWorkers: "সংরক্ষিত প্রোভাইডার",
    profileTitle: "আমার প্রোফাইল",
    editProfileBtn: "প্রোফাইল পরিবর্তন",
    getVerifiedBtn: "ভেরিফিকেশন করুন",
    navSearch: "কাজের অনুসন্ধান",
    navNearby: "কাছের মানুষ খুঁজুন",
    navHelp: "সাহায্য ও পোস্ট",
    navInbox: "ইনবক্স মেসেজ",
    navTrending: "ট্রেন্ডিং কাজ",
    navDokan: "দোকান পাট / সার্ভিস",
    navOrders: "আমার অর্ডার ও বিড",
    navSaved: "সংরক্ষিত পোস্ট",
    navVerify: "এনআইডি ভেরিফাই",
    navSupport: "সাপোর্ট টিম",
    postsCount: "পোস্ট",
    bidsCount: "বিড/অর্ডার",
    savedCountLabel: "সংরক্ষিত",
    loginBtn: "লগইন",
    logoutBtn: "লগআউট",
    signupBtn: "অ্যাকাউন্ট খুলুন",
    myProfile: "আমার প্রোফাইল",
    postTaskNav: "কাজের পোস্ট দিন",
    footerAbout: "সম্পর্কে",
    footerCategories: "ক্যাটাগরি",
    footerTasks: "সাহায্যের অনুরোধ",
    footerHelpline: "হেল্পলাইন"
  }
};

function setLanguage(lang) {
  state.lang = lang;
  try { window.localStorage.setItem("servinear_lang", lang); } catch {}

  const toggleBtn = $("#lang-toggle");
  if (toggleBtn) {
    toggleBtn.innerHTML = lang === "bn" 
      ? '<span class="lang-pill-bn">বাংলা</span> | <span class="muted-text">English</span>'
      : '<span class="muted-text">বাংলা</span> | <span class="lang-pill-en">English</span>';
  }

  const dict = I18N[lang] || I18N.en;
  $$("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (dict[key]) {
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.placeholder = dict[key];
      } else {
        el.innerHTML = dict[key];
      }
    }
  });

  renderAll();
}

// ==========================================================================
// 3. NAVIGATION & ROUTING
// ==========================================================================

function routeFromPath() {
  const path = location.pathname.replace(/\/$/, "") || "/";
  if (/^\/tasks\/\d+$/.test(path)) {
    state.selectedJob = Number(path.split("/").pop());
    return "task-detail";
  }
  return ({
    "/": "discover",
    "/categories": "categories",
    "/jobs": "jobs",
    "/hot-offers": "hot",
    "/about": "about",
    "/how-it-works": "how",
    "/help": "help",
    "/profile": "profile",
    "/admin": "admin",
    "/inbox": "inbox",
    "/saved": "saved"
  })[path] || "discover";
}

function navigate(path) {
  if (path === "#post") return openJobDialog();
  history.pushState({}, "", path);
  state.page = routeFromPath();
  window.scrollTo(0, 0);
  renderPage();
}

function setActivePage() {
  $$(".page-view").forEach((view) => view.classList.toggle("hidden", view.dataset.page !== state.page));
  $$(".nav-link[data-route]").forEach((link) => link.classList.toggle("active", link.getAttribute("href") === location.pathname));
}

// ==========================================================================
// 4. DATA RELOAD & RENDER
// ==========================================================================

async function reload() {
  try {
    const bootstrap = await api("/api/bootstrap");
    Object.assign(state, bootstrap);
    updateBadges();
    renderAll();
  } catch (error) {
    console.error("Reload error:", error);
  }
}

function updateBadges() {
  const notifCount = state.unreadNotifications || 0;
  const notifBadge = $("#notif-badge");
  if (notifBadge) {
    notifBadge.textContent = notifCount > 9 ? "9+" : notifCount;
    notifBadge.classList.toggle("hidden", notifCount <= 0);
  }

  const msgCount = state.unreadMessages || 0;
  const chatBadge = $("#chat-badge");
  if (chatBadge) {
    chatBadge.textContent = msgCount > 9 ? "9+" : msgCount;
    chatBadge.classList.toggle("hidden", msgCount <= 0);
  }
  const sidebarChatBadge = $("#sidebar-chat-badge");
  if (sidebarChatBadge) {
    sidebarChatBadge.textContent = msgCount;
    sidebarChatBadge.classList.toggle("hidden", msgCount <= 0);
  }
}

function renderAll() {
  state.page = routeFromPath();
  const dict = I18N[state.lang] || I18N.en;

  const authBtn = $("#auth-button");
  if (authBtn) authBtn.textContent = state.user ? dict.logoutBtn : dict.loginBtn;

  const profileLink = $("#profile-link");
  if (profileLink) {
    const nameSpan = profileLink.querySelector("span");
    if (nameSpan) nameSpan.textContent = state.user ? state.user.name.split(" ")[0] : dict.myProfile;
    profileLink.classList.toggle("hidden", !state.user);
  }

  const adminLink = $("#admin-link");
  if (adminLink) adminLink.classList.toggle("hidden", state.user?.role !== "admin");

  const chatBtn = $("#nav-chat-btn");
  if (chatBtn) chatBtn.classList.toggle("hidden", !state.user);

  const notifBtn = $("#notif-toggle-btn");
  if (notifBtn) notifBtn.classList.toggle("hidden", !state.user);

  renderCategoryOptions();
  renderFeaturedCategories();
  renderProviders();
  renderTasks();
  renderHotTasks();
  renderPage();
  updateBadges();
}

function renderCategoryOptions() {
  const jobCat = $("#job-category");
  const regCat = $("#reg-worker-category");
  const taskFilter = $("#task-category-filter");
  if (jobCat) jobCat.innerHTML = categoryOptions();
  if (regCat) regCat.innerHTML = categoryOptions();
  if (taskFilter) {
    taskFilter.innerHTML = `<option value="">${state.lang === "bn" ? "সব ক্যাটাগরি" : "All categories"}</option>${state.categories.map((c) => `<option>${escapeHtml(c.name)}</option>`).join("")}`;
  }
}

function categoryTile(category, featured = false) {
  const icon = ({
    Cleaning: "sparkles",
    Electrical: "zap",
    Plumbing: "wrench",
    Appliances: "refrigerator",
    Painting: "paintbrush",
    Handyman: "hammer",
    Carpentry: "ruler",
    "Building & Construction": "construction",
    Removals: "truck",
    Delivery: "package",
    Gardening: "flower-2",
    Assembly: "settings",
    Auto: "car-front",
    Beauty: "heart",
    Tutoring: "book-open",
    Cooking: "cooking-pot",
    "Food Delivery": "bike",
    Photography: "camera",
    "Computers & IT": "monitor",
    "Audio Visual": "headphones"
  })[category.name] || "briefcase-business";

  return `
    <button class="category-tile ${featured ? "featured-tile" : ""}" data-category="${escapeHtml(category.name)}">
      <span class="category-icon"><i data-lucide="${icon}"></i></span>
      <strong>${escapeHtml(category.name)}</strong>
      ${featured ? `<small>${escapeHtml(category.description)}</small>` : ""}
    </button>
  `;
}

function renderFeaturedCategories() {
  const el = $("#featured-categories");
  if (!el) return;
  el.innerHTML = state.categories.slice(0, 8).map((cat) => categoryTile(cat, true)).join("");
  refreshIcons(el);
}

function renderCategories() {
  const el = $("#all-categories");
  if (!el) return;
  el.innerHTML = state.categories.map((cat) => categoryTile(cat)).join("");
  refreshIcons(el);
}

function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLng = (b.longitude - a.longitude) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function filteredProviders() {
  const query = $("#service-search")?.value.trim().toLowerCase() || "";
  const area = $("#area-search")?.value.trim().toLowerCase() || "";
  const verified = $("#verified-filter")?.checked || false;
  const sort = $("#sort-filter")?.value || "recommended";

  const rows = state.workers.filter((worker) => 
    (!verified || worker.verified) &&
    (!query || `${worker.category} ${worker.name} ${worker.bio}`.toLowerCase().includes(query)) &&
    (!area || worker.area.toLowerCase().includes(area) || state.position)
  );

  if (sort === "distance" && state.position) rows.sort((a, b) => haversine(state.position, a) - haversine(state.position, b));
  if (sort === "rating") rows.sort((a, b) => b.rating - a.rating || b.verified - a.verified);
  if (sort === "price") rows.sort((a, b) => a.rate - b.rate);
  return rows;
}


let vectorSearchTimeout = null;
async function triggerVectorSearch(query) {
  clearTimeout(vectorSearchTimeout);
  if (!query || query.trim().length < 2) {
    state.vectorResults = null;
    renderProviders();
    return;
  }
  vectorSearchTimeout = setTimeout(async () => {
    try {
      const data = await api(`/api/vector/search?q=${encodeURIComponent(query)}&type=workers&limit=24`);
      state.vectorResults = new Map(data.results.map(r => [r.entity_id, r]));
      renderProviders();
    } catch(e) {
      console.error("Vector search error:", e);
    }
  }, 250);
}

function renderProviders() {
  const list = $("#provider-list");
  if (!list) return;
  const rows = filteredProviders();
  const visible = rows.slice(0, state.providerLimit);

  const summary = $("#provider-summary");
  if (summary) {
    summary.textContent = state.lang === "bn"
      ? `${rows.length.toLocaleString("bn-BD")} জন দক্ষ কারিগর পাওয়া গেছে`
      : `${rows.length.toLocaleString()} professionals match your search.`;
  }

  const empty = $("#provider-empty");
  if (empty) empty.classList.toggle("hidden", rows.length > 0);

  list.innerHTML = visible.map((w) => `
    <article class="provider-card">
      <div class="provider-avatar">${escapeHtml(w.name.slice(0, 1))}</div>
      <div class="provider-main">
        <div class="provider-name-row">
          <h3>${escapeHtml(w.name)}</h3>
          ${w.verified ? '<span class="verified-badge"><i data-lucide="badge-check"></i> Verified</span>' : ""}
          <button class="bookmark-btn ${w.is_saved ? "saved" : ""}" data-bookmark-type="worker" data-bookmark-id="${w.id}" title="Save provider">
            <i data-lucide="bookmark"></i>
          </button>
        </div>
        <p class="provider-category">${escapeHtml(w.category)} <span>·</span> ${escapeHtml(w.area)}</p>
        <p class="provider-bio">${escapeHtml(w.bio || "Local service professional")}</p>
        <div class="provider-meta">
          <span><i data-lucide="star"></i> ${Number(w.rating || 0).toFixed(1)} (${w.reviews})</span>
          <span><i data-lucide="briefcase-business"></i> ${w.experience || 1}+ yrs</span>
          <span class="availability">${escapeHtml(w.availability || "Available")}</span>
          ${state.user ? `<button class="button-text text-teal text-xs ml-auto font-bold" data-open-chat-peer="${w.user_id || w.id}" data-peer-name="${escapeHtml(w.name)}">Chat</button>` : ""}
        </div>
      </div>
      <div class="provider-price">
        <small>Starting from</small>
        <strong>${money(w.rate)}</strong>
      </div>
    </article>
  `).join("");

  const moreBtn = $("#provider-more");
  if (moreBtn) moreBtn.classList.toggle("hidden", rows.length <= state.providerLimit);

  refreshIcons(list);
  renderMap(rows);
}

function renderMap(rows = filteredProviders()) {
  if (!window.L || !$("#service-map")) return;
  if (!state.map) {
    state.map = L.map("service-map", { scrollWheelZoom: false }).setView(
      state.position ? [state.position.latitude, state.position.longitude] : [23.78, 90.39],
      10
    );
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap"
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.markers.clearLayers();
  rows.filter((w) => w.latitude && w.longitude).slice(0, 150).forEach((w) => {
    L.marker([w.latitude, w.longitude])
      .bindPopup(`<strong>${escapeHtml(w.name)}</strong><br>${escapeHtml(w.category)} · ${escapeHtml(w.area)}`)
      .addTo(state.markers);
  });
  setTimeout(() => state.map?.invalidateSize(), 100);
}

function jobCard(job, active = false) {
  return `
    <button class="task-card ${active ? "selected" : ""}" data-task-id="${job.id}">
      <span class="task-card-top">
        <strong>${escapeHtml(job.title)}</strong>
        <b>${money(job.budget)}</b>
      </span>
      <span class="task-card-meta">
        <span>${escapeHtml(job.category)}</span>
        <span>${escapeHtml(job.area)}</span>
        <span>${job.offer_count} ${job.offer_count === 1 ? "offer" : "offers"}</span>
      </span>
      <span class="task-card-bottom">
        <span class="status-pill status-${job.status}">${escapeHtml(job.status)}</span>
        <time>${dateLabel(job.created_at)}</time>
        <span class="bookmark-btn ${job.is_saved ? "saved" : ""}" data-bookmark-type="job" data-bookmark-id="${job.id}" title="Save task" onclick="event.stopPropagation()">
          <i data-lucide="bookmark"></i>
        </span>
      </span>
    </button>
  `;
}

function filteredJobs() {
  const q = $("#task-search")?.value.trim().toLowerCase() || "";
  const category = $("#task-category-filter")?.value || "";
  const sort = $("#task-sort")?.value || "newest";

  const rows = state.jobs.filter((job) => 
    job.status === "open" &&
    (!category || job.category === category) &&
    (!q || `${job.title} ${job.details} ${job.area} ${job.category}`.toLowerCase().includes(q))
  );

  if (sort === "budget") rows.sort((a, b) => (b.budget || 0) - (a.budget || 0));
  else if (sort === "offers") rows.sort((a, b) => a.offer_count - b.offer_count);
  else rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return rows;
}

function renderTasks() {
  const list = $("#task-list");
  if (!list) return;
  const rows = filteredJobs();
  list.innerHTML = rows.slice(0, state.taskLimit).map((job) => jobCard(job, state.selectedJob === job.id)).join("") 
    || `<div class="empty-state"><strong>${state.lang === "bn" ? "কোনো কাজ পাওয়া যায়নি" : "No tasks found"}</strong><span>${state.lang === "bn" ? "অন্য কোনো ক্যাটাগরি বা শব্দ দিয়ে খুঁজুন।" : "Try another category or search."}</span></div>`;

  const moreBtn = $("#task-more");
  if (moreBtn) moreBtn.classList.toggle("hidden", rows.length <= state.taskLimit);

  if (state.selectedJob && state.page === "jobs") {
    renderTaskPreview(state.jobs.find((job) => job.id === state.selectedJob));
  }
  refreshIcons(list);
}

function renderTaskPreview(job) {
  const panel = $("#task-preview");
  if (!panel) return;
  if (!job) {
    panel.innerHTML = `<div class="preview-placeholder"><strong>${state.lang === "bn" ? "একটি কাজ নির্বাচন করুন" : "Choose a task"}</strong><span>${state.lang === "bn" ? "বিস্তারিত বিবরণ এখানে দেখা যাবে।" : "Its description will appear here."}</span></div>`;
    return;
  }
  panel.innerHTML = `
    <span class="status-pill status-${job.status}">${escapeHtml(job.status)}</span>
    <h2>${escapeHtml(job.title)}</h2>
    <div class="task-detail-meta">
      <span>${escapeHtml(job.category)}</span>
      <span>${escapeHtml(job.area)}</span>
      <span>${dateLabel(job.created_at)}</span>
    </div>
    <div class="budget-panel">
      <div>
        <small>${state.lang === "bn" ? "বাজেট" : "Budget"}</small>
        <strong>${money(job.budget)}</strong>
      </div>
      <button class="button button-rust" data-go-task="${job.id}">${state.lang === "bn" ? "বিস্তারিত দেখুন" : "View task"}</button>
    </div>
    <h3>${state.lang === "bn" ? "কাজের বিবরণ" : "Description"}</h3>
    <p>${escapeHtml(job.details)}</p>
    <div class="poster-line">${state.lang === "bn" ? "পোস্টকারী:" : "Posted by"} ${escapeHtml(job.customer_name)}</div>
    ${job.contact_phone ? `
      <p class="private-contact">
        Phone: ${escapeHtml(job.contact_phone)}<br>
        Address: ${escapeHtml(job.exact_address)}
      </p>
    ` : `<p class="privacy-note">${state.lang === "bn" ? "অফার গ্রহণ করার পর সঠিক ঠিকানা ও নম্বর দেখতে পাবেন।" : "Exact address and phone are shared after the customer accepts your offer."}</p>`}
  `;
}

function renderHotTasks() {
  const list = $("#hot-task-list");
  if (!list) return;
  list.innerHTML = state.jobs
    .filter((job) => job.status === "open")
    .sort((a, b) => b.offer_count - a.offer_count)
    .slice(0, 12)
    .map((job) => jobCard(job))
    .join("") || `<div class="empty-state">${state.lang === "bn" ? "বর্তমানে কোনো উন্মুক্ত কাজ নেই।" : "No open tasks right now."}</div>`;
  refreshIcons(list);
}

function renderTaskDetail(id) {
  const job = state.jobs.find((item) => item.id === id);
  const root = $("#task-detail-root");
  if (!root) return;
  if (!job) {
    root.innerHTML = `<div class="empty-state"><h2>Task not found</h2><a href="/jobs" data-route>Back to tasks</a></div>`;
    return;
  }
  const relatedOffers = state.offers.filter((offer) => offer.job_id === id);
  const canSeeOffers = state.user?.role === "customer" && job.customer_id === state.user.id;
  const selected = relatedOffers.find((offer) => offer.status === "accepted");
  const assignedProvider = state.user?.role === "worker" && selected?.worker_id === state.user.id;
  const canReview = canSeeOffers && job.status === "completed" && !selected?.reviewed;

  root.innerHTML = `
    <article class="task-detail-page">
      <div class="task-detail-main">
        <span class="status-pill status-${job.status}">${escapeHtml(job.status)} task</span>
        <p class="eyebrow">${escapeHtml(job.category)} · POSTED ${dateLabel(job.created_at)}</p>
        <h1>${escapeHtml(job.title)}</h1>
        <div class="task-detail-meta">
          <span><i data-lucide="map-pin"></i> ${escapeHtml(job.area)}</span>
          <span><i data-lucide="calendar-days"></i> ${dateLabel(job.created_at)}</span>
          <span><i data-lucide="user-round"></i> ${escapeHtml(job.customer_name)}</span>
        </div>
        <div class="budget-panel">
          <div><small>Customer budget</small><strong>${money(job.budget)}</strong></div>
          ${state.user?.role === "worker" && job.status === "open" ? `<button class="button button-rust" data-make-offer="${id}">Make an offer</button>` : ""}
        </div>
        <h2>Task description</h2>
        <p class="task-description">${escapeHtml(job.details)}</p>
        ${job.contact_phone ? `
          <section class="contact-reveal">
            <h3><i data-lucide="shield-check"></i> Customer contact</h3>
            <p>Shared with the customer’s accepted provider.</p>
            <a href="tel:${escapeHtml(job.contact_phone)}">${escapeHtml(job.contact_phone)}</a>
            <p>${escapeHtml(job.exact_address || "")}</p>
          </section>
        ` : `<p class="privacy-note">The customer’s exact address and phone stay private until they accept an offer.</p>`}
        ${assignedProvider && job.status === "accepted" ? `<button class="button button-teal" data-complete-task="${id}">Mark task complete</button>` : ""}
        ${canReview ? `
          <form class="review-form" data-review-task="${id}">
            <h2>Review this provider</h2>
            <label class="form-field">Rating
              <select name="rating" required>
                <option value="5">5 · Excellent</option>
                <option value="4">4 · Good</option>
                <option value="3">3 · Okay</option>
                <option value="2">2 · Not great</option>
                <option value="1">1 · Poor</option>
              </select>
            </label>
            <label class="form-field">Review
              <textarea name="comment" maxlength="600" rows="3" placeholder="Share useful feedback"></textarea>
            </label>
            <button class="button button-rust">Submit review</button>
          </form>
        ` : ""}
      </div>
      <aside class="offer-side">
        <h2>${canSeeOffers ? `Offers (${relatedOffers.length})` : "Offer"}</h2>
        ${canSeeOffers ? (
          relatedOffers.map((offer) => `
            <article class="offer-card">
              <div class="offer-card-title">
                <strong>${escapeHtml(offer.worker_name)}</strong>
                ${offer.worker_verified ? '<span class="verified-badge">Verified</span>' : ""}
              </div>
              <div class="offer-price">${money(offer.price)}</div>
              <p>${escapeHtml(offer.message)}</p>
              <small>${dateLabel(offer.created_at)}</small>
              <div class="mt-2 flex gap-2">
                ${offer.status === "pending" && job.status === "open" ? `<button class="button button-teal" data-accept-offer="${offer.id}">Accept offer</button>` : `<span class="status-pill status-${offer.status}">${escapeHtml(offer.status)}</span>`}
                <button class="button button-outline text-xs" data-open-chat-peer="${offer.worker_user_id || offer.worker_id}" data-peer-name="${escapeHtml(offer.worker_name)}" data-job-id="${job.id}">Chat</button>
              </div>
            </article>
          `).join("") || '<p class="muted-copy">No offers yet. Providers can make an offer from this page.</p>'
        ) : state.user?.role === "worker" ? `
          <p>Offer a clear price and explain what is included.</p>
          ${job.status === "open" ? `<button class="button button-rust full-width" data-make-offer="${id}">Make an offer</button>` : `<p>This task is not accepting offers.</p>`}
        ` : `<p>Sign in as a provider to make an offer, or sign in as the task customer to review offers.</p>`}
        ${selected && state.user?.role === "customer" ? `
          <div class="accepted-banner">
            <strong>Offer accepted</strong>
            <p>${escapeHtml(selected.worker_name)} is selected. Contact details are available on this page.</p>
          </div>
        ` : ""}
      </aside>
    </article>
  `;
  refreshIcons(root);
}

// ==========================================================================
// 5. PROFILE PAGE & SETTINGS (CHOLOBD WORKSPACE & SETTINGS - SCREENSHOTS 1, 2, 3, 4)
// ==========================================================================

function renderProfile() {
  const root = $("#profile-workspace");
  if (!root) return;

  if (!state.user) {
    $("#profile-auth")?.classList.remove("hidden");
    root.innerHTML = `
      <div class="empty-state">
        <strong>${state.lang === "bn" ? "লগইন করে আপনার প্রোফাইল ও কাজের তথ্য দেখুন।" : "Your workspace is ready when you sign in."}</strong>
        <button class="button button-teal mt-3" data-open-auth>${state.lang === "bn" ? "লগইন অথবা সাইন আপ" : "Log in or sign up"}</button>
      </div>
    `;
    return;
  }

  $("#profile-auth")?.classList.add("hidden");

  // Update Left Sidebar Header Card (Image 3)
  const avatarCircle = $("#profile-avatar-circle");
  if (avatarCircle) {
    if (state.user.avatar_photo) {
      avatarCircle.innerHTML = `
        <img src="${state.user.avatar_photo}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">
        ${state.user.verified ? '<div class="profile-avatar-verified-badge"><i data-lucide="check"></i></div>' : ""}
      `;
    } else {
      const avatarLetter = (state.user.name || "U").slice(0, 1).toUpperCase();
      avatarCircle.innerHTML = `
        <span>${avatarLetter}</span>
        ${state.user.verified ? '<div class="profile-avatar-verified-badge"><i data-lucide="check"></i></div>' : ""}
      `;
    }
  }

  const nameEl = $("#profile-user-name");
  if (nameEl) nameEl.textContent = state.user.name;

  const tagEl = $("#profile-user-tag");
  if (tagEl) {
    const handle = state.user.username ? state.user.username : (state.user.email ? `@${state.user.email.split("@")[0]}` : "");
    const occ = state.user.occupation ? ` · ${state.user.occupation}` : "";
    tagEl.textContent = `${handle}${occ}`;
  }

  const isCustomer = state.user.role === "customer";
  const myJobs = state.jobs.filter((j) => isCustomer ? j.customer_id === state.user.id : state.offers.some((o) => o.job_id === j.id && o.worker_id === state.user.id));
  const myOffers = state.offers.filter((o) => o.worker_id === state.user.id);
  const bidsReceived = state.offers.filter((o) => myJobs.some((j) => j.id === o.job_id));

  const postCountEl = $("#stat-posts-count");
  if (postCountEl) postCountEl.textContent = myJobs.length;

  const bidsCountEl = $("#stat-bids-count");
  if (bidsCountEl) bidsCountEl.textContent = isCustomer ? bidsReceived.length : myOffers.length;

  const savedCountEl = $("#stat-saved-count");
  if (savedCountEl) savedCountEl.textContent = state.savedCount || 0;

  // Verification button / badge
  const verifyBtn = $("#sidebar-verify-btn");
  if (verifyBtn) {
    if (state.user.verified) {
      verifyBtn.textContent = "✓ Verified";
      verifyBtn.className = "button button-teal";
      verifyBtn.disabled = true;
    } else {
      verifyBtn.textContent = state.lang === "bn" ? "🛡️ ভেরিফাই করুন" : "🛡️ Get Verified";
      verifyBtn.className = "button button-rust";
      verifyBtn.disabled = false;
    }
  }

  if (state.user.role === "admin") {
    root.innerHTML = `
      <div class="empty-state">
        <strong>Admin team console is active.</strong>
        <p class="muted-copy">Inspect NID verifications, review support tickets, and manage provider status.</p>
        <button class="button button-teal mt-3" data-go-admin>Open Admin Console</button>
      </div>
    `;
    return;
  }

  // If in Settings view (Matching Screenshots 1, 2, 3, 4)
  if (state.profileView === "settings") {
    renderSettingsView(root, myJobs.length);
  } else {
    renderActivityView(root, isCustomer, myJobs, myOffers, bidsReceived);
  }

  refreshIcons(root);
}

function renderSettingsView(root, jobCount) {
  const dict = I18N[state.lang] || I18N.en;
  root.innerHTML = `
    <div class="settings-container">
      <div class="settings-header-card">
        <div class="flex justify-between items-center">
          <h1 class="settings-title">${dict.settingsTitle || "Settings"}</h1>
          <button class="button button-outline text-xs font-bold" id="toggle-view-activity-btn" type="button">
            <i data-lucide="package"></i> ${state.lang === "bn" ? "আমার অর্ডার ও কাজ" : "My Orders & Work"} (${jobCount})
          </button>
        </div>
        <div class="settings-top-tabs">
          <button type="button" class="settings-tab-btn ${state.settingsTab === "account" ? "active" : ""}" data-settings-tab="account">
            <i data-lucide="user"></i> <span>${dict.tabAccount || "Account"}</span>
          </button>
          <button type="button" class="settings-tab-btn ${state.settingsTab === "profile" ? "active" : ""}" data-settings-tab="profile">
            <i data-lucide="user-check"></i> <span>${dict.tabProfile || "Profile"}</span>
          </button>
          <button type="button" class="settings-tab-btn ${state.settingsTab === "notifications" ? "active" : ""}" data-settings-tab="notifications">
            <i data-lucide="bell"></i> <span>${dict.tabNotifications || "Notifications"}</span>
          </button>
          <button type="button" class="settings-tab-btn ${state.settingsTab === "help" ? "active" : ""}" data-settings-tab="help">
            <i data-lucide="phone-call"></i> <span>${dict.tabBhaiHelp || "BhaiHelp"}</span>
          </button>
        </div>
      </div>

      <div class="settings-card" id="settings-card-body">
        <!-- Tab Content Loaded Below -->
      </div>
    </div>
  `;

  renderActiveSettingsTab();
}

function renderActiveSettingsTab() {
  const card = $("#settings-card-body");
  if (!card || !state.user) return;
  const u = state.user;

  if (state.settingsTab === "account") {
    // Screenshot 1: Account Tab
    card.innerHTML = `
      <form id="settings-account-form" class="flex flex-col gap-4">
        <!-- Language row -->
        <div class="settings-row-between">
          <div>
            <strong>Language</strong>
            <p>Choose the language for ServiNear on this account.</p>
          </div>
          <button type="button" class="lang-toggle-btn" id="settings-lang-toggle">
            <span class="${state.lang === 'bn' ? 'lang-pill-bn font-bold' : 'text-muted'}">বাংলা</span> | 
            <span class="${state.lang === 'en' ? 'lang-pill-en font-bold' : 'text-muted'}">English</span>
          </button>
        </div>

        <!-- Display Name -->
        <label class="settings-field-group">
          <span>Display Name</span>
          <input name="display_name" class="settings-input" required value="${escapeHtml(u.name || "")}">
        </label>

        <!-- Username -->
        <label class="settings-field-group">
          <span>Username</span>
          <div class="input-addon-wrap">
            <span class="input-addon">@</span>
            <input name="username" class="settings-input" placeholder="yourhandle" value="${escapeHtml((u.username || "").replace(/^@/, ""))}">
          </div>
        </label>

        <!-- Email -->
        <label class="settings-field-group">
          <span>Email</span>
          <input name="email" class="settings-input" value="${escapeHtml(u.email)}" disabled>
          <small class="text-xs text-muted">Email cannot be changed</small>
        </label>

        <!-- Security Lock Notice -->
        <div class="settings-lock-box">
          <i data-lucide="lock"></i>
          <span>Password changes are handled via your email provider (Google/Credentials).</span>
        </div>

        <!-- Save Button -->
        <div class="settings-footer-actions">
          <button type="submit" class="settings-save-btn">
            <i data-lucide="save"></i>
            <span>Save Changes</span>
          </button>
        </div>
      </form>
    `;
  } else if (state.settingsTab === "profile") {
    // Screenshots 2 & 3: Profile Tab
    const skillsList = Array.isArray(u.skills) ? u.skills : [];
    card.innerHTML = `
      <form id="settings-profile-form" class="flex flex-col gap-4">
        <!-- Avatar Row -->
        <div class="settings-avatar-row">
          <div class="settings-avatar-circle" id="settings-avatar-preview">
            ${u.avatar_photo ? `<img src="${u.avatar_photo}" alt="Avatar">` : `<span>${escapeHtml((u.name||"U").slice(0,1).toUpperCase())}</span>`}
          </div>
          <div class="settings-avatar-info">
            <strong>${escapeHtml(u.name)}</strong>
            <button type="button" class="change-photo-btn" id="change-photo-trigger-btn">
              <i data-lucide="camera"></i> Change photo
            </button>
          </div>
        </div>

        <!-- Bio -->
        <label class="settings-field-group">
          <span>Bio</span>
          <textarea name="bio" id="settings-bio-textarea" class="settings-textarea" maxlength="300" placeholder="Tell people about yourself...">${escapeHtml(u.bio || "")}</textarea>
          <div class="text-right text-xs text-muted"><span id="bio-char-count">${(u.bio || "").length}</span>/300</div>
        </label>

        <!-- City & Phone (2 columns) -->
        <div class="grid grid-cols-2 gap-3">
          <label class="settings-field-group">
            <span>City</span>
            <input name="city" class="settings-input" value="${escapeHtml(u.city || u.area || "Dhaka")}">
          </label>
          <label class="settings-field-group">
            <span>Phone</span>
            <input name="phone" class="settings-input" placeholder="01XXXXXXXXX" value="${escapeHtml(u.phone || "")}">
          </label>
        </div>

        <!-- Occupation -->
        <label class="settings-field-group">
          <span>Occupation</span>
          <input name="occupation" class="settings-input" placeholder="e.g. Student, Electrician, Designer" value="${escapeHtml(u.occupation || "")}">
        </label>

        <!-- Profession Icon Selection Cards -->
        <div class="settings-field-group">
          <span>Profession Icon</span>
          <div class="profession-icons-grid" id="profession-icons-grid">
            ${PROFESSION_ICONS.map((p) => `
              <div class="profession-icon-card ${(u.profession_icon || "student") === p.id ? "selected" : ""}" data-prof-id="${p.id}">
                <span class="profession-symbol">${p.symbol}</span>
                <span class="profession-label">${p.label}</span>
              </div>
            `).join("")}
          </div>
          <input type="hidden" name="profession_icon" id="selected-profession-icon" value="${escapeHtml(u.profession_icon || "student")}">
        </div>

        <!-- Skills Input & Chips -->
        <div class="settings-field-group">
          <span>Skills</span>
          <div class="skill-input-row">
            <input id="skill-text-input" class="settings-input" placeholder="Add a skill (e.g. AC Repair, Driving, Painting)">
            <button type="button" class="button button-teal" id="add-skill-chip-btn">Add</button>
          </div>
          <div class="skill-chips-wrap" id="skill-chips-container">
            ${skillsList.map((skill, index) => `
              <span class="skill-chip">
                <span>${escapeHtml(skill)}</span>
                <button type="button" data-remove-skill="${index}">×</button>
              </span>
            `).join("")}
          </div>
        </div>

        <!-- Save Button -->
        <div class="settings-footer-actions">
          <button type="submit" class="settings-save-btn">
            <i data-lucide="save"></i>
            <span>Save Changes</span>
          </button>
        </div>
      </form>
    `;
  } else if (state.settingsTab === "notifications") {
    // Screenshot 4: Notifications Tab
    card.innerHTML = `
      <form id="settings-notifications-form" class="flex flex-col gap-2">
        <div class="settings-switch-row">
          <div class="settings-switch-info">
            <strong>Reactions on your posts</strong>
            <p>When someone reacts to your posts</p>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" name="notif_reactions" ${u.notif_reactions !== false && u.notif_reactions !== 0 ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="settings-switch-row">
          <div class="settings-switch-info">
            <strong>Comments</strong>
            <p>When someone comments on your posts</p>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" name="notif_comments" ${u.notif_comments !== false && u.notif_comments !== 0 ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="settings-switch-row">
          <div class="settings-switch-info">
            <strong>Direct messages</strong>
            <p>New messages from other users</p>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" name="notif_messages" ${u.notif_messages !== false && u.notif_messages !== 0 ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="settings-switch-row">
          <div class="settings-switch-info">
            <strong>🔔 Enable all notifications</strong>
            <p>Receive all app notifications</p>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" name="notif_all" ${u.notif_all !== false && u.notif_all !== 0 ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="settings-switch-row">
          <div class="settings-switch-info">
            <strong>Enable update notifications</strong>
            <p>Get notified about platform updates and announcements</p>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" name="notif_updates" ${u.notif_updates !== false && u.notif_updates !== 0 ? "checked" : ""}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <div class="settings-switch-row">
          <div class="settings-switch-info">
            <strong>💼 Hire requests</strong>
            <p>${u.verified ? "Get notified when customers directly request your service" : "Requires verification — submit it from the Get Verified modal."}</p>
          </div>
          <label class="switch-toggle">
            <input type="checkbox" name="notif_hire" ${u.notif_hire ? "checked" : ""} ${u.verified ? "" : "disabled"}>
            <span class="switch-slider"></span>
          </label>
        </div>

        <!-- Save Button -->
        <div class="settings-footer-actions mt-3">
          <button type="submit" class="settings-save-btn">
            <i data-lucide="save"></i>
            <span>Save Changes</span>
          </button>
        </div>
      </form>
    `;
  } else if (state.settingsTab === "help") {
    // BhaiHelp Tab
    card.innerHTML = `
      <div class="flex flex-col gap-4">
        <div class="help-hotline mb-2">
          <i data-lucide="life-buoy"></i>
          <span>
            <strong>BhaiHelp Instant Helpline</strong>
            <small>09612-345678 · Available 9am–9pm daily</small>
          </span>
          <a href="tel:09612345678" class="button button-teal text-xs ml-auto">Call Helpline</a>
        </div>

        <form id="bhaihelp-form" class="form-grid">
          <h3 class="field-span font-bold text-sm">Send a direct message to support</h3>
          <label class="form-field field-span">Subject
            <input name="subject" required placeholder="Account or service inquiry">
          </label>
          <label class="form-field field-span">Message
            <textarea name="message" required rows="4" placeholder="Describe how we can assist you..."></textarea>
          </label>
          <button class="button button-teal field-span">Submit to Support Team</button>
        </form>
      </div>
    `;
  }

  refreshIcons(card);
}

function renderActivityView(root, isCustomer, myJobs, myOffers, bidsReceived) {
  let tabs;
  if (isCustomer) {
    tabs = `
      <button class="profile-tab active" data-profile-tab="posts">My Tasks <span>${myJobs.length}</span></button>
      <button class="profile-tab" data-profile-tab="offers">Bids Received <span>${bidsReceived.length}</span></button>
    `;
  } else {
    tabs = `
      <button class="profile-tab active" data-profile-tab="alerts">Job Alerts</button>
      <button class="profile-tab" data-profile-tab="bids">My Offers <span>${myOffers.length}</span></button>
      <button class="profile-tab" data-profile-tab="history">Job History <span>${myJobs.length}</span></button>
    `;
  }

  root.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <div class="profile-tabs" role="tablist">${tabs}</div>
      <button class="button button-outline text-xs font-bold" id="toggle-view-settings-btn" type="button">
        <i data-lucide="settings"></i> ${state.lang === "bn" ? "প্রোফাইল সেটিংস" : "Profile Settings"}
      </button>
    </div>
    <div class="profile-panel" id="profile-panel"></div>
  `;

  renderProfilePanel(isCustomer ? "posts" : "alerts");
}

function renderProfilePanel(tab) {
  const panel = $("#profile-panel");
  if (!panel || !state.user) return;

  const isCustomer = state.user.role === "customer";
  const myJobs = state.jobs.filter((j) => isCustomer ? j.customer_id === state.user.id : state.offers.some((o) => o.job_id === j.id && o.worker_id === state.user.id));
  const myOffers = state.offers.filter((o) => o.worker_id === state.user.id);
  const bidsReceived = state.offers.filter((o) => myJobs.some((j) => j.id === o.job_id));

  if (tab === "alerts") {
    const matches = state.jobs.filter((j) => j.status === "open" && (!state.alertOnly || j.category === state.user.category));
    panel.innerHTML = `
      <div class="profile-panel-head">
        <div>
          <h2>Open Job Alerts</h2>
          <p>Available tasks ${state.alertOnly ? `matching ${escapeHtml(state.user.category || "your trade")}` : "across all categories"}.</p>
        </div>
        <label class="toggle-control">
          <input id="alert-toggle" type="checkbox" ${state.alertOnly ? "checked" : ""}>
          <span class="toggle-track"></span>
          <span>My trade only</span>
        </label>
      </div>
      <div class="task-list">
        ${matches.slice(0, 30).map((job) => jobCard(job)).join("") || '<p class="muted-copy">No matching open tasks right now.</p>'}
      </div>
    `;
  } else if (tab === "posts" || tab === "history") {
    panel.innerHTML = `
      <div class="profile-panel-head">
        <div>
          <h2>${tab === "posts" ? "My Posted Tasks" : "Task History"}</h2>
          <p>${myJobs.length} task${myJobs.length === 1 ? "" : "s"} in your record.</p>
        </div>
        ${isCustomer ? '<button class="button button-rust" data-open-job>+ Post New Task</button>' : ""}
      </div>
      <div class="task-list">
        ${myJobs.map((job) => jobCard(job)).join("") || '<p class="muted-copy">No tasks recorded yet.</p>'}
      </div>
    `;
  } else if (tab === "offers" || tab === "bids") {
    const bidsList = isCustomer ? bidsReceived : myOffers;
    panel.innerHTML = `
      <div class="profile-panel-head">
        <div>
          <h2>${isCustomer ? "Bids Received on Your Tasks" : "My Submitted Offers"}</h2>
          <p>${bidsList.length} offer${bidsList.length === 1 ? "" : "s"}.</p>
        </div>
      </div>
      <div class="offer-list">
        ${bidsList.map((offer) => {
          const job = state.jobs.find((j) => j.id === offer.job_id);
          return `
            <article class="offer-card">
              <div class="offer-card-title">
                <strong>${escapeHtml(isCustomer ? offer.worker_name : job?.title || "Task")}</strong>
                <span class="status-pill status-${offer.status}">${escapeHtml(offer.status)}</span>
              </div>
              <div class="offer-price">${money(offer.price)}</div>
              <p>${escapeHtml(offer.message)}</p>
              <div class="flex justify-between items-center mt-2">
                <a class="text-link text-xs font-bold" href="/tasks/${offer.job_id}" data-route>View task</a>
                ${isCustomer && offer.status === "pending" ? `<button class="button button-teal text-xs" data-accept-offer="${offer.id}">Accept Offer</button>` : ""}
              </div>
            </article>
          `;
        }).join("") || '<p class="muted-copy">No offers at this time.</p>'}
      </div>
    `;
  }
  refreshIcons(panel);
}

// ==========================================================================
// 6. SAVED POSTS & BOOKMARKS
// ==========================================================================

async function toggleBookmark(itemType, itemId, btnNode) {
  if (!state.user) {
    openAuth("login");
    return;
  }
  try {
    const res = await post("/api/saved-posts/toggle", { item_type: itemType, item_id: Number(itemId) });
    const isSaved = res.status === "saved";
    if (btnNode) {
      btnNode.classList.toggle("saved", isSaved);
    }
    state.savedCount = res.savedCount;
    const statEl = $("#stat-saved-count");
    if (statEl) statEl.textContent = state.savedCount;
    toast(isSaved ? "Saved to your bookmarks." : "Removed from bookmarks.");
    if (state.page === "saved") renderSavedPage();
  } catch (error) {
    toast(error.message);
  }
}

async function renderSavedPage() {
  if (!state.user) {
    navigate("/profile");
    return;
  }
  try {
    const data = await api("/api/saved-posts");
    state.savedPosts = data;

    const tasksTab = $("#tab-saved-tasks");
    const workersTab = $("#tab-saved-workers");
    if (tasksTab) tasksTab.classList.toggle("active", state.savedTab === "tasks");
    if (workersTab) workersTab.classList.toggle("active", state.savedTab === "workers");

    const container = $("#saved-content-container");
    if (!container) return;

    if (state.savedTab === "tasks") {
      const tasks = data.tasks || [];
      if (tasks.length === 0) {
        container.innerHTML = `<div class="empty-state"><strong>No saved tasks</strong><span>Browse open tasks and click the bookmark icon to save them here.</span></div>`;
      } else {
        container.innerHTML = `<div class="task-grid">${tasks.map((job) => jobCard(job)).join("")}</div>`;
      }
    } else {
      const workers = data.workers || [];
      if (workers.length === 0) {
        container.innerHTML = `<div class="empty-state"><strong>No saved service providers</strong><span>Search local providers and bookmark trusted specialists here.</span></div>`;
      } else {
        container.innerHTML = `<div class="provider-grid">${workers.map((w) => `
          <article class="provider-card">
            <div class="provider-avatar">${escapeHtml(w.name.slice(0, 1))}</div>
            <div class="provider-main">
              <div class="provider-name-row">
                <h3>${escapeHtml(w.name)}</h3>
                ${w.verified ? '<span class="verified-badge"><i data-lucide="badge-check"></i> Verified</span>' : ""}
                <button class="bookmark-btn saved" data-bookmark-type="worker" data-bookmark-id="${w.id}">
                  <i data-lucide="bookmark"></i>
                </button>
              </div>
              <p class="provider-category">${escapeHtml(w.category)} <span>·</span> ${escapeHtml(w.area)}</p>
              <div class="provider-price mt-2">
                <small>Starting from</small>
                <strong>${money(w.rate)}</strong>
              </div>
              <button class="button button-outline full-width mt-3 text-xs" data-open-chat-peer="${w.user_id || w.id}" data-peer-name="${escapeHtml(w.name)}">Message</button>
            </div>
          </article>
        `).join("")}</div>`;
      }
    }
    refreshIcons(container);
  } catch (error) {
    toast(error.message);
  }
}

// ==========================================================================
// 7. INBOX CHAT SYSTEM (IMAGE 5 REPLICA)
// ==========================================================================

async function loadInbox(selectPeerId = null, selectJobId = null) {
  if (!state.user) {
    openAuth("login");
    return;
  }
  try {
    const messages = await api("/api/messages");
    // Group messages into conversations by peer user
    const threadsMap = new Map();

    messages.forEach((m) => {
      const peerId = m.sender_id === state.user.id ? m.receiver_id : m.sender_id;
      const peerName = m.sender_id === state.user.id ? m.receiver_name : m.sender_name;
      const peerRole = m.sender_id === state.user.id ? m.receiver_role : m.sender_role;

      if (!threadsMap.has(peerId)) {
        threadsMap.set(peerId, {
          peerId,
          peerName,
          peerRole,
          lastMessage: m.message,
          lastTime: m.created_at,
          unread: !m.read && m.receiver_id === state.user.id,
          jobId: m.job_id,
          messages: []
        });
      }
      threadsMap.get(peerId).messages.push(m);
    });

    state.inbox.threads = Array.from(threadsMap.values()).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));

    if (selectPeerId) {
      state.inbox.activePeerId = Number(selectPeerId);
      if (selectJobId) state.inbox.activeJobId = Number(selectJobId);
    } else if (!state.inbox.activePeerId && state.inbox.threads.length > 0) {
      state.inbox.activePeerId = state.inbox.threads[0].peerId;
    }

    renderInboxView();
  } catch (error) {
    console.error("Inbox load error:", error);
  }
}

function renderInboxView() {
  const threadsListEl = $("#inbox-threads-list");
  if (!threadsListEl) return;

  const q = state.inbox.search.toLowerCase();
  const filter = state.inbox.filter;

  const filtered = state.inbox.threads.filter((t) => {
    if (q && !t.peerName.toLowerCase().includes(q) && !t.lastMessage.toLowerCase().includes(q)) return false;
    if (filter === "orders" && !t.jobId) return false;
    return true;
  });

  threadsListEl.innerHTML = filtered.map((t) => `
    <div class="inbox-thread-item ${t.peerId === state.inbox.activePeerId ? "active" : ""}" data-thread-peer="${t.peerId}" data-thread-name="${escapeHtml(t.peerName)}">
      <div class="thread-avatar">${escapeHtml(t.peerName.slice(0, 1))}</div>
      <div class="thread-info">
        <h4 class="thread-name">${escapeHtml(t.peerName)}</h4>
        <p class="thread-snippet">${escapeHtml(t.lastMessage)}</p>
      </div>
      <div class="thread-meta">
        <span class="thread-time">${timeAgo(t.lastTime)}</span>
        ${t.unread ? '<div class="thread-unread-dot"></div>' : ""}
      </div>
    </div>
  `).join("") || `<div class="p-4 text-center text-xs text-muted">No conversations found.</div>`;

  // Render active conversation pane
  const activeThread = state.inbox.threads.find((t) => t.peerId === state.inbox.activePeerId);
  const emptyState = $("#chat-empty-state");
  const activePane = $("#chat-active-pane");

  if (!activeThread) {
    if (emptyState) emptyState.classList.remove("hidden");
    if (activePane) activePane.classList.add("hidden");
    return;
  }

  if (emptyState) emptyState.classList.add("hidden");
  if (activePane) activePane.classList.remove("hidden");

  const avatarEl = $("#chat-active-avatar");
  if (avatarEl) avatarEl.textContent = activeThread.peerName.slice(0, 1);

  const nameEl = $("#chat-active-name");
  if (nameEl) nameEl.textContent = activeThread.peerName;

  const msgsContainer = $("#chat-messages-container");
  if (msgsContainer) {
    msgsContainer.innerHTML = activeThread.messages.map((m) => {
      const isOutgoing = m.sender_id === state.user.id;
      return `
        <div class="message-bubble ${isOutgoing ? "outgoing" : "incoming"}">
          <p>${escapeHtml(m.message)}</p>
          <span class="message-time">${timeAgo(m.created_at)}</span>
        </div>
      `;
    }).join("");
    msgsContainer.scrollTop = msgsContainer.scrollHeight;
  }
}

async function sendChatMessage(text) {
  if (!text || !state.inbox.activePeerId) return;
  try {
    await post("/api/messages", {
      receiver_id: state.inbox.activePeerId,
      message: text,
      job_id: state.inbox.activeJobId || null
    });
    $("#chat-message-input").value = "";
    await loadInbox(state.inbox.activePeerId);
  } catch (error) {
    toast(error.message);
  }
}

// ==========================================================================
// 8. NOTIFICATIONS DRAWER
// ==========================================================================

async function loadNotifications() {
  if (!state.user) return;
  try {
    const notifs = await api("/api/notifications");
    state.notifications = notifs;
    state.unreadNotifications = notifs.filter((n) => !n.read).length;
    updateBadges();

    const listEl = $("#notif-list");
    if (!listEl) return;

    if (notifs.length === 0) {
      listEl.innerHTML = `<div class="notif-empty">${state.lang === "bn" ? "নতুন কোনো নোটিফিকেশন নেই।" : "No new notifications."}</div>`;
      return;
    }

    listEl.innerHTML = notifs.map((n) => `
      <div class="notif-item ${n.read ? "" : "unread"}" data-notif-id="${n.id}" data-notif-link="${escapeHtml(n.link || "")}">
        <span class="notif-item-title">${escapeHtml(n.title)}</span>
        <span class="notif-item-body">${escapeHtml(n.body)}</span>
        <span class="notif-item-time">${timeAgo(n.created_at)}</span>
      </div>
    `).join("");
  } catch (error) {
    console.error("Notifications fetch error:", error);
  }
}

async function markNotificationRead(id, link) {
  try {
    await post(`/api/notifications/${id}/read`, {}, "PATCH");
    await loadNotifications();
    if (link) navigate(link);
  } catch (error) {
    console.error(error);
  }
}

async function markAllNotificationsRead() {
  try {
    await post("/api/notifications/read-all", {});
    await loadNotifications();
    toast(state.lang === "bn" ? "সব নোটিফিকেশন পড়া হিসেবে চিহ্নিত হয়েছে।" : "All notifications marked as read.");
  } catch (error) {
    toast(error.message);
  }
}

// ==========================================================================
// 9. NID VERIFICATION FLOW (IMAGE 2 REPLICA)
// ==========================================================================

function openNidDialog() {
  if (!state.user) return openAuth("login");
  const dialog = $("#nid-dialog");
  if (!dialog) return;

  state.nidUploads = { front: null, back: null, selfie: null };
  updateNidProgress();

  $("#thumb-front")?.classList.add("hidden");
  $("#thumb-back")?.classList.add("hidden");
  $("#thumb-selfie")?.classList.add("hidden");
  $("#nid-message").textContent = "";

  dialog.showModal();
  refreshIcons(dialog);
}

function updateNidProgress() {
  const count = [state.nidUploads.front, state.nidUploads.back, state.nidUploads.selfie].filter(Boolean).length;
  const countEl = $("#nid-photo-count");
  if (countEl) countEl.textContent = `${count} of 3 photos added`;

  $("#dash-1")?.classList.toggle("filled", count >= 1);
  $("#dash-2")?.classList.toggle("filled", count >= 2);
  $("#dash-3")?.classList.toggle("filled", count >= 3);

  const submitBtn = $("#nid-submit-btn");
  if (submitBtn) submitBtn.disabled = count < 3;
}

function compressImageFile(file, maxWidth = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleNidFileSelect(file, slot) {
  if (!file) return;
  try {
    toast("Compressing photo...");
    const base64 = await compressImageFile(file);
    state.nidUploads[slot] = base64;

    const thumb = $(`#thumb-${slot}`);
    if (thumb) {
      thumb.innerHTML = `<img src="${base64}" alt="${slot}">`;
      thumb.classList.remove("hidden");
    }
    const card = $(`#slot-${slot}`);
    if (card) card.classList.add("has-photo");

    updateNidProgress();
    toast(`Photo ${slot} added!`);
  } catch (error) {
    toast(`Failed to process photo: ${error.message}`);
  }
}

async function submitNidApplication() {
  const submitBtn = $("#nid-submit-btn");
  if (submitBtn) submitBtn.disabled = true;
  showSuccess($("#nid-message"), "Submitting your documents securely...");

  try {
    await post("/api/nid/apply", {
      front_photo: state.nidUploads.front,
      back_photo: state.nidUploads.back,
      selfie_photo: state.nidUploads.selfie
    });
    $("#nid-dialog")?.close();
    await reload();
    toast("NID verification submitted successfully! Admin will review within 24 hours.");
  } catch (error) {
    showError($("#nid-message"), error.message);
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ==========================================================================
// 10. ADMIN NID INSPECTION MODAL
// ==========================================================================

async function renderAdmin() {
  if (!state.user || state.user.role !== "admin") {
    $("#admin-stats").innerHTML = '<div class="empty-state">Sign in with an admin account to open platform operations.</div>';
    $("#admin-list").innerHTML = "";
    $("#admin-tickets").innerHTML = "";
    return;
  }

  try {
    const [stats, tickets, nidApps] = await Promise.all([
      api("/api/admin/summary"),
      api("/api/admin/support"),
      api("/api/admin/nid-applications")
    ]);

    $("#admin-stats").innerHTML = Object.entries({
      Accounts: stats.users,
      Providers: stats.providers,
      Customers: stats.customers,
      "Open tasks": stats.openJobs,
      "Awaiting verification": stats.pending,
      "Open requests": stats.tickets
    }).map(([label, count]) => `
      <div class="admin-stat">
        <strong>${Number(count).toLocaleString()}</strong>
        <span>${label}</span>
      </div>
    `).join("");

    // Render NID Applications
    const nidContainer = $("#admin-nid-container");
    if (nidContainer) {
      if (nidApps.length === 0) {
        nidContainer.innerHTML = '<p class="muted-copy">No pending NID verification applications.</p>';
      } else {
        nidContainer.innerHTML = nidApps.map((app) => `
          <article class="admin-row">
            <div>
              <strong>${escapeHtml(app.user_name)}</strong>
              <small>${escapeHtml(app.user_email)} · ${escapeHtml(app.user_phone || "No phone")} · Status: <b>${escapeHtml(app.status)}</b></small>
            </div>
            <button class="button button-teal text-xs" data-inspect-nid="${app.id}" data-app='${escapeHtml(JSON.stringify(app))}'>Inspect Photos &amp; Review</button>
          </article>
        `).join("");
      }
    }

    $("#admin-list").innerHTML = state.workers.filter((w) => !w.verified).slice(0, 50).map((w) => `
      <article class="admin-row">
        <div>
          <strong>${escapeHtml(w.name)}</strong>
          <small>${escapeHtml(w.category)} · ${escapeHtml(w.area)}</small>
        </div>
        <button class="button button-outline" data-verify="${w.id}">Direct Verify</button>
      </article>
    `).join("") || '<p class="muted-copy">No providers waiting for verification.</p>';

    $("#admin-tickets").innerHTML = tickets.map((ticket) => `
      <article class="admin-row ticket-row">
        <div>
          <strong>${escapeHtml(ticket.subject)}</strong>
          <small>${escapeHtml(ticket.name)} · ${escapeHtml(ticket.email)}</small>
          <p>${escapeHtml(ticket.message)}</p>
        </div>
        <select data-ticket-status="${ticket.id}">
          <option ${ticket.status === "open" ? "selected" : ""}>open</option>
          <option ${ticket.status === "reviewing" ? "selected" : ""}>reviewing</option>
          <option ${ticket.status === "resolved" ? "selected" : ""}>resolved</option>
        </select>
      </article>
    `).join("") || '<p class="muted-copy">No support requests.</p>';

  } catch (error) {
    showError($("#admin-stats"), error.message);
  }
}

function openNidInspectModal(app) {
  state.adminInspectTarget = app;
  $("#inspect-applicant-name").textContent = `Review: ${app.user_name}`;
  $("#inspect-applicant-details").textContent = `Email: ${app.user_email} | Phone: ${app.user_phone || "N/A"} | Submitted: ${dateLabel(app.created_at)}`;

  $("#inspect-img-front").src = app.front_photo || "";
  $("#inspect-img-back").src = app.back_photo || "";
  $("#inspect-img-selfie").src = app.selfie_photo || "";

  $("#admin-nid-inspect-dialog")?.showModal();
}

async function handleAdminNidDecision(action) {
  if (!state.adminInspectTarget) return;
  const appId = state.adminInspectTarget.id;
  const notes = $("#admin-inspect-notes")?.value || "";

  try {
    await post(`/api/admin/nid-applications/${appId}`, { action, notes }, "PATCH");
    $("#admin-nid-inspect-dialog")?.close();
    await reload();
    if (state.page === "admin") renderAdmin();
    toast(`NID application ${action === "approve" ? "approved" : "rejected"}.`);
  } catch (error) {
    toast(error.message);
  }
}

// ==========================================================================
// 11. AUTHENTICATION & DIALOGS (SPLIT CARD & FORGOT PASSWORD)
// ==========================================================================

function openAuth(mode = "login") {
  state.authMode = mode;
  updateAuthMode();
  $("#register-message").textContent = "";
  $("#login-message").textContent = "";
  $("#auth-dialog")?.showModal();
  refreshIcons($("#auth-dialog"));
}

function updateAuthMode() {
  const isRegister = state.authMode === "register";
  $("#tab-register-btn")?.classList.toggle("active", isRegister);
  $("#tab-login-btn")?.classList.toggle("active", !isRegister);
  $("#register-form")?.classList.toggle("hidden", !isRegister);
  $("#login-form")?.classList.toggle("hidden", isRegister);
}

async function simulateGoogleAuth() {
  const email = prompt("Enter your Google Account email for one-click sign in:", "user@gmail.com");
  if (!email) return;
  try {
    const res = await post("/api/auth/google", {
      email,
      name: email.split("@")[0].replace(/[._]/g, " "),
      google_id: `g_${Date.now()}`
    });
    state.user = res.user;
    $("#auth-dialog")?.close();
    await reload();
    toast(`Signed in with Google as ${state.user.name}!`);
  } catch (error) {
    toast(error.message);
  }
}

function openJobDialog() {
  if (!state.user) return openAuth("login");
  if (state.user.role !== "customer") return toast("Only customer accounts can post tasks.");

  const form = $("#job-form");
  form.reset();
  form.elements.area.value = state.user.area || "";
  form.elements.contact_phone.value = state.user.phone || "";
  form.elements.exact_address.value = state.user.address || "";
  $("#job-message").textContent = "";
  $("#job-dialog")?.showModal();
}

function openOfferDialog(jobId) {
  if (!state.user) return openAuth("login");
  if (state.user.role !== "worker") return toast("Sign in as a service provider to make an offer.");

  const job = state.jobs.find((item) => item.id === Number(jobId));
  if (!job) return;

  $("#offer-form").dataset.jobId = job.id;
  $("#offer-form").reset();
  $("#offer-job-title").textContent = job.title;
  $("#offer-job-details").textContent = `${job.category} · ${job.area} · customer budget ${money(job.budget)}`;
  $("#offer-message").textContent = "";
  $("#offer-dialog")?.showModal();
}

function renderPage() {
  setActivePage();
  if (state.page === "categories") renderCategories();
  if (state.page === "jobs") renderTasks();
  if (state.page === "task-detail") renderTaskDetail(state.selectedJob);
  if (state.page === "hot") renderHotTasks();
  if (state.page === "profile") renderProfile();
  if (state.page === "admin") renderAdmin();
  if (state.page === "inbox") loadInbox();
  if (state.page === "saved") renderSavedPage();
  refreshIcons();
}

// ==========================================================================
// 12. EVENT LISTENERS
// ==========================================================================

function bindEvents() {
  document.addEventListener("click", async (event) => {
    // Client-side routing
    const route = event.target.closest("a[data-route]");
    if (route) {
      event.preventDefault();
      navigate(route.getAttribute("href"));
      return;
    }

    // Language Toggle
    if (event.target.closest("#lang-toggle")) {
      const nextLang = state.lang === "bn" ? "en" : "bn";
      setLanguage(nextLang);
      return;
    }

    // Notification Drawer Toggle
    const notifBtn = event.target.closest("#notif-toggle-btn");
    if (notifBtn) {
      const drawer = $("#notif-drawer");
      drawer?.classList.toggle("hidden");
      if (!drawer?.classList.contains("hidden")) loadNotifications();
      return;
    }

    // Close notification drawer if clicked outside
    if (!event.target.closest(".notif-btn") && !event.target.closest("#notif-drawer")) {
      $("#notif-drawer")?.classList.add("hidden");
    }

    // Mark single notification read
    const notifItem = event.target.closest(".notif-item");
    if (notifItem) {
      const id = notifItem.dataset.notifId;
      const link = notifItem.dataset.notifLink;
      markNotificationRead(id, link);
      $("#notif-drawer")?.classList.add("hidden");
      return;
    }

    // Mark all notifications read
    if (event.target.closest("#mark-notifs-read")) {
      markAllNotificationsRead();
      return;
    }

    // Auth Modals
    if (event.target.closest("[data-open-auth]")) return openAuth();
    if (event.target.closest("[data-close-dialog]")) return event.target.closest("dialog")?.close();

    // Split Auth tab switch
    const authTab = event.target.closest(".auth-tab-btn");
    if (authTab) {
      state.authMode = authTab.dataset.authMode;
      updateAuthMode();
      return;
    }

    // Password visibility toggle
    const eyeToggle = event.target.closest(".eye-toggle");
    if (eyeToggle) {
      const targetId = eyeToggle.dataset.toggleTarget;
      const input = $(`#${targetId}`);
      if (input) {
        input.type = input.type === "password" ? "text" : "password";
      }
      return;
    }

    // Google Auth buttons
    if (event.target.closest("#google-signup-btn") || event.target.closest("#google-login-btn")) {
      return simulateGoogleAuth();
    }

    // Forgot Password link
    if (event.target.closest("#forgot-password-link")) {
      $("#auth-dialog")?.close();
      $("#forgot-dialog")?.showModal();
      return;
    }

    // Demo Logins
    const demo = event.target.closest("[data-demo]");
    if (demo) {
      const account = {
        customer: "customer@servinear.local",
        worker: "worker@servinear.local",
        admin: "admin@servinear.local"
      }[demo.dataset.demo];
      $("#login-form [name=email]").value = account;
      $("#login-form [name=password]").value = "ServiNear123!";
      return;
    }

    // Bookmarks / Saved Posts
    const bookmarkBtn = event.target.closest("[data-bookmark-type]");
    if (bookmarkBtn) {
      const type = bookmarkBtn.dataset.bookmarkType;
      const id = bookmarkBtn.dataset.bookmarkId;
      return toggleBookmark(type, id, bookmarkBtn);
    }

    // Saved page tabs
    if (event.target.closest("#tab-saved-tasks")) {
      state.savedTab = "tasks";
      return renderSavedPage();
    }
    if (event.target.closest("#tab-saved-workers")) {
      state.savedTab = "workers";
      return renderSavedPage();
    }

    // NID Upload Dialog
    if (event.target.closest("#sidebar-verify-btn") || event.target.closest("[data-open-verify]")) {
      return openNidDialog();
    }

    // Trigger file input for NID photo
    const triggerFileBtn = event.target.closest("[data-trigger-file]");
    if (triggerFileBtn) {
      const fileInputId = triggerFileBtn.dataset.triggerFile;
      $(`#${fileInputId}`)?.click();
      return;
    }

    // Admin Inspect NID
    const inspectBtn = event.target.closest("[data-inspect-nid]");
    if (inspectBtn) {
      try {
        const app = JSON.parse(inspectBtn.dataset.app);
        return openNidInspectModal(app);
      } catch (e) {
        console.error(e);
      }
    }
    if (event.target.closest("#admin-approve-nid-btn")) return handleAdminNidDecision("approve");
    if (event.target.closest("#admin-reject-nid-btn")) return handleAdminNidDecision("reject");

    // Chat with peer button
    const openChatBtn = event.target.closest("[data-open-chat-peer]");
    if (openChatBtn) {
      const peerId = openChatBtn.dataset.openChatPeer;
      const jobId = openChatBtn.dataset.jobId;
      navigate("/inbox");
      loadInbox(peerId, jobId);
      return;
    }

    // Inbox thread selection
    const threadItem = event.target.closest(".inbox-thread-item");
    if (threadItem) {
      const peerId = Number(threadItem.dataset.threadPeer);
      state.inbox.activePeerId = peerId;
      renderInboxView();
      return;
    }

    // Inbox filter pills
    const filterPill = event.target.closest(".inbox-filter-pill");
    if (filterPill) {
      $$(".inbox-filter-pill").forEach((p) => p.classList.remove("active"));
      filterPill.classList.add("active");
      state.inbox.filter = filterPill.dataset.filter;
      renderInboxView();
      return;
    }

    // Task actions
    if (event.target.closest("[data-open-job]")) {
      event.preventDefault();
      return openJobDialog();
    }
    const category = event.target.closest("[data-category]");
    if (category) {
      $("#service-search").value = category.dataset.category;
      state.page = "discover";
      history.pushState({}, "", "/");
      setActivePage();
      renderProviders();
      window.scrollTo(0, 0);
      return;
    }
    if (event.target.closest("[data-view-jobs]")) return navigate("/jobs");
    if (event.target.closest("[data-go-admin]")) return navigate("/admin");

    const task = event.target.closest("[data-task-id]");
    if (task) {
      if (state.page !== "jobs") return navigate(`/tasks/${task.dataset.taskId}`);
      state.selectedJob = Number(task.dataset.taskId);
      renderTasks();
      renderTaskPreview(state.jobs.find((job) => job.id === state.selectedJob));
      return;
    }

    const goTask = event.target.closest("[data-go-task]");
    if (goTask) return navigate(`/tasks/${goTask.dataset.goTask}`);

    const makeOffer = event.target.closest("[data-make-offer]");
    if (makeOffer) return openOfferDialog(makeOffer.dataset.makeOffer);

    const accept = event.target.closest("[data-accept-offer]");
    if (accept) {
      try {
        await post(`/api/offers/${accept.dataset.acceptOffer}/accept`, {});
        await reload();
        toast("Offer accepted. Contact details are now shared with the selected provider.");
      } catch (error) {
        toast(error.message);
      }
      return;
    }

    const complete = event.target.closest("[data-complete-task]");
    if (complete) {
      try {
        await post(`/api/jobs/${complete.dataset.completeTask}/complete`, {});
        await reload();
        if (state.page === "task-detail") renderTaskDetail(state.selectedJob);
        toast("Task marked complete. The customer can now leave a review.");
      } catch (error) {
        toast(error.message);
      }
      return;
    }

    const verify = event.target.closest("[data-verify]");
    if (verify) {
      try {
        await post(`/api/admin/workers/${verify.dataset.verify}/verify`, { verified: true }, "PATCH");
        await reload();
        toast("Provider verified.");
      } catch (error) {
        toast(error.message);
      }
      return;
    }

    const toggle = event.target.closest(".dropdown-toggle");
    if (toggle) {
      const menu = toggle.nextElementSibling;
      menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", menu.classList.contains("open"));
    }
  });

  window.addEventListener("popstate", () => {
    state.page = routeFromPath();
    renderPage();
  });

  // Role select on Registration form
  $("#reg-role-select")?.addEventListener("change", (e) => {
    const isWorker = e.target.value === "worker";
    $("#worker-cat-wrap")?.classList.toggle("hidden", !isWorker);
  });

  // NID File Inputs change
  ["front", "back", "selfie"].forEach((slot) => {
    $(`#nid-file-${slot}`)?.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handleNidFileSelect(file, slot);
    });
  });

  // NID Form Submit
  $("#nid-upload-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitNidApplication();
  });

  // Chat send form
  $("#chat-send-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#chat-message-input");
    sendChatMessage(input.value.trim());
  });

  // Inbox search
  $("#inbox-search-input")?.addEventListener("input", (e) => {
    state.inbox.search = e.target.value;
    renderInboxView();
  });

  // Auth button in header
  $("#auth-button")?.addEventListener("click", async () => {
    if (!state.user) return openAuth();
    try {
      await post("/api/auth/logout", {});
      state.user = null;
      await reload();
      toast("You are logged out.");
    } catch (error) {
      toast(error.message);
    }
  });

  // Registration Form
  $("#register-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.password !== values.confirm_password) {
      return showError($("#register-message"), "Passwords do not match.");
    }
    values.name = `${values.first_name} ${values.surname}`.trim();

    try {
      const result = await post("/api/auth/register", values);
      state.user = result.user;
      $("#auth-dialog")?.close();
      await reload();
      toast(`Welcome, ${state.user.name}! Account created.`);
    } catch (error) {
      showError($("#register-message"), error.message);
    }
  });

  // Login Form
  $("#login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await post("/api/auth/login", values);
      state.user = result.user;
      $("#auth-dialog")?.close();
      await reload();
      toast(`Welcome back, ${state.user.name.split(" ")[0]}!`);
    } catch (error) {
      showError($("#login-message"), error.message);
    }
  });

  // Forgot password form Step 1
  $("#forgot-step1-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#forgot-email").value.trim();
    try {
      const res = await post("/api/auth/forgot-password", { email });
      $("#forgot-preview-code").textContent = res.resetToken || "123456";
      $("#forgot-step1-form").classList.add("hidden");
      $("#forgot-step2-form").classList.remove("hidden");
      toast("Reset code generated!");
    } catch (error) {
      showError($("#forgot-message"), error.message);
    }
  });

  // Forgot password form Step 2
  $("#forgot-step2-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("#forgot-code").value.trim();
    const newPassword = $("#forgot-new-pass").value;
    try {
      await post("/api/auth/reset-password", { token: code, new_password: newPassword });
      $("#forgot-dialog")?.close();
      toast("Password updated successfully! Please log in.");
      openAuth("login");
    } catch (error) {
      showError($("#forgot-message"), error.message);
    }
  });

  // Job Posting Form
  $("#job-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (values.shareLocation === "on" && !state.position) {
      return showError($("#job-message"), "Choose Near me first to attach GPS coordinates.");
    }
    if (state.position && values.shareLocation === "on") {
      values.latitude = state.position.latitude;
      values.longitude = state.position.longitude;
    }
    delete values.shareLocation;

    try {
      await post("/api/jobs", values);
      $("#job-dialog")?.close();
      await reload();
      navigate("/profile");
      toast("Your task is live. Providers can now make offers.");
    } catch (error) {
      showError($("#job-message"), error.message);
    }
  });

  // Offer Form
  $("#offer-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      await post(`/api/jobs/${form.dataset.jobId}/offers`, values);
      $("#offer-dialog")?.close();
      await reload();
      if (state.page === "task-detail") renderTaskDetail(state.selectedJob);
      toast("Your offer has been sent.");
    } catch (error) {
      showError($("#offer-message"), error.message);
    }
  });

  // Support Form
  $("#support-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await post("/api/support", Object.fromEntries(new FormData(form)));
      form.reset();
      if (state.user) {
        form.elements.name.value = state.user.name;
        form.elements.email.value = state.user.email;
      }
      showSuccess($("#support-message"), "Your request is saved for our team.");
    } catch (error) {
      showError($("#support-message"), error.message);
    }
  });

  // Search & Filter listeners
  $("#provider-search")?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.providerLimit = 24;
    renderProviders();
  });
  ["#service-search", "#area-search", "#verified-filter", "#sort-filter"].forEach((sel) => {
    $(sel)?.addEventListener("input", () => {
      state.providerLimit = 24;
      renderProviders();
    });
  });
  ["#task-search", "#task-category-filter", "#task-sort"].forEach((sel) => {
    $(sel)?.addEventListener("input", () => {
      state.taskLimit = 20;
      renderTasks();
    });
  });

  $("#provider-more")?.addEventListener("click", () => {
    state.providerLimit += 24;
    renderProviders();
  });
  $("#task-more")?.addEventListener("click", () => {
    state.taskLimit += 20;
    renderTasks();
  });

  // Geolocation
  $("#locate-button")?.addEventListener("click", () => {
    if (!navigator.geolocation) return toast("GPS is not available in this browser.");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.position = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        $("#area-search").value = "";
        $("#sort-filter").value = "distance";
        renderProviders();
        state.map?.setView([state.position.latitude, state.position.longitude], 12);
        toast("Nearby results are sorted by distance.");
      },
      () => toast("Location permission was not granted."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  $("#map-recenter")?.addEventListener("click", () => {
    state.map?.setView(
      state.position ? [state.position.latitude, state.position.longitude] : [23.78, 90.39],
      state.position ? 12 : 10
    );
  });

  // Profile workspace clicks & form submits
  $("#profile-workspace")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-profile-tab]");
    if (tab) {
      $$(".profile-tab").forEach((el) => el.classList.toggle("active", el === tab));
      return renderProfilePanel(tab.dataset.profileTab);
    }
  });

  $("#profile-workspace")?.addEventListener("change", async (event) => {
    if (event.target.id === "alert-toggle") {
      state.alertOnly = event.target.checked;
      try { window.localStorage.setItem("servinear-alerts", state.alertOnly ? "on" : "off"); } catch {}
      return renderProfilePanel("alerts");
    }
  });

  $("#profile-workspace")?.addEventListener("submit", async (event) => {
    if (event.target.id !== "profile-form") return;
    event.preventDefault();
    try {
      const result = await post("/api/profile", Object.fromEntries(new FormData(event.target)), "PATCH");
      state.user = result.user;
      await reload();
      toast("Profile updated successfully.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("#admin-tickets")?.addEventListener("change", async (event) => {
    if (!event.target.matches("[data-ticket-status]")) return;
    try {
      await post(`/api/admin/support/${event.target.dataset.ticketStatus}`, { status: event.target.value }, "PATCH");
      toast("Support status updated.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("#task-detail-root")?.addEventListener("submit", async (event) => {
    const form = event.target.closest("[data-review-task]");
    if (!form) return;
    event.preventDefault();
    try {
      await post(`/api/jobs/${form.dataset.reviewTask}/review`, Object.fromEntries(new FormData(form)));
      await reload();
      renderTaskDetail(state.selectedJob);
      toast("Thanks. Your review has been saved.");
    } catch (error) {
      toast(error.message);
    }
  });

  $("#menu-button")?.addEventListener("click", () => $("#main-nav")?.classList.toggle("open"));
}

// ==========================================================================
// 13. INITIALIZATION
// ==========================================================================

async function init() {
  try {
    bindEvents();
    Object.assign(state, await api("/api/bootstrap"));
    setLanguage(state.lang);
    if (state.user && $("#support-form")) {
      $("#support-form").elements.name.value = state.user.name;
      $("#support-form").elements.email.value = state.user.email;
    }
    renderAll();

    // Heartbeat for notifications & messages
    setInterval(async () => {
      if (state.user) {
        try {
          const bs = await api("/api/bootstrap");
          state.unreadNotifications = bs.unreadNotifications;
          state.unreadMessages = bs.unreadMessages;
          updateBadges();
          if (state.page === "inbox") loadInbox();
        } catch {}
      }
    }, 10000);

  } catch (error) {
    console.error(error);
    toast(`App could not start: ${error.message}`);
  }
}

init();
