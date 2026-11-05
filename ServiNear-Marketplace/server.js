"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { WebSocketServer } = require("ws");
const { verifyGoogleIdToken } = require("./lib/google-auth");
const limiter = require("./lib/ratelimit");
const { createEmbedder } = require("./lib/embeddings");
const { createVectorService } = require("./lib/vector");
const { createSmsSender, normalizeBdPhone } = require("./lib/sms");
const { createOtpService } = require("./lib/otp");
const { createGateway } = require("./lib/payments");
const { createMailer } = require("./lib/mailer");
const { render: renderEmail } = require("./lib/email-templates");
const { createEmailService } = require("./lib/email");

const ROOT = __dirname;

// Auto-load .env if present (without external dependencies)
try {
  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
      }
    }
  }
} catch {}
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 5000);
const SESSION_TTL = 7 * 24 * 60 * 60;
const WEB_ORIGIN = String(process.env.WEB_ORIGIN || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || "";
if (process.env.NODE_ENV === "production" && WEB_ORIGIN && !WEB_ORIGIN.startsWith("https://")) {
  throw new Error("Production requires HTTPS WEB_ORIGIN.");
}
const IS_PROD = process.env.NODE_ENV === "production";
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || Boolean(process.env.RENDER);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CATEGORIES = [
  ["Cleaning", "Home, office and deep cleaning"], ["Electrical", "Wiring, switches, fans and repairs"],
  ["Plumbing", "Leaks, taps, fittings and water lines"], ["Appliances", "Home appliance repair and maintenance"],
  ["Painting", "Interior and exterior painting"], ["Handyman", "Small home repairs and odd jobs"],
  ["Carpentry", "Furniture, doors and woodwork"], ["Building & Construction", "Renovation and construction"],
  ["Removals", "Moving homes, offices and furniture"], ["Delivery", "Local pickup and delivery"],
  ["Gardening", "Garden care, landscaping and plants"], ["Assembly", "Furniture and equipment assembly"],
  ["Auto", "Vehicle repair and automotive help"], ["Beauty", "Personal care and beauty services"],
  ["Tutoring", "Academic and skills tutoring"], ["Cooking", "Home cooking and meal preparation"],
  ["Food Delivery", "Food preparation and delivery"], ["Photography", "Events, portraits and product photos"],
  ["Computers & IT", "Computer repair, setup and IT support"], ["Audio Visual", "Sound, video and event equipment"],
  ["Design", "Graphic, web and product design"], ["Marketing", "Digital marketing and promotion"],
  ["Business", "Business, research and consulting"], ["Accounting", "Bookkeeping and accounting support"],
  ["Admin", "Virtual assistance and office administration"], ["Driving", "Personal and commercial driving"],
  ["Alterations", "Clothing repair and tailoring"], ["Bricklaying", "Masonry and brickwork"],
  ["Concreting", "Concrete, paving and foundations"], ["Decking", "Outdoor decks and timber work"],
  ["Childcare", "Child supervision and family support"], ["Events", "Event planning and setup"]
];

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "servinear.sqlite"));
db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    actor_name TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    tran_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'BDT',
    offer_id INTEGER,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed','cancelled','review','rejected')),
    gateway_session TEXT,
    val_id TEXT,
    bank_tran_id TEXT,
    method TEXT,
    risk_level INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS payouts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    account TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','rejected')),
    reference TEXT,
    admin_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT,
    processed_by INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status, created_at);
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('customer','worker','admin')),
    phone TEXT,
    area TEXT,
    address TEXT,
    category TEXT,
    bio TEXT,
    rate INTEGER,
    experience INTEGER,
    latitude REAL,
    longitude REAL,
    verified INTEGER NOT NULL DEFAULT 0,
    availability TEXT NOT NULL DEFAULT 'Available',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    details TEXT NOT NULL,
    area TEXT NOT NULL,
    budget INTEGER,
    contact_phone TEXT,
    exact_address TEXT,
    latitude REAL,
    longitude REAL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','completed','cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id INTEGER NOT NULL REFERENCES users(id),
    price INTEGER NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_id,worker_id)
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
    customer_id INTEGER NOT NULL REFERENCES users(id),
    worker_id INTEGER NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','reviewing','resolved')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_users_role_location ON users(role,latitude,longitude,verified);
  CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status,created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_offers_job_status ON offers(job_id,status);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status,created_at DESC);
  CREATE TABLE IF NOT EXISTS nid_verifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nid_front TEXT NOT NULL,
    nid_back TEXT NOT NULL,
    selfie_nid TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    admin_notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS saved_posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('job','worker')),
    target_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, target_type, target_id)
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'system',
    link TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(sender_id, recipient_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_nid_status ON nid_verifications(status, created_at DESC);
  CREATE TABLE IF NOT EXISTS wallets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance INTEGER NOT NULL DEFAULT 0,
    locked_escrow INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS escrows (
    id INTEGER PRIMARY KEY,
    job_id INTEGER UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
    customer_id INTEGER NOT NULL REFERENCES users(id),
    worker_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL,
    release_otp TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held','released','refunded')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    released_at TEXT
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('deposit','escrow_hold','escrow_release','withdrawal','refund')),
    amount INTEGER NOT NULL,
    payment_method TEXT,
    trx_id TEXT,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_escrow_job ON escrows(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_trx_user ON transactions(user_id, created_at DESC);

`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("users", "address", "TEXT");
ensureColumn("jobs", "contact_phone", "TEXT");
ensureColumn("jobs", "exact_address", "TEXT");
ensureColumn("users", "first_name", "TEXT");
ensureColumn("users", "surname", "TEXT");
ensureColumn("users", "gender", "TEXT");
ensureColumn("users", "city", "TEXT");
ensureColumn("users", "occupation", "TEXT");
ensureColumn("users", "google_id", "TEXT");
ensureColumn("users", "status", "TEXT NOT NULL DEFAULT 'active'");
ensureColumn("users", "last_login_at", "TEXT");
ensureColumn("users", "avatar_url", "TEXT");
ensureColumn("users", "reset_token", "TEXT");
ensureColumn("users", "reset_expires", "INTEGER");
db.exec("UPDATE users SET reset_token=NULL, reset_expires=NULL WHERE reset_token IS NOT NULL"); // legacy plaintext codes from the old reset flow
const sms = createSmsSender();
const otp = createOtpService({ db, sms, fail });
// Default: required in production, but only once an SMS provider exists (otherwise nobody could ever verify).
const REQUIRE_PHONE = process.env.REQUIRE_PHONE_VERIFIED ? process.env.REQUIRE_PHONE_VERIFIED === "1" : IS_PROD && sms.configured;
function requirePhone(user, force = false) {
  if ((REQUIRE_PHONE || force) && !user.phone_verified) fail(403, "Verify your mobile number to continue.", { code: "phone_verification_required" });
}
const gateway = createGateway();
const mailer = createMailer();
function apiBase() {
  const e = String(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (e) return e;
  if (IS_PROD) throw new Error("PUBLIC_API_URL is not set, so email links cannot be built.");
  return `http://localhost:${PORT}`;
}
const appBase = () => WEB_ORIGIN || apiBase();
const mailService = createEmailService({ db, mailer, render: renderEmail, fail, apiBase, appBase, hashPassword: passwordHashAsync });
if (!mailer.configured) console.warn("Email is OFF" + (mailer.problem ? " (" + mailer.problem + ")" : "") + ". Password reset and email notifications are unavailable. See .env.example.");
else console.log(`Email provider: ${mailer.provider}, from ${mailer.from}`);
const MIN_TOPUP = Number(process.env.MIN_TOPUP_BDT || 50), MAX_TOPUP = Number(process.env.MAX_TOPUP_BDT || 100000);
function publicApiUrl(req) {
  const env = String(process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (env) return env;
  if (IS_PROD) fail(503, "Payments are not configured (PUBLIC_API_URL).");
  return `http://${req.headers.host}`;
}
ensureColumn("users", "reset_token", "TEXT");
ensureColumn("users", "reset_expires", "INTEGER");
ensureColumn("users", "username", "TEXT");
ensureColumn("users", "avatar_photo", "TEXT");
ensureColumn("users", "profession_icon", "TEXT DEFAULT 'student'");
ensureColumn("users", "skills", "TEXT DEFAULT '[]'");
ensureColumn("users", "notif_reactions", "INTEGER DEFAULT 1");
ensureColumn("users", "notif_comments", "INTEGER DEFAULT 1");
ensureColumn("users", "notif_messages", "INTEGER DEFAULT 1");
ensureColumn("users", "notif_all", "INTEGER DEFAULT 1");
ensureColumn("users", "notif_updates", "INTEGER DEFAULT 1");
ensureColumn("users", "notif_hire", "INTEGER DEFAULT 0");
ensureColumn("users", "language", "TEXT DEFAULT 'bn'");

// ============================================================================
// VECTOR DATABASE CORE (128-DIMENSIONAL EMBEDDINGS & COSINE SIMILARITY ENGINE)
// ============================================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS vector_index (
    id INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    area TEXT,
    content TEXT NOT NULL,
    vector TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_vec_type ON vector_index(entity_type);
`);

const VECTOR_DIM = 128;

const SEMANTIC_CLUSTERS = [
  { dim: 0, terms: ["plumbing", "pipe", "leak", "faucet", "tap", "drain", "water", "basin", "commode", "প্লাম্বিং", "পাইপ", "লিক", "কল", "পানি", "ড্রেন"] },
  { dim: 6, terms: ["electrical", "electrician", "wiring", "wire", "switch", "circuit", "short", "voltage", "fan", "light", "ইলেক্ট্রিক", "ইলেক্ট্রিশিয়ান", "তার", "সুইচ", "ফ্যান", "বাতি", "বিদ্যুৎ"] },
  { dim: 12, terms: ["cleaning", "maid", "deep clean", "mop", "sweep", "sofa", "carpet", "wash", "ক্লিনিং", "পরিষ্কার", "মোছা", "ঝাড়ু", "ধোয়া", "সোফা"] },
  { dim: 18, terms: ["appliances", "fridge", "refrigerator", "microwave", "oven", "washing machine", "ফ্রিজ", "মাইক্রোওয়েভ", "ওভেন", "ওয়াশিং মেশিন"] },
  { dim: 24, terms: ["ac", "air condition", "cooling", "compressor", "gas refill", "hvac", "এসি", "শীতাতপ", "গ্যাস", "কুলিং"] },
  { dim: 30, terms: ["painting", "paint", "painter", "wall", "color", "roller", "distemper", "রং", "পেইন্টার", "দেয়াল", "কালার"] },
  { dim: 36, terms: ["carpentry", "carpenter", "wood", "furniture", "door", "table", "chair", "cabinet", "কাঠ", "ফার্নিচার", "ছুতোর", "দরজা", "টেবিল"] },
  { dim: 42, terms: ["handyman", "repair", "fix", "install", "mount", "drilling", "মেকানিক", "মেরামত", "ফিটিং", "ড্রিল"] },
  { dim: 48, terms: ["delivery", "courier", "rider", "pickup", "parcel", "ডেলিভারি", "কুরিয়ার", "রাইডার", "পার্সেল"] },
  { dim: 54, terms: ["driver", "car", "auto", "vehicle", "ride", "ড্রাইভার", "গাড়ি", "অটো", "চালক"] },
  { dim: 60, terms: ["it", "computer", "laptop", "software", "windows", "network", "wifi", "router", "আইটি", "কম্পিউটার", "ল্যাপটপ", "ওয়াইফাই"] },
  { dim: 66, terms: ["beauty", "salon", "makeup", "haircut", "facial", "মেকআপ", "চুল", "সেলুন", "বিউটি"] },
  { dim: 72, terms: ["tutor", "teacher", "math", "english", "study", "education", "শিক্ষক", "টিউশন", "পড়াশোনা"] },
  { dim: 78, terms: ["cooking", "chef", "cook", "food", "catering", "রান্না", "শেফ", "খাবার"] },
  { dim: 84, terms: ["cctv", "security", "camera", "lock", "ক্যামেরা", "সিসিটিভি", "নিরাপত্তা"] },
  { dim: 90, terms: ["construction", "mason", "brick", "cement", "রাজমিস্ত্রি", "ইট", "সিমেন্ট", "নির্মাণ"] }
];

function generateEmbedding(text) {
  const vec = new Float32Array(VECTOR_DIM);
  if (!text) return vec;
  const clean = String(text).toLowerCase();
  const tokens = clean.split(/[\s,.;:!?/()\-+]+/).filter((t) => t.length > 1);

  // 1. Semantic Clusters
  for (const cluster of SEMANTIC_CLUSTERS) {
    for (const term of cluster.terms) {
      if (clean.includes(term)) {
        vec[cluster.dim] += 3.0;
        vec[cluster.dim + 1] += 2.0;
        vec[cluster.dim + 2] += 1.5;
      }
    }
  }

  // 2. Token & Trigram Feature Hashing
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const idx = 96 + (Math.abs(hash) % 32);
    vec[idx] += 1.2;

    for (let i = 0; i <= token.length - 3; i++) {
      const tri = token.slice(i, i + 3);
      let triHash = 5381;
      for (let j = 0; j < tri.length; j++) {
        triHash = ((triHash << 5) + triHash) + tri.charCodeAt(j);
      }
      vec[Math.abs(triHash) % VECTOR_DIM] += 0.4;
    }
  }

  // 3. L2 Normalization (||vec|| = 1.0)
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  }
  return vec;
}

const embedder = createEmbedder();
const vectors = createVectorService({ db, embedder, hashEmbed: generateEmbedding });
function indexWorker(worker) { if (worker) vectors.upsert("worker", worker); }
function indexJob(job) { if (job) vectors.upsert("job", job); }
function initVectorDatabase() {
  db.prepare("SELECT * FROM users WHERE role='worker'").all().forEach(indexWorker);
  db.prepare("SELECT * FROM jobs").all().forEach(indexJob);
  const changed = vectors.backfill();
  console.log(`Search index ready (${embedder.enabled ? "semantic: " + embedder.id : "built-in vectors"}), ${vectors.size()} items, ${changed} queued for (re)embedding.`);
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

const scryptAsync = (pw, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));
async function passwordHashAsync(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${(await scryptAsync(password, salt)).toString("hex")}`;
}
async function checkPasswordAsync(password, saved) {
  const [salt, expected] = String(saved || "").split(":");
  if (!salt || !expected) return false;
  const actual = await scryptAsync(password, salt);
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}
function checkPassword(password, saved) {
  const [salt, expected] = String(saved || "").split(":");
  if (!salt || !expected) return false;
  const actual = Buffer.from(passwordHash(password, salt).split(":")[1], "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

function seedDatabase() {
  console.log("Seeding authentic Bangladeshi marketplace dataset across all platform modules...");

  // 1. Service Categories
  const addCategory = db.prepare(`
    INSERT OR IGNORE INTO categories (name, description) 
    VALUES (?, ?)
  `);
  CATEGORIES.forEach(([name, description]) => addCategory.run(name, description));

  // 2. Comprehensive cleanup of legacy synthetic generator data
  try {
    try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
    db.prepare("DELETE FROM offers WHERE job_id IN (SELECT id FROM jobs WHERE details LIKE '%Synthetic profile%' OR title LIKE '%SN-JOB-%' OR contact_phone LIKE 'DEMO-PHONE%') OR worker_id IN (SELECT id FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%')").run();
    db.prepare("DELETE FROM reviews WHERE customer_id IN (SELECT id FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%') OR worker_id IN (SELECT id FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%')").run();
    db.prepare("DELETE FROM saved_posts WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%')").run();
    db.prepare("DELETE FROM messages WHERE sender_id IN (SELECT id FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%') OR recipient_id IN (SELECT id FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%')").run();
    db.prepare("DELETE FROM jobs WHERE customer_id IN (SELECT id FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%') OR details LIKE '%Synthetic profile%' OR title LIKE '%SN-JOB-%' OR contact_phone LIKE 'DEMO-PHONE%'").run();
    db.prepare("DELETE FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%'").run();
    db.prepare("DELETE FROM vector_index WHERE entity_type='worker' AND entity_id NOT IN (SELECT id FROM users)").run();
    db.prepare("DELETE FROM vector_index WHERE entity_type='job' AND entity_id NOT IN (SELECT id FROM jobs)").run();
    try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
    console.log("Successfully cleaned legacy demo data and preserved authentic Bangladeshi dataset.");
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }

  const defaultHash = passwordHash("ServiNear123!");
  const addUser = db.prepare(`
    INSERT OR IGNORE INTO users (
      name, email, password_hash, role, phone, area, address, 
      category, bio, rate, experience, latitude, longitude, 
      verified, availability, phone_verified, email_verified, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'active')
  `);

  const authenticUsers = [
    // Authentic Bangladeshi Customers
    ["Nusrat Jahan", "nusrat.jahan@gmail.com", defaultHash, "customer", "01712-345678", "Dhanmondi, Dhaka", "House 42, Road 27, Dhanmondi, Dhaka", null, "Verified residential client in Dhanmondi. Looking for trusted home service professionals.", null, null, 23.7465, 90.3760, 1, "Available"],
    ["Tariqul Islam", "tariqul.islam@gmail.com", defaultHash, "customer", "01819-234567", "Mirpur 10, Dhaka", "Block C, Avenue 4, Mirpur 10, Dhaka", null, "Apartment owner in Mirpur. Active user for maintenance and fast short-term help.", null, null, 23.8223, 90.3654, 1, "Available"],
    ["Sabrina Yasmin", "sabrina.yasmin@outlook.com", defaultHash, "customer", "01911-345678", "Uttara, Dhaka", "Sector 4, Road 12, Uttara, Dhaka", null, "Professional working in corporate sector, frequently hiring vetted home cleaners and technicians.", null, null, 23.8759, 90.3795, 1, "Available"],
    ["Mostafa Kamal", "mostafa.kamal@yahoo.com", defaultHash, "customer", "01612-456789", "Banani, Dhaka", "Road 8, Block D, Banani, Dhaka", null, "Banani resident. Requires regular AC maintenance and appliance servicing.", null, null, 23.7937, 90.4043, 1, "Available"],
    ["Dr. Rezwana Karim", "dr.rezwana@gmail.com", defaultHash, "customer", "01723-567890", "Mohammadpur, Dhaka", "Japan Garden City, Building 14, Mohammadpur, Dhaka", null, "Medical practitioner at DMC. Needs reliable emergency handymen and errands support.", null, null, 23.7658, 90.3582, 1, "Available"],
    ["Farhan Tanvir", "farhan.tanvir@hotmail.com", defaultHash, "customer", "01824-678901", "Bashundhara, Dhaka", "Block C, Road 5, Bashundhara R/A, Dhaka", null, "Software engineer in Bashundhara. Tech and home automation enthusiast.", null, null, 23.8151, 90.4255, 1, "Available"],
    ["Khadija Akhter", "khadija.akhter@gmail.com", defaultHash, "customer", "01935-789012", "Agrabad, Chattogram", "CDA Residential Area, Agrabad, Chattogram", null, "Chattogram homeowner looking for verified local plumbers and electricians.", null, null, 22.3569, 91.7832, 1, "Available"],

    // Authentic Bangladeshi Service Providers
    ["Engr. Tanvir Hasan", "tanvir.electrician@gmail.com", defaultHash, "worker", "01715-112233", "Dhanmondi, Dhaka", "Road 15, Dhanmondi, Dhaka", "Electrical", "BUET Electrical Diploma. 9+ years experience in domestic & industrial wiring, DB boards, smart dimmers, and emergency short-circuit diagnosis. 100% safety certified.", 650, 9, 23.7465, 90.3760, 1, "Available"],
    ["Md. Shamim Reza", "shamim.ac.expert@gmail.com", defaultHash, "worker", "01817-223344", "Mirpur 10, Dhaka", "Section 10, Block D, Mirpur, Dhaka", "Appliances", "Daikin & Gree authorized specialist. 11 years in split/inverter AC servicing, precision gas leakage detection, PCB board repairs, and chemical jet wash.", 850, 11, 23.8223, 90.3654, 1, "Available"],
    ["Kazi Nazmul Huda", "nazmul.plumbing@gmail.com", defaultHash, "worker", "01918-334455", "Uttara, Dhaka", "Sector 7, Road 18, Uttara, Dhaka", "Plumbing", "Master sanitary technician. Expert in high-pressure water pumps, concealed pipe leakages, bathroom fittings, and kitchen sink blockages.", 600, 8, 23.8759, 90.3795, 1, "Available"],
    ["Sajjad Hossain", "sajjad.techservice@gmail.com", defaultHash, "worker", "01724-990011", "Motijheel, Dhaka", "Dilkusha Commercial Area, Dhaka", "Computers & IT", "Certified hardware & network engineer. Laptop chip-level servicing, SSD upgrade, data recovery, Windows/macOS install, and enterprise Wi-Fi routers.", 700, 8, 23.7330, 90.4172, 1, "Available"],
    ["Jannatul Ferdous", "jannat.beauty@gmail.com", defaultHash, "worker", "01825-112244", "Dhanmondi, Dhaka", "Road 8/A, Dhanmondi, Dhaka", "Beauty", "Certified aesthetician and bridal makeup artist. At-home facial, organic hair treatment, bridal mehendi, and skin care services with hygienic kits.", 900, 6, 23.7480, 90.3750, 0, "Available"],
    ["Rashedul Karim", "rashed.cargo@gmail.com", defaultHash, "worker", "01926-223355", "Old Dhaka, Dhaka", "Lalbagh Road, Dhaka", "Removals", "Owns covered pickup van for home shifting, inter-city parcel transfer, fragile glassware packing, and safe multi-floor furniture carriage.", 1100, 9, 23.7180, 90.3882, 1, "Available"],
    ["Nazmul Haque", "nazmul.cctv@gmail.com", defaultHash, "worker", "01627-334466", "Mirpur 2, Dhaka", "Stadium Road, Mirpur 2, Dhaka", "Computers & IT", "Hikvision & Dahua certified security camera installer. IP camera setup, DVR/NVR remote viewing configuration on smartphone, and intercom lines.", 750, 7, 23.8050, 90.3620, 0, "Available"],
    ["Habibur Rahman", "habib.auto@gmail.com", defaultHash, "worker", "01728-445577", "Farmgate, Dhaka", "Indira Road, Farmgate, Dhaka", "Auto", "Automobile breakdown specialist. Immediate on-spot battery jumpstart, tire puncture repair, radiator coolant check, and brake inspection.", 600, 10, 23.7580, 90.3860, 1, "Available"],
    ["Iqbal Hossain", "iqbal.plumber.ctg@gmail.com", defaultHash, "worker", "01829-556688", "Agrabad, Chattogram", "Badamtali, Agrabad, Chattogram", "Plumbing", "Chattogram port & residential plumbing contractor. Water storage tank cleaning, submersible motor setup, and pipe fittings.", 650, 11, 22.3569, 91.7832, 0, "Available"],
    ["Forhad Mia", "forhad.electric.sylhet@gmail.com", defaultHash, "worker", "01930-667799", "Zindabazar, Sylhet", "Court Road, Zindabazar, Sylhet", "Electrical", "Sylhet city specialist for IPS inverters, generator transfer switches, commercial showroom lighting, and earthing installation.", 700, 8, 24.8949, 91.8687, 0, "Available"]
  ];

  authenticUsers.forEach(([name, email, pass, role, phone, area, address, category, bio, rate, exp, lat, lng, verified, avail]) => {
    addUser.run(name, email, pass, role, phone, area, address, category, bio, rate, exp, lat, lng, verified, avail);
    db.prepare("UPDATE users SET phone_verified = 1, email_verified = 1, status = 'active' WHERE email = ?").run(email);
  });

  // User Lookups by Email
  const userMap = {};
  db.prepare("SELECT id, email FROM users").all().forEach((u) => { userMap[u.email] = u.id; });
  const nusratId   = userMap["nusrat.jahan@gmail.com"];
  const tariqulId  = userMap["tariqul.islam@gmail.com"];
  const sabrinaId  = userMap["sabrina.yasmin@outlook.com"];
  const mostafaId  = userMap["mostafa.kamal@yahoo.com"];
  const rezwanaId  = userMap["dr.rezwana@gmail.com"];
  const farhanId   = userMap["farhan.tanvir@hotmail.com"];
  const khadijaId  = userMap["khadija.akhter@gmail.com"];

  const tanvirId   = userMap["tanvir.electrician@gmail.com"];
  const shamimId   = userMap["shamim.ac.expert@gmail.com"];
  const nazmulId   = userMap["nazmul.plumbing@gmail.com"];
  const sajjadId   = userMap["sajjad.techservice@gmail.com"];
  const jannatId   = userMap["jannat.beauty@gmail.com"];
  const rashedId   = userMap["rashed.cargo@gmail.com"];
  const cctvId     = userMap["nazmul.cctv@gmail.com"];
  const habibId    = userMap["habib.auto@gmail.com"];
  const iqbalId    = userMap["iqbal.plumber.ctg@gmail.com"];

  // 3. Authentic Community Tasks / Jobs
  const addJob = db.prepare(`
    INSERT OR REPLACE INTO jobs (
      id, customer_id, title, category, details, area, budget, 
      contact_phone, exact_address, latitude, longitude, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  if (nusratId && tariqulId && sabrinaId && mostafaId) {
    addJob.run(1, nusratId, "Split AC Master Servicing & Precision Gas Refill", "Appliances", "Gree 1.5 ton split AC cooling has dropped significantly. Need outdoor compressor chemical wash, drain line unclogging, and R410A gas pressure check at Dhanmondi 27.", "Dhanmondi, Dhaka", 2800, "01712-345678", "House 42, Road 27, Dhanmondi, Dhaka", 23.7465, 90.3760, "accepted");
    addJob.run(2, tariqulId, "Sub-distribution Board Circuit Breaker Tripping & Rewiring", "Electrical", "Main MCB trips whenever geyser and microwave run simultaneously. Need certified electrician to inspect phase distribution, DB earthing, and replace 32A breaker.", "Mirpur 10, Dhaka", 1600, "01819-234567", "Block C, Avenue 4, Mirpur 10, Dhaka", 23.8223, 90.3654, "completed");
    addJob.run(3, sabrinaId, "Concealed Bathroom Pipe Leakage & Kitchen Sink Mixer Fitting", "Plumbing", "Concealed hot-water CPVC pipe leaking behind master bathroom tiles causing damp walls. Also need to replace kitchen flex faucet with Jaquar mixer.", "Uttara, Dhaka", 2200, "01911-345678", "Sector 4, Road 12, Uttara, Dhaka", 23.8759, 90.3795, "completed");
    addJob.run(4, mostafaId, "Urgent Home Shifting: 3BHK Furniture & Glassware Transport", "Removals", "Moving from Banani Road 8 to Gulshan 1. Heavy items: King bed, 6-seater dining table, 4 door wardrobe, refrigerator, and 12 carton fragile crockery. Covered van needed.", "Banani, Dhaka", 7500, "01612-456789", "Road 8, Block D, Banani, Dhaka", 23.7937, 90.4043, "completed");
    addJob.run(5, rezwanaId, "Micro-task: Rapid 2-Hour Errand & Document Delivery", "Delivery", "Urgent hospital report and prescription delivery from Mohammadpur Japan Garden City to Square Hospital Panthapath within 2 hours.", "Mohammadpur, Dhaka", 450, "01723-567890", "Japan Garden City, Building 14, Mohammadpur, Dhaka", 23.7658, 90.3582, "open");
    addJob.run(6, farhanId, "Home Dual-Band Wi-Fi 6 Router & 4-Channel IP Camera Setup", "Computers & IT", "Setup TP-Link Archer router with mesh extender across 2200 sqft apartment, configure Hikvision IP cameras with mobile app remote viewing.", "Bashundhara, Dhaka", 3000, "01824-678901", "Block C, Road 5, Bashundhara R/A, Dhaka", 23.8151, 90.4255, "open");
    if (khadijaId) addJob.run(7, khadijaId, "Emergency Water Pump Capacitor Burnout & Line Check", "Plumbing", "Submersible water pump in Agrabad residential building not turning on. Tripping master breaker. Need urgent pump inspection and capacitor replacement.", "Agrabad, Chattogram", 1800, "01935-789012", "CDA Residential Area, Agrabad, Chattogram", 22.3569, 91.7832, "open");
    addJob.run(8, nusratId, "Deep House Painting & Waterproofing for Master Bedroom", "Painting", "Berger Luxury Silk wall painting with damp-proofing sealer coat for master bedroom and balcony ceiling.", "Dhanmondi, Dhaka", 12000, "01712-345678", "House 42, Road 27, Dhanmondi, Dhaka", 23.7465, 90.3760, "open");
  }

  // 4. Authentic Provider Offers
  const addOffer = db.prepare(`
    INSERT OR REPLACE INTO offers (id, job_id, worker_id, price, message, status) 
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  if (shamimId) addOffer.run(1, 1, shamimId, 2600, "I can visit Dhanmondi 27 today at 3:30 PM with manifold gauge, vacuum pump, and genuine refrigerant.", "accepted");
  if (tanvirId) addOffer.run(2, 2, tanvirId, 1500, "Will test insulation resistance with megger, balance phase loads, and install Havells MCB with 1-year service warranty.", "accepted");
  if (nazmulId) addOffer.run(3, 3, nazmulId, 2000, "Experienced in non-destructive acoustic pipe leak detection and sanitary fittings replacement.", "accepted");
  if (rashedId) addOffer.run(4, 4, rashedId, 7000, "Includes 14ft covered truck, 4 skilled lifters, bubble wrap, and safe delivery.", "accepted");
  if (habibId) addOffer.run(5, 5, habibId, 450, "Available immediately with motorcycle for swift delivery.", "pending");
  if (sajjadId) addOffer.run(6, 6, sajjadId, 2800, "Certified IT engineer. Will complete Wi-Fi 6 roaming configuration and NVR phone app remote connection.", "pending");
  if (cctvId) addOffer.run(7, 6, cctvId, 2900, "Hikvision specialist with full crimping and mounting toolkit.", "pending");
  if (tanvirId) addOffer.run(8, 8, tanvirId, 11500, "Have professional painting crew and anti-fungal Berger damp sealant.", "pending");

  // 5. Escrow Protection Records
  const addEscrow = db.prepare(`
    INSERT OR REPLACE INTO escrows (id, job_id, offer_id, customer_id, worker_id, amount, release_otp, status, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  if (nusratId && shamimId) addEscrow.run(1, 1, 1, nusratId, shamimId, 2600, "582914", "held", null);
  if (tariqulId && tanvirId) addEscrow.run(2, 2, 2, tariqulId, tanvirId, 1500, "739104", "released", new Date(Date.now() - 86400000 * 2).toISOString());
  if (sabrinaId && nazmulId) addEscrow.run(3, 3, 3, sabrinaId, nazmulId, 2000, "419283", "released", new Date(Date.now() - 86400000 * 4).toISOString());
  if (mostafaId && rashedId) addEscrow.run(4, 4, 4, mostafaId, rashedId, 7000, "820491", "released", new Date(Date.now() - 86400000 * 6).toISOString());

  // 6. User Wallets
  const setWallet = db.prepare(`
    INSERT OR REPLACE INTO wallets (user_id, balance, locked_escrow) 
    VALUES (?, ?, ?)
  `);
  if (nusratId) setWallet.run(nusratId, 6000, 2600);
  if (tariqulId) setWallet.run(tariqulId, 100, 0);
  if (sabrinaId) setWallet.run(sabrinaId, 300, 0);
  if (mostafaId) setWallet.run(mostafaId, 500, 0);
  if (shamimId) setWallet.run(shamimId, 2600, 0);
  if (tanvirId) setWallet.run(tanvirId, 1500, 0);
  if (rashedId) setWallet.run(rashedId, 7000, 0);
  if (nazmulId) setWallet.run(nazmulId, 2000, 0);

  // 7. Gateway Payments (Top-ups)
  const addPayment = db.prepare(`
    INSERT OR IGNORE INTO payments (tran_id, user_id, amount, provider, status, method, risk_level, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  if (nusratId) addPayment.run("SN-DEP-1001", nusratId, 5000, "bKash", "paid", "bKash Online", 0, new Date().toISOString());
  if (tariqulId) addPayment.run("SN-DEP-1002", tariqulId, 1600, "Nagad", "review", "Nagad Direct", 1, null);
  if (sabrinaId) addPayment.run("SN-DEP-1003", sabrinaId, 2500, "SSLCommerz", "paid", "Visa Card", 0, new Date().toISOString());
  if (mostafaId) addPayment.run("SN-DEP-1004", mostafaId, 7500, "bKash", "paid", "bKash Checkout", 0, new Date().toISOString());

  // 8. Payout Requests
  const addPayout = db.prepare(`
    INSERT OR REPLACE INTO payouts (id, user_id, amount, method, account, status, reference, admin_note, processed_at, processed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  if (shamimId) addPayout.run(1, shamimId, 2600, "bKash", "01817-223344", "pending", null, null, null, null);
  if (tanvirId) addPayout.run(2, tanvirId, 1500, "Nagad", "01715-112233", "pending", null, null, null, null);
  if (rashedId) addPayout.run(3, rashedId, 7000, "bKash", "01926-223355", "paid", "BKH92817364", "Disbursed via commercial bKash", new Date().toISOString(), 1);

  // 9. Financial Transactions
  const addTx = db.prepare(`
    INSERT OR IGNORE INTO transactions (user_id, type, amount, payment_method, trx_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  if (nusratId) {
    addTx.run(nusratId, "deposit", 5000, "bKash", "SN-DEP-1001", "Wallet top-up via bKash Online");
    addTx.run(nusratId, "escrow_hold", 2600, "Wallet Escrow", "ESC-JOB-1", "Escrow locked for Task #1 (AC Servicing)");
  }
  if (tariqulId) {
    addTx.run(tariqulId, "deposit", 1600, "Nagad", "SN-DEP-1002", "Wallet top-up via Nagad Direct");
    addTx.run(tariqulId, "escrow_hold", 1500, "Wallet Escrow", "ESC-JOB-2", "Escrow locked for Task #2 (DB Breaker)");
  }
  if (tanvirId) addTx.run(tanvirId, "escrow_release", 1500, "Wallet Escrow", "ESC-JOB-2", "Payment released for Task #2 completion");
  if (sabrinaId) {
    addTx.run(sabrinaId, "deposit", 2500, "SSLCommerz", "SN-DEP-1003", "Wallet top-up via Visa Card");
    addTx.run(sabrinaId, "escrow_hold", 2000, "Wallet Escrow", "ESC-JOB-3", "Escrow locked for Task #3 (Pipe Leakage)");
  }
  if (nazmulId) addTx.run(nazmulId, "escrow_release", 2000, "Wallet Escrow", "ESC-JOB-3", "Payment released for Task #3 completion");
  if (mostafaId) {
    addTx.run(mostafaId, "deposit", 7500, "bKash", "SN-DEP-1004", "Wallet top-up via bKash Checkout");
    addTx.run(mostafaId, "escrow_hold", 7000, "Wallet Escrow", "ESC-JOB-4", "Escrow locked for Task #4 (Home Shifting)");
  }
  if (rashedId) addTx.run(rashedId, "escrow_release", 7000, "Wallet Escrow", "ESC-JOB-4", "Payment released for Task #4 completion");

  // 10. Verified Reviews & Ratings
  const addReview = db.prepare(`
    INSERT OR REPLACE INTO reviews (id, job_id, customer_id, worker_id, rating, comment)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  if (tariqulId && tanvirId) addReview.run(1, 2, tariqulId, tanvirId, 5, "Exceptional work! Engr. Tanvir properly balanced the sub-distribution board and replaced the tripping breaker. Very polite, arrived on time with proper multimeter and tools. Highly recommended!");
  if (mostafaId && rashedId) addReview.run(2, 4, mostafaId, rashedId, 5, "Rashedul and his team handled our home shifting from Banani to Gulshan with extreme care. Not a single glass item chipped. Clean covered van and professional helpers.");
  if (sabrinaId && nazmulId) addReview.run(3, 3, sabrinaId, nazmulId, 4, "Fixed the bathroom concealed hot-water pipe leakage effectively. Cleaned the work area afterwards. Good sanitary tradesman.");
  if (rezwanaId && shamimId) addReview.run(4, 1, rezwanaId, shamimId, 5, "Shamim Bhai did a comprehensive chemical jet wash and filled R410A refrigerant on our Gree inverter AC. Cooling restored to optimal efficiency.");

  // SVG Mock Documents for NID Verification
  const nidDoc = (type, name, nid) => {
    if (type === "front") {
      return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220"><rect width="360" height="220" rx="12" fill="%230b4d3c"/><rect x="12" y="12" width="336" height="196" rx="8" fill="%23ffffff"/><text x="24" y="38" font-family="sans-serif" font-size="12" font-weight="bold" fill="%230b4d3c">PEOPLE%27S REPUBLIC OF BANGLADESH</text><text x="24" y="56" font-family="sans-serif" font-size="11" fill="%23d97706">National ID Card / জাতীয় পরিচয় পত্র</text><rect x="24" y="70" width="75" height="90" fill="%23e2e8f0" rx="4"/><circle cx="61" cy="105" r="22" fill="%2394a3b8"/><text x="110" y="92" font-family="sans-serif" font-size="12" font-weight="bold" fill="%231e293b">NAME: ${encodeURIComponent(name)}</text><text x="110" y="112" font-family="sans-serif" font-size="11" fill="%2364748b">DOB: 14 Oct 1992</text><text x="110" y="132" font-family="sans-serif" font-size="11" font-weight="bold" fill="%23b91c1c">NID NO: ${nid}</text><text x="110" y="152" font-family="sans-serif" font-size="10" fill="%23059669">Smart NID Citizen Verification</text></svg>`;
    }
    if (type === "back") {
      return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220"><rect width="360" height="220" rx="12" fill="%230b4d3c"/><rect x="12" y="12" width="336" height="196" rx="8" fill="%23f8fafc"/><text x="24" y="40" font-family="sans-serif" font-size="11" font-weight="bold" fill="%231e293b">Address: House 24, Road 11, Dhaka</text><text x="24" y="60" font-family="sans-serif" font-size="10" fill="%2364748b">Blood Group: B+ Positive | Issue Date: 2018-05-14</text><rect x="24" y="80" width="312" height="50" fill="%231e293b" rx="2"/><text x="40" y="110" font-family="monospace" font-size="16" fill="%23ffffff">||| | |||| || |||||| | |||| ||| ||</text></svg>`;
    }
    return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="360" height="260" viewBox="0 0 360 260"><rect width="360" height="260" rx="12" fill="%23f1f5f9"/><circle cx="180" cy="95" r="45" fill="%230e6b5c"/><circle cx="180" cy="85" r="22" fill="%23f8fafc"/><rect x="110" y="160" width="140" height="85" rx="6" fill="%230b4d3c"/><rect x="116" y="166" width="128" height="73" rx="4" fill="%23ffffff"/><text x="122" y="188" font-family="sans-serif" font-size="9" font-weight="bold" fill="%230b4d3c">BANGLADESH NID</text><text x="122" y="202" font-family="sans-serif" font-size="8" fill="%231e293b">${encodeURIComponent(name)}</text><text x="122" y="216" font-family="sans-serif" font-size="8" fill="%23b91c1c">${nid}</text><text x="80" y="255" font-family="sans-serif" font-size="10" font-weight="bold" fill="%23047857">Holding NID Selfie Verification</text></svg>`;
  };

  // 11. NID Verification Applications
  const addNid = db.prepare(`
    INSERT OR REPLACE INTO nid_verifications (id, user_id, nid_front, nid_back, selfie_nid, status, admin_notes, created_at, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  if (jannatId) addNid.run(1, jannatId, nidDoc("front", "Jannatul Ferdous", "5928173921"), nidDoc("back", "Jannatul Ferdous", "5928173921"), nidDoc("selfie", "Jannatul Ferdous", "5928173921"), "pending", null, new Date().toISOString(), null);
  if (cctvId) addNid.run(2, cctvId, nidDoc("front", "Nazmul Haque", "6819283912"), nidDoc("back", "Nazmul Haque", "6819283912"), nidDoc("selfie", "Nazmul Haque", "6819283912"), "pending", null, new Date().toISOString(), null);
  if (tanvirId) addNid.run(3, tanvirId, nidDoc("front", "Engr. Tanvir Hasan", "4918273615"), nidDoc("back", "Engr. Tanvir Hasan", "4918273615"), nidDoc("selfie", "Engr. Tanvir Hasan", "4918273615"), "approved", "Verified against national voter database. Trade diploma validated.", new Date(Date.now() - 86400000 * 5).toISOString(), new Date().toISOString());
  if (iqbalId) addNid.run(4, iqbalId, nidDoc("front", "Iqbal Hossain", "3819273614"), nidDoc("back", "Iqbal Hossain", "3819273614"), nidDoc("selfie", "Iqbal Hossain", "3819273614"), "rejected", "NID back barcode was blurry. Please resubmit high-resolution photo.", new Date(Date.now() - 86400000 * 3).toISOString(), new Date().toISOString());

  // 12. Support & Helpline Tickets
  const addTicket = db.prepare(`
    INSERT OR REPLACE INTO support_tickets (id, user_id, name, email, subject, message, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  addTicket.run(1, nusratId || null, "Nusrat Jahan", "nusrat.jahan@gmail.com", "Question regarding bKash payment verification", "Hello support, I topped up ৳2,000 using bKash merchant gateway and wanted to confirm if the funds are safely held in escrow for my AC repair task.", "open", new Date(Date.now() - 3600000 * 2).toISOString());
  addTicket.run(2, shamimId || null, "Md. Shamim Reza", "shamim.ac.expert@gmail.com", "Payout timing to Nagad mobile wallet", "Assalamu Alaikum. I requested a withdrawal of ৳2,600 yesterday after completing the split AC service at Dhanmondi. Could you please confirm when the payout batch will be processed?", "reviewing", new Date(Date.now() - 3600000 * 6).toISOString());
  addTicket.run(3, tariqulId || null, "Tariqul Islam", "tariqul.islam@gmail.com", "Electrician safety certification inquiry", "I want to confirm if the electricians on the platform hold valid safety certifications for high-voltage DB distribution board rewiring.", "resolved", new Date(Date.now() - 86400000).toISOString());
  addTicket.run(4, sabrinaId || null, "Sabrina Yasmin", "sabrina.yasmin@outlook.com", "Invoice receipt for plumbing repair", "Could you please send me a digital tax invoice/receipt for task #3? I need to submit it to our apartment committee for building maintenance reimbursement.", "open", new Date(Date.now() - 3600000 * 12).toISOString());
  addTicket.run(5, null, "Kamal Hossain", "kamal.citizen@gmail.com", "Helpline hotline query for Chattogram area", "Is the 09612-345678 hotline toll-free across all mobile operators in Bangladesh?", "open", new Date(Date.now() - 3600000 * 20).toISOString());

  // 13. Email Outbox Records
  const addEmail = db.prepare(`
    INSERT OR REPLACE INTO email_outbox (
      id, user_id, to_email, subject, html, text, kind, category, 
      status, attempts, next_attempt_at, created_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  addEmail.run(1, nusratId || null, "nusrat.jahan@gmail.com", "Welcome to ServiNear - Please verify your email", "[removed after delivery]", "Welcome to ServiNear Bangladesh", "verify", "transactional", "sent", 1, 0, new Date(Date.now() - 86400000 * 2).toISOString(), new Date(Date.now() - 86400000 * 2).toISOString());
  addEmail.run(2, shamimId || null, "shamim.ac.expert@gmail.com", "New Opportunity in Dhanmondi: Split AC Master Servicing", "<p>A client posted a new task matching your profile.</p>", "A client posted a new task matching your profile.", "offer_alert", "activity", "sent", 1, 0, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString());
  addEmail.run(3, 1, "hadimonsurhasan@gmail.com", "Admin Alert: Payout Request Pending Approval (৳2,600)", "<p>A provider requested a withdrawal.</p>", "A provider requested a withdrawal.", "admin_alert", "transactional", "sent", 1, 0, new Date(Date.now() - 3600000 * 4).toISOString(), new Date(Date.now() - 3600000 * 4).toISOString());
  addEmail.run(4, tariqulId || null, "tariqul.islam@gmail.com", "Receipt: Escrow Release for Task #2 (৳1,500)", "<p>Payment has been completed for Task #2.</p>", "Payment has been completed for Task #2.", "receipt", "transactional", "sent", 1, 0, new Date(Date.now() - 86400000 * 2).toISOString(), new Date(Date.now() - 86400000 * 2).toISOString());

  // 14. Administrative Audit Log
  const addAudit = db.prepare(`
    INSERT OR REPLACE INTO audit_log (id, actor_name, action, entity, entity_id, detail, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  addAudit.run(1, "System", "system.bootstrap", "database", "init", '{"version":"2.0.0","mode":"production_ready"}', "127.0.0.1", new Date(Date.now() - 86400000 * 5).toISOString());
  addAudit.run(2, "Monsur Hasan", "category.verify", "category", "Appliances", '{"status":"active","workers_indexed":12}', "127.0.0.1", new Date(Date.now() - 86400000 * 4).toISOString());
  addAudit.run(3, "Monsur Hasan", "nid.approve", "user", String(tanvirId || 8), '{"applicant":"Engr. Tanvir Hasan","decision":"approved"}', "127.0.0.1", new Date(Date.now() - 86400000 * 3).toISOString());
  addAudit.run(4, "Monsur Hasan", "escrow.audit", "escrow", "1", '{"job_id":1,"amount":2600,"status":"held"}', "127.0.0.1", new Date(Date.now() - 86400000).toISOString());

  // 15. Real-time Notifications
  const addNotif = db.prepare(`
    INSERT OR REPLACE INTO notifications (id, user_id, title, message, type, link, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  if (nusratId) {
    addNotif.run(1, nusratId, "New Offer Received", "Md. Shamim Reza offered ৳2,600 on your Split AC servicing task.", "offer", "/jobs", 0, new Date(Date.now() - 3600000 * 2).toISOString());
    addNotif.run(2, nusratId, "New Message from Engr. Tanvir Hasan", "Hello! I noticed your AC servicing post. Feel free to reach out if you need DB board inspection.", "chat", "/inbox", 0, new Date(Date.now() - 3600000 * 3).toISOString());
    addNotif.run(3, nusratId, "Wallet Credited: ৳5,000", "Top-up via bKash Online confirmed. Your available balance is ৳2,400 with ৳2,600 in escrow.", "wallet", "/profile", 1, new Date(Date.now() - 86400000).toISOString());
  }
  if (shamimId) {
    addNotif.run(4, shamimId, "Offer Accepted & Escrow Locked!", "Client secured ৳2,600 in ServiNear Escrow for Task #1. Customer address and phone unlocked.", "accepted", "/jobs", 0, new Date(Date.now() - 3600000 * 2).toISOString());
    addNotif.run(5, shamimId, "New Task in Dhanmondi", "Split AC Master Servicing & Precision Gas Refill posted near your service area.", "job", "/jobs", 1, new Date(Date.now() - 86400000).toISOString());
  }
  if (tanvirId) {
    addNotif.run(6, tanvirId, "Escrow Released: ৳1,500", "Client marked Task #2 complete. ৳1,500 has been credited to your wallet balance.", "wallet", "/profile", 0, new Date(Date.now() - 86400000 * 2).toISOString());
  }

  // 16. Chat Messages
  const addMsg = db.prepare(`
    INSERT OR REPLACE INTO messages (id, sender_id, recipient_id, job_id, content, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  if (nusratId && shamimId) {
    addMsg.run(1, shamimId, nusratId, 1, "Assalamu Alaikum Nusrat Apa. I will arrive at House 42 Road 27 today at 3:30 PM with the manifold gauge, vacuum pump, and R410A refrigerant.", 1, new Date(Date.now() - 3600000 * 3).toISOString());
    addMsg.run(2, nusratId, shamimId, 1, "Walaikum Assalam Shamim Bhai. Please bring an outdoor jet spray hose as well for the compressor wash.", 1, new Date(Date.now() - 3600000 * 2).toISOString());
    addMsg.run(3, shamimId, nusratId, 1, "Understood, high-pressure jet pump is ready in my service kit. See you soon.", 0, new Date(Date.now() - 3600000).toISOString());
  }
  if (nusratId && tanvirId) {
    addMsg.run(4, tanvirId, nusratId, null, "Hello Nusrat, if you ever need your main switchboard or DB breaker inspected while I am in Dhanmondi, let me know.", 1, new Date(Date.now() - 86400000).toISOString());
    addMsg.run(5, nusratId, tanvirId, null, "Thank you Tanvir Bhai, we may need a 32A breaker replacement next week. Will message you.", 1, new Date(Date.now() - 86400000 + 1800000).toISOString());
  }

  console.log("Seeding complete: All 10 admin sections, financial escrows, reviews, tickets and chat history populated.");
}
const SEED_DEMO = process.env.SEED_DEMO_DATA === "true" || !IS_PROD;
if (SEED_DEMO) {
  seedDatabase();
} else {
  const addCat = db.prepare("INSERT OR IGNORE INTO categories(name,description) VALUES(?,?)");
  CATEGORIES.forEach(([n, d]) => addCat.run(n, d));
}
function ensureEnvAdmin() {
  // Purge any legacy demo admin account completely
  try {
    const legacy = db.prepare("SELECT id FROM users WHERE email='admin@servinear.local'").get();
    if (legacy) {
      db.prepare("DELETE FROM users WHERE id=?").run(legacy.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(legacy.id);
      console.log("Security: purged legacy demo administrator account (admin@servinear.local).");
    }
  } catch (err) {
    console.warn("Could not check legacy admin:", err.message);
  }

  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const pw = String(process.env.ADMIN_PASSWORD || "");

  if (!email) {
    if (IS_PROD && !db.prepare("SELECT 1 FROM users WHERE role='admin' AND status='active'").get())
      console.warn("No active admin exists. Set ADMIN_EMAIL and ADMIN_PASSWORD (14+ chars) and restart.");
    return;
  }

  const existing = db.prepare("SELECT id, role, status FROM users WHERE email=?").get(email);
  if (existing) {
    if (pw && pw.length >= 14) {
      db.prepare("UPDATE users SET role='admin', status='active', verified=1, email_verified=1, phone_verified=1, password_hash=? WHERE id=?")
        .run(passwordHash(pw), existing.id);
      console.log("Updated administrator credentials for " + email);
    } else {
      db.prepare("UPDATE users SET role='admin', status='active', verified=1, email_verified=1 WHERE id=?")
        .run(existing.id);
      console.log("Ensured administrator privileges for " + email);
    }
  } else if (pw && pw.length >= 14) {
    db.prepare("INSERT INTO users(name,email,password_hash,role,phone,phone_verified,area,verified,email_verified,status) VALUES('Monsur Hasan',?,?, 'admin', '01944-713903', 1, 'Dhaka', 1, 1, 'active')")
      .run(email, passwordHash(pw));
    console.log("Created administrator account for " + email);
  } else {
    console.warn("ADMIN_PASSWORD must be at least 14 characters to provision a new administrator account.");
  }
}
ensureEnvAdmin();
initVectorDatabase();

function send(res,status,payload,headers={}) {
  const body=Buffer.from(JSON.stringify(payload));
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":body.length,"Cache-Control":"no-store",...headers});
  res.end(body);
}
function fail(status,message,extra) { const error=new Error(message); error.status=status; if(extra)error.extra=extra; throw error; }
function parseCookies(header="") {
  return Object.fromEntries(header.split(";").map((part)=>{const i=part.indexOf("=");return i<0?["",""]:[part.slice(0,i).trim(),decodeURIComponent(part.slice(i+1).trim())];}));
}
function currentUser(id) {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!u) return null;
  delete u.password_hash;
  delete u.google_id;
  delete u.reset_token;
  delete u.reset_expires;
  delete u.reset_token;
  delete u.reset_expires;
  try { u.skills = JSON.parse(u.skills || "[]"); } catch { u.skills = []; }
  return u;
}
function notifyUser(userId, title, message, type = "system", link = null) {
  try {
    db.prepare("INSERT INTO notifications(user_id,title,message,type,link) VALUES(?,?,?,?,?)").run(userId, title, message, type, link);
    sendToUser(userId, { type: "notification", notification: { title, message, type, link, created_at: new Date().toISOString() } });
  } catch(e) { console.error("Notification error:", e); }
  try { mailService.notify(userId, { title, message, type, link }); } catch(e) { console.error("Email notify error:", e.message); }
}
function auditLog(admin, action, entity, entityId, detail) {
  try { db.prepare("INSERT INTO audit_log(actor_id,actor_name,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)")
    .run(admin.id, admin.name, action, entity, String(entityId ?? ""), detail ? JSON.stringify(detail) : null, ctxIp || null); } catch (e) { console.error("audit error", e.message); }
}
function notifyAdmins(title, message, type = "admin", link = null) {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach(a => notifyUser(a.id, title, message, type, link));
  } catch(e) { console.error("Admin notification error:", e); }
}
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
function userIdForToken(token) {
  if (!token) return null;
  const h = hashToken(token);
  const row = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash=?").get(h);
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(h); return null; }
  return row.user_id;
}
function extractToken(req) {
  const auth = req.headers && req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  return parseCookies(req.headers && req.headers.cookie).servinear_session || null;
}
function getSession(req) {
  const token = extractToken(req);
  const userId = userIdForToken(token);
  if (!userId) return null;
  db.prepare("UPDATE sessions SET expires_at=? WHERE token_hash=?").run(Date.now() + SESSION_TTL * 1000, hashToken(token));
  const u = currentUser(userId);
  return u && u.status !== "suspended" ? u : null;
}
function ensureWallet(userId) {
  db.prepare("INSERT OR IGNORE INTO wallets(user_id, balance, locked_escrow) VALUES(?,0,0)").run(userId);
}

function generateAIResponse(query, vectorMatches = [], user = null) {
  const q = String(query || "").toLowerCase();
  const isBangla = /[\u0980-\u09FF]/.test(query);

  const isHowToPost = q.includes("post") || q.includes("পোস্ট") || q.includes("কাজ") || q.includes("হায়ার") || q.includes("hire");
  const isNid = q.includes("nid") || q.includes("verify") || q.includes("ভেরিফাই") || q.includes("পরিচয়") || q.includes("জাতীয়");
  const isPayment = q.includes("escrow") || q.includes("এসক্রো") || q.includes("টাকা") || q.includes("payment") || q.includes("bkash") || q.includes("বিকাশ") || q.includes("nagad") || q.includes("নগদ") || q.includes("নিরাপদ");
  const isHelp = q.includes("helpline") || q.includes("help") || q.includes("সাহায্য") || q.includes("হেল্প") || q.includes("যোগাযোগ") || q.includes("contact");

  let replyText = "";
  let suggestedActions = [];

  if (isNid) {
    if (isBangla) {
      replyText = "**🛡️ ServiNear NID ভেরিফিকেশন নির্দেশিকা:**\n\n১. প্রোফাইলে গিয়ে **\"Get Verified (NID)\"** বাটনে ক্লিক করুন।\n২. আপনার জাতীয় পরিচয়পত্রের সামনের ও পেছনের স্পষ্ট ছবি এবং NID হাতে নিয়ে একটি সেলফি আপলোড করুন।\n৩. অ্যাডমিন ২ ঘণ্টার মধ্যে যাচাই করে প্রোফাইলে **\"100% ID Verified Trades\"** ট্রাস্ট ব্যাজ যুক্ত করে দেবে।";
    } else {
      replyText = "**🛡️ ServiNear NID Verification Guide:**\n\n1. Go to your Profile and click **\"Get Verified (NID)\"**.\n2. Upload 3 photos: NID Front, NID Back, and a Selfie holding your NID.\n3. Our admin team reviews and grants the **100% ID Verified** badge within 2 hours.\n\n*Verified workers get 4x more customer bookings!*";
    }
    suggestedActions.push({ label: isBangla ? "NID আবেদন করুন" : "Apply for NID", action: "open_nid" });
  } else if (isPayment) {
    if (isBangla) {
      replyText = "**💰 নিরাপদ এসক্রো ও জিরো প্ল্যাটফর্ম ফি:**\n\n১. **এসক্রো নিরাপত্তা:** কারিগরের বিড গ্রহণ করলে টাকা ServiNear এসক্রো ভল্টে জমা থাকে, সরাসরি কারিগরের হাতে যায় না।\n২. **রিলিজ OTP:** কাজের অর্ডার নিশ্চিত হলে আপনি একটি **৬ ডিজিটের রিলিজ কোড (OTP)** পাবেন।\n৩. **কাজ শেষে রিলিজ:** কারিগর বাসায় এসে কাজ সম্পন্ন করার পর আপনি যাচাই করে কারিগরকে সেই OTP দিলে টাকা কারিগরের ওয়ালেটে ট্রান্সফার হয়।\n\n*গ্রাহকদের জন্য সম্পূর্ণ ০% কমিশন!*";
    } else {
      replyText = "**💰 Safe Escrow & Zero Platform Markup:**\n\n1. **Escrow Protection:** When you accept a bid, funds are deposited into ServiNear's protected Escrow vault.\n2. **Completion OTP:** You immediately receive a **6-digit Release OTP**.\n3. **Inspection & Release:** When work is complete on-site, share the 6-digit OTP with the technician to release the funds.\n\n*Zero platform markup for clients. 100% safe with simulated bKash/Nagad checkout!*";
    }
    suggestedActions.push({ label: isBangla ? "ওয়ালেট দেখুন" : "View Wallet", action: "open_wallet" });
  } else if (isHowToPost) {
    if (isBangla) {
      replyText = "**⚡ কীভাবে কাজ পোস্ট করবেন:**\n\n১. হেডার থেকে **\"+ Post task\"** বাটনে ক্লিক করুন।\n২. কাজের ক্যাটাগরি (এসি, ইলেক্ট্রিক্যাল, প্লাম্বিং ইত্যাদি) সিলেক্ট করুন।\n৩. আপনার এলাকা (যেমন: ধানমন্ডি, মিরপুর ১০, উত্তরা) এবং আনুমানিক বাজেট লিখুন।\n৪. কয়েক মিনিটের মধ্যে বিশ্বস্ত কারিগররা তাদের সর্বনিম্ন অফার পাঠাবে।\n৫. প্রোফাইল ও রিভিউ দেখে সরাসরি চ্যাট করে অফার একসেপ্ট করুন।";
    } else {
      replyText = "**⚡ How to Post a Task on ServiNear:**\n\n1. Click the **\"+ Post task\"** button on the header.\n2. Select your category (e.g. Electrical, Appliances, Plumbing, IT).\n3. Enter your area (e.g. Dhanmondi, Mirpur, Uttara) and budget in BDT.\n4. Verified local tradesmen will send competing bids within minutes.\n5. Review ratings, chat directly, and accept with 1-click escrow protection!";
    }
    suggestedActions.push({ label: isBangla ? "+ কাজ পোস্ট করুন" : "+ Post a Task", action: "open_post" });
  } else if (isHelp) {
    if (isBangla) {
      replyText = "**📞 ServiNear ২৪/৭ হেল্পলাইন:**\n\n- **হটলাইন:** +880 1711-000001 (সকাল ৯টা - রাত ৯টা)\n- **ইমেইল:** support@servinear.local\n- **অফিস:** বনানী রোড ১১, ঢাকা ১২১৩\n- যেকোনো অভিযোগ বা সহযোগিতায় হেল্পলাইন থেকে সাপোর্ট টিকিট পাঠাতে পারেন।";
    } else {
      replyText = "**📞 ServiNear 24/7 Helpline & Support:**\n\n- **Hotline:** +880 1711-000001 (9 AM - 9 PM daily)\n- **Email:** support@servinear.local\n- **Office:** Road 11, Banani, Dhaka 1213\n- You can also submit an instant ticket via the Help page.";
    }
    suggestedActions.push({ label: isBangla ? "হেল্পলাইন দেখুন" : "Support Helpline", action: "open_help" });
  } else {
    let recsText = "";
    if (vectorMatches && vectorMatches.length > 0) {
      const topMatch = vectorMatches[0];
      if (isBangla) {
        recsText = `\n\n🎯 **প্রাসঙ্গিক সার্ভিস:** ${topMatch.title} (${topMatch.category}) - এলাকা: ${topMatch.area || "ঢাকা"}`;
      } else {
        recsText = `\n\n🎯 **Matching service:** ${topMatch.title} (${topMatch.category}) - Area: ${topMatch.area || "Dhaka"}`;
      }
    }
    if (isBangla) {
      replyText = `ধন্যবাদ! ServiNear AI অ্যাসিস্ট্যান্ট আপনাকে স্বাগতম জানাচ্ছে। আপনি কি কোনো নির্দিষ্ট কারিগর খুঁজছেন, নাকি নতুন কোনো কাজ পোস্ট করতে চান?${recsText}\n\nআমাকে নির্দ্বিধায় প্রশ্ন করতে পারেন!`;
    } else {
      replyText = `Thank you for reaching out! ServiNear is your verified community network for reliable local help.${recsText}\n\nFeel free to ask about hiring, pricing, or posting a new task!`;
    }
    suggestedActions.push({ label: isBangla ? "+ কাজ পোস্ট করুন" : "+ Post Task", action: "open_post" });
    suggestedActions.push({ label: isBangla ? "ক্যাটাগরি সমূহ" : "All Categories", action: "browse" });
  }

  return {
    ok: true,
    reply: replyText,
    language: isBangla ? "bn" : "en",
    suggested_actions: suggestedActions,
    matches: vectorMatches.slice(0, 2)
  };
}

function requireUser(user,roles=[]) { if(!user)fail(401,"Sign in to continue."); if(roles.length&&!roles.includes(user.role))fail(403,"This action is not available for your account."); }
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let data="";
    req.on("data",chunk=>{data+=chunk;if(data.length>15000000){reject(Object.assign(new Error("That request is too large."),{status:413}));req.destroy();}});
    req.on("end",()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(Object.assign(new Error("Please send valid JSON."),{status:400}));}});
    req.on("error",reject);
  });
}
function readForm(req) {
  return new Promise((resolve,reject)=>{
    let data="";
    req.on("data",chunk=>{data+=chunk;if(data.length>200000){reject(Object.assign(new Error("That request is too large."),{status:413}));req.destroy();}});
    req.on("end",()=>{try{resolve(Object.fromEntries(new URLSearchParams(data)));}catch{resolve({});}});
    req.on("error",reject);
  });
}
function coordinates(body) {
  const lat=body.latitude===undefined||body.latitude===null?null:Number(body.latitude);
  const lng=body.longitude===undefined||body.longitude===null?null:Number(body.longitude);
  if((lat!==null&&(!Number.isFinite(lat)||lat < -90||lat > 90))||(lng!==null&&(!Number.isFinite(lng)||lng < -180||lng > 180))||(lat===null)!==(lng===null))fail(400,"Those location coordinates are invalid.");
  return {lat,lng};
}
function publicWorkers() {
  const workers = db.prepare(`SELECT u.id,u.name,u.username,u.avatar_photo,u.profession_icon,u.skills,u.area,u.city,u.category,u.bio,u.rate,u.experience,u.latitude,u.longitude,u.verified,u.availability,
    ROUND(AVG(r.rating),1) AS rating,COUNT(r.id) AS reviews FROM users u LEFT JOIN reviews r ON r.worker_id=u.id
    WHERE u.role='worker' AND u.status='active' GROUP BY u.id ORDER BY u.verified DESC,u.name`).all();
  return workers.map((w) => {
    try { w.skills = JSON.parse(w.skills || "[]"); } catch { w.skills = []; }
    return w;
  });
}
function publicJobs(user) {
  const userId=user?.id||-1;
  const role=user?.role||"guest";
  const jobs=db.prepare(`SELECT j.id,j.title,j.category,j.details,j.area,j.budget,j.status,j.created_at,j.customer_id,
    u.name AS customer_name,COUNT(DISTINCT o.id) AS offer_count,
    CASE WHEN j.customer_id=? OR (?='worker' AND EXISTS(SELECT 1 FROM offers a WHERE a.job_id=j.id AND a.worker_id=? AND a.status='accepted')) OR ?='admin'
      THEN COALESCE(j.contact_phone,u.phone) ELSE NULL END AS contact_phone,
    CASE WHEN j.customer_id=? OR (?='worker' AND EXISTS(SELECT 1 FROM offers a WHERE a.job_id=j.id AND a.worker_id=? AND a.status='accepted')) OR ?='admin'
      THEN COALESCE(j.exact_address,u.address) ELSE NULL END AS exact_address
    FROM jobs j JOIN users u ON u.id=j.customer_id LEFT JOIN offers o ON o.job_id=j.id
    WHERE j.status IN ('open','accepted','completed','cancelled') GROUP BY j.id ORDER BY j.created_at DESC`).all(userId,role,userId,role,userId,role,userId,role);
  let offers=[];
  if(user?.role==="customer") offers=db.prepare(`SELECT o.id,o.job_id,o.worker_id,o.price,o.message,o.status,o.created_at,w.name AS worker_name,w.verified AS worker_verified,
    EXISTS(SELECT 1 FROM reviews r WHERE r.job_id=o.job_id) AS reviewed FROM offers o JOIN users w ON w.id=o.worker_id JOIN jobs j ON j.id=o.job_id WHERE j.customer_id=?`).all(user.id);
  if(user?.role==="worker") offers=db.prepare(`SELECT o.id,o.job_id,o.worker_id,o.price,o.message,o.status,o.created_at,w.name AS worker_name,w.verified AS worker_verified,
    EXISTS(SELECT 1 FROM reviews r WHERE r.job_id=o.job_id) AS reviewed FROM offers o JOIN users w ON w.id=o.worker_id WHERE o.worker_id=?`).all(user.id);
  if(user?.role==="admin") offers=db.prepare(`SELECT o.id,o.job_id,o.worker_id,o.price,o.message,o.status,o.created_at,w.name AS worker_name,w.verified AS worker_verified,
    EXISTS(SELECT 1 FROM reviews r WHERE r.job_id=o.job_id) AS reviewed FROM offers o JOIN users w ON w.id=o.worker_id`).all();
  return {jobs,offers};
}
function sessionCookie(token, maxAge = SESSION_TTL) {
  const crossSite = Boolean(WEB_ORIGIN && !WEB_ORIGIN.includes("localhost"));
  const sameSite = crossSite ? "None" : "Lax";
  const secure = crossSite || process.env.NODE_ENV === "production" ? "; Secure" : "";
  const domain = COOKIE_DOMAIN ? `; Domain=${COOKIE_DOMAIN}` : "";
  return `servinear_session=${token}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${domain}${secure}`;
}
let ctxIp = null, ctxUa = null;
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at,ip,user_agent) VALUES(?,?,?,?,?,?)")
    .run(hashToken(token), userId, Date.now() + SESSION_TTL * 1000, Date.now(), ctxIp || null, String(ctxUa || "").slice(0, 200));
  db.prepare("UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?").run(userId);
  return { token, cookie: sessionCookie(token, SESSION_TTL) };
}
function setSession(userId) {
  return createSession(userId).cookie;
}
function validateText(value,label,min,max) {
  const text=String(value||"").trim();
  if(text.length<min||text.length>max)fail(400,`${label} must be ${min} to ${max} characters.`);
  return text;
}
function categoryExists(category) { return Boolean(db.prepare("SELECT id FROM categories WHERE name=? COLLATE NOCASE").get(category)); }

// Confirms a payment server-to-server and credits the wallet exactly once.
async function settlePayment(tranId,kind,form) {
  const row=db.prepare("SELECT * FROM payments WHERE tran_id=?").get(tranId);
  if(!row) return {status:"failed"};
  if(row.status==="paid"||row.status==="review") return {status:row.status==="paid"?"success":"review",offer_id:row.offer_id};
  if(kind==="cancel"){db.prepare("UPDATE payments SET status='cancelled' WHERE tran_id=? AND status='pending'").run(tranId);return {status:"cancelled"};}
  if(kind==="fail"){db.prepare("UPDATE payments SET status='failed' WHERE tran_id=? AND status='pending'").run(tranId);return {status:"failed"};}
  // success / ipn: never trust the posted fields; ask the gateway.
  const valId=String(form.val_id||"");
  if(!valId) return {status:"failed"};
  let v;
  try { v=await gateway.validate({valId,tranId,amount:row.amount}); }
  catch(e){ console.error("Payment validation error:",e.message); return {status:"pending",offer_id:row.offer_id}; } // IPN/retry can still settle it
  if(!v.valid){ db.prepare("UPDATE payments SET status='failed' WHERE tran_id=? AND status='pending'").run(tranId); return {status:"failed"}; }
  const risky=v.riskLevel===1;
  db.exec("BEGIN IMMEDIATE");
  try {
    const moved=db.prepare("UPDATE payments SET status=?,val_id=?,bank_tran_id=?,method=?,risk_level=?,paid_at=CURRENT_TIMESTAMP WHERE tran_id=? AND status='pending'")
      .run(risky?"review":"paid",valId,v.bankTranId,v.method,v.riskLevel,tranId).changes;
    if(moved&&!risky){
      ensureWallet(row.user_id);
      db.prepare("UPDATE wallets SET balance=balance+? WHERE user_id=?").run(row.amount,row.user_id);
      db.prepare("INSERT INTO transactions(user_id,type,amount,payment_method,trx_id,details) VALUES(?,?,?,?,?,?)")
        .run(row.user_id,"deposit",row.amount,v.method||gateway.provider,v.bankTranId||tranId,`Wallet top-up (${tranId})`);
    }
    db.exec("COMMIT");
    if(moved&&!risky) notifyUser(row.user_id,"Payment received",`৳${row.amount} was added to your ServiNear wallet.`,"wallet","/profile");
    if(moved&&risky) notifyAdmins?.("Payment held for review",`Payment ${tranId} (৳${row.amount}) was flagged risky by the gateway.`,"wallet","/admin");
  } catch(e){ db.exec("ROLLBACK"); throw e; }
  return {status:risky?"review":"success",offer_id:row.offer_id};
}
const { createAdminApi } = require("./lib/admin");
const adminApi = createAdminApi({ db, send, fail, requireUser, readBody, notifyUser, vectors, ensureWallet, email: mailService });
async function handleApi(req,res,url) {
  const user=getSession(req);
  if (url.pathname.startsWith("/api/admin/") && (await adminApi(req,res,url,user,ctxIp)) !== false) return;
  if(req.method==="GET"&&url.pathname==="/api/health")return send(res,200,{ok:true,database:"connected",app:"ServiNear"});
  if(req.method==="GET"&&url.pathname==="/api/bootstrap") {
    const data=publicJobs(user);
    const notifications = user ? db.prepare("SELECT id,title,message,type,link,read,created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(user.id) : [];
    const unreadNotifications = user ? db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read=0").get(user.id).count : 0;
    const unreadMessages = user ? db.prepare("SELECT COUNT(*) AS count FROM messages WHERE recipient_id=? AND read=0").get(user.id).count : 0;
    const savedCount = user ? db.prepare("SELECT COUNT(*) AS count FROM saved_posts WHERE user_id=?").get(user.id).count : 0;
    return send(res,200,{user,workers:publicWorkers(),categories:db.prepare("SELECT name,description FROM categories ORDER BY id").all(),notifications,unreadNotifications,unreadMessages,savedCount,...data});
  }
    if(req.method==="GET"&&url.pathname==="/api/categories") {
    return send(res,200,db.prepare("SELECT name,description FROM categories ORDER BY id").all());
  }
  if(req.method==="GET"&&url.pathname==="/api/workers") {
    return send(res,200,publicWorkers());
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/login") {
    const body=await readBody(req);const email=String(body.email||"").trim().toLowerCase();
    const lim=limiter.hit("login:"+ctxIp+":"+email,8,15*60*1000);
    if(!lim.allowed){res.setHeader("Retry-After",lim.retryAfter);fail(429,"Too many sign-in attempts. Please wait a few minutes and try again.");}
    const record=db.prepare("SELECT id,password_hash,status FROM users WHERE email=?").get(email);
    if(!record||!(await checkPasswordAsync(String(body.password||""),record.password_hash)))fail(401,"Email or password is incorrect.");
    if(record.status==="suspended")fail(403,"This account has been suspended. Please contact support.");
    const sess = createSession(record.id); return send(res,200,{user:currentUser(record.id),token:sess.token},{"Set-Cookie":sess.cookie});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/logout") {
    const token = extractToken(req); if(token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hashToken(token));
    return send(res,200,{ok:true},{"Set-Cookie":sessionCookie("", 0)});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/register") {
    const body=await readBody(req);
    const firstName=String(body.first_name||"").trim();
    const surname=String(body.surname||"").trim();
    const computedName = (firstName && surname ? `${firstName} ${surname}` : String(body.name || "")).trim();
    const name=validateText(computedName,"Name",2,80);
    const email=String(body.email||"").trim().toLowerCase();
    const password=String(body.password||"");
    const role=body.role==="worker"?"worker":"customer";
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>180)fail(400,"Enter a valid email address.");
    if(password.length<8||password.length>200)fail(400,"Use a password with at least 8 characters.");
    const phone=String(body.phone||"").trim().slice(0,30)||null;
    const city=String(body.city||body.area||"Dhaka").trim();
    const area=validateText(city,"City / Area",2,120);
    const address=String(body.address||"").trim().slice(0,220)||null;
    const gender=String(body.gender||"").trim().slice(0,30)||null;
    const occupation=String(body.occupation||"").trim().slice(0,80)||null;
    const category=role==="worker"?validateText(body.category||occupation||"Handyman","Service category",2,60):null;
    const bio=role==="worker"?String(body.bio||"").trim().slice(0,500):null;
    const rate=role==="worker"?Math.max(1,Math.min(1000000,Number(body.rate)||500)):null;
    const position=role==="worker"?coordinates(body):{lat:null,lng:null};
    try {
      const result=db.prepare(`INSERT INTO users(name,first_name,surname,email,password_hash,role,gender,city,occupation,phone,area,address,category,bio,rate,latitude,longitude)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(name,firstName||null,surname||null,email,await passwordHashAsync(password),role,gender,city,occupation,phone,area,address,category,bio,rate,position.lat,position.lng);
      const id=Number(result.lastInsertRowid);
      notifyUser(id, "Welcome to ServiNear!", "Your account is created. Explore local verified helpers and post your first task.", "system");
      if(role==="worker")indexWorker(db.prepare("SELECT * FROM users WHERE id=?").get(id));
      try { mailService.sendVerification(db.prepare("SELECT id,name,email,email_verified FROM users WHERE id=?").get(id)); } catch(e) { console.error("Verification email error:", e.message); }
      const sess = createSession(id); return send(res,201,{user:currentUser(id),token:sess.token},{"Set-Cookie":sess.cookie});
    } catch(error) {if(String(error.message).includes("UNIQUE"))fail(409,"An account with that email already exists.");throw error;}
  }
  if(req.method==="GET"&&url.pathname==="/api/config") {
    let firebaseConfig = null;
    try {
      if (process.env.FIREBASE_CONFIG) {
        firebaseConfig = typeof process.env.FIREBASE_CONFIG === "string" ? JSON.parse(process.env.FIREBASE_CONFIG) : process.env.FIREBASE_CONFIG;
      } else if (process.env.FIREBASE_PROJECT_ID) {
        firebaseConfig = {
          apiKey: process.env.FIREBASE_API_KEY || "",
          authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
          projectId: process.env.FIREBASE_PROJECT_ID,
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`,
          messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
          appId: process.env.FIREBASE_APP_ID || ""
        };
      }
    } catch {}

    const googleEnabled = Boolean(GOOGLE_CLIENT_ID || firebaseConfig) || (!IS_PROD && process.env.GOOGLE_AUTH_MOCK === "1");
    return send(res,200,{
      googleClientId: GOOGLE_CLIENT_ID || null,
      firebaseConfig: firebaseConfig || null,
      googleEnabled,
      demo: SEED_DEMO,
      phoneVerification: sms.configured,
      requirePhone: REQUIRE_PHONE,
      payments: gateway.enabled ? gateway.provider : null,
      emailEnabled: mailer.configured,
      minTopup: MIN_TOPUP,
      maxTopup: MAX_TOPUP
    });
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/google") {
    const lim=limiter.hit("google:"+ctxIp,20,15*60*1000);
    if(!lim.allowed){res.setHeader("Retry-After",lim.retryAfter);fail(429,"Too many attempts. Please try again shortly.");}
    const body=await readBody(req);
    let g;
    try { g=await verifyGoogleIdToken(body.credential,GOOGLE_CLIENT_ID); }
    catch(error){ if(error.status)throw error; console.error("Google verify error:",error.message); fail(401,"Google could not verify this sign-in."); }
    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const isAdminOwner = Boolean(adminEmail && g.email === adminEmail);

    let rec=db.prepare("SELECT id,role,status FROM users WHERE google_id=?").get(g.sub)||db.prepare("SELECT id,role,status FROM users WHERE email=?").get(g.email);
    if(rec){
      if(rec.status==="suspended")fail(403,"This account has been suspended. Please contact support.");
      if(rec.role==="admin"&&process.env.GOOGLE_ALLOW_ADMIN!=="1"&&!isAdminOwner)fail(403,"Administrators must sign in with their password.");
      const targetRole = (isAdminOwner || rec.role === "admin") ? "admin" : rec.role;
      db.prepare("UPDATE users SET role=?, google_id=?, avatar_url=COALESCE(avatar_url,?), email_verified=1 WHERE id=?").run(targetRole,g.sub,g.picture,rec.id);
      const sess = createSession(rec.id); return send(res,200,{user:currentUser(rec.id),token:sess.token},{"Set-Cookie":sess.cookie});
    }
    const role=isAdminOwner ? "admin" : (body.role==="worker"?"worker":"customer");
    const dummy=await passwordHashAsync(crypto.randomBytes(24).toString("hex"));
    const result=db.prepare(`INSERT INTO users(name,email,password_hash,google_id,avatar_url,role,area,availability,email_verified)
      VALUES(?,?,?,?,?,?,'Dhaka','Available',1)`).run(String(g.name).slice(0,80),g.email,dummy,g.sub,g.picture,role);
    const id=Number(result.lastInsertRowid);
    notifyUser(id,"Welcome to ServiNear!","Your account is connected with Google.","system");
    if(role==="worker")indexWorker(db.prepare("SELECT * FROM users WHERE id=?").get(id));
    const sess = createSession(id); return send(res,201,{user:currentUser(id),token:sess.token},{"Set-Cookie":sess.cookie});
  }
  // Password reset: the code is only ever delivered by email, never returned to the caller.
  if(req.method==="POST"&&url.pathname==="/api/auth/forgot-password") {
    const body=await readBody(req);
    return send(res,200,mailService.requestReset(body.email,ctxIp));
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/reset-password") {
    const body=await readBody(req);
    await mailService.confirmReset(body.email,body.code||body.token,body.password||body.new_password,ctxIp);
    return send(res,200,{ok:true,message:"Password updated. Please sign in with your new password."});
  }

  if(req.method==="POST"&&url.pathname==="/api/auth/change-password") {
    requireUser(user);
    const rl=limiter.hit("chgpw:"+user.id,5,15*60*1000);
    if(!rl.allowed){res.setHeader("Retry-After",rl.retryAfter);fail(429,"Too many attempts. Please wait a few minutes.");}
    const body=await readBody(req);
    const current=String(body.current_password||""), next=String(body.new_password||"");
    if(next.length<8) fail(400,"New password must be at least 8 characters.");
    if(next===current) fail(400,"Choose a password that is different from your current one.");
    const rec=db.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id);
    if(!(await checkPasswordAsync(current,rec.password_hash))) fail(400,"Your current password is incorrect.");
    const hash=await passwordHashAsync(next);
    const token = extractToken(req);
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash,user.id);
    db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(user.id,token?hashToken(token):"");
    try { mailService.enqueue({userId:user.id,to:user.email,kind:"password_changed",category:"transactional",data:{name:user.name,when:new Date().toUTCString(),url:appBase()+"/"}}); } catch(e) { console.error("Password-changed email error:",e.message); }
    return send(res,200,{ok:true,message:"Password updated. Other devices were signed out."});
  }

  // --- Email: address verification, unsubscribe ---
  if(req.method==="GET"&&url.pathname==="/api/email/verify") {
    const ok=mailService.verifyToken(url.searchParams.get("token"));
    res.writeHead(302,{Location:`${appBase()}/profile?email=${ok?"verified":"invalid"}`,"Cache-Control":"no-store"});return res.end();
  }
  if(req.method==="POST"&&url.pathname==="/api/email/resend-verification") {
    requireUser(user);
    if(user.email_verified) return send(res,200,{ok:true,already_verified:true});
    if(!mailer.configured) fail(503,"Email is not available right now.");
    const rl=limiter.hit("verify-resend:"+user.id,3,3600*1000);
    if(!rl.allowed) fail(429,"You can request up to 3 confirmation emails per hour. Please check your inbox and spam folder.");
    mailService.sendVerification(db.prepare("SELECT id,name,email,email_verified FROM users WHERE id=?").get(user.id));
    return send(res,200,{ok:true});
  }
  if(url.pathname==="/api/email/unsubscribe"&&(req.method==="GET"||req.method==="POST")) {
    const form=req.method==="POST"?await readForm(req):{};
    const uid=url.searchParams.get("u")||form.u, tok=url.searchParams.get("t")||form.t;
    const page=(status,title,body)=>{res.writeHead(status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f1e8;color:#17242a;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #e4dccb;border-radius:16px;padding:32px;max-width:420px;margin:16px}h1{font-size:22px;margin:0 0 10px}button{width:100%;padding:13px;border:0;border-radius:10px;background:#0e6b5c;color:#fff;font:700 15px system-ui;cursor:pointer;margin-top:14px}a{color:#0e6b5c}</style><main>${body}</main>`);};
    if(!uid||!tok||!mailService.checkUnsub(uid,tok)) return page(400,"Invalid link","<h1>This link isn't valid</h1><p>It may be incomplete. You can change email preferences any time in <b>Profile &rarr; Settings</b>.</p>");
    // GET only asks for confirmation (mail scanners pre-fetch links); POST, including RFC 8058 one-click, performs the change.
    if(req.method==="GET") return page(200,"Unsubscribe",`<h1>Stop non-essential emails?</h1><p>You'll no longer get offer, task and message emails. Security and payment emails will still be sent.</p><form method="POST" action="/api/email/unsubscribe"><input type="hidden" name="u" value="${Number(uid)}"><input type="hidden" name="t" value="${String(tok).replace(/[^A-Za-z0-9_-]/g,"")}"><button>Unsubscribe</button></form>`);
    mailService.unsubscribe(uid);
    return page(200,"Unsubscribed","<h1>You're unsubscribed</h1><p>We won't send you non-essential emails anymore. You can turn them back on any time in <b>Profile &rarr; Settings</b>.</p>");
  }

  if(req.method==="PATCH"&&url.pathname==="/api/profile") {
    requireUser(user);const body=await readBody(req);const name=validateText(body.name,"Name",2,80);const phone=validateText(body.phone,"Phone",5,30);const area=validateText(body.area,"Area",2,120);const address=String(body.address||"").trim().slice(0,220);
    const category=user.role==="worker"?validateText(body.category,"Service category",2,60):user.category;
    const bio=user.role==="worker"?String(body.bio||"").trim().slice(0,500):user.bio;
    const rate=user.role==="worker"?Math.max(1,Math.min(1000000,Number(body.rate)||500)):user.rate;
    db.prepare("UPDATE users SET name=?,phone=?,area=?,address=?,category=?,bio=?,rate=? WHERE id=?").run(name,phone,area,address,category,bio,rate,user.id);otp.resetIfChanged(user.id,phone);
    return send(res,200,{user:currentUser(user.id)});
  }
  if(req.method==="GET"&&url.pathname==="/api/jobs") {
    return send(res,200,publicJobs(user).jobs);
  }
  if(req.method==="POST"&&url.pathname==="/api/jobs") {
    requireUser(user,["customer"]);const body=await readBody(req);const title=validateText(body.title,"Job title",5,100);const category=validateText(body.category,"Category",2,60);
    const details=validateText(body.details,"Description",15,1500);const area=validateText(body.area,"Area",2,140);if(!categoryExists(category))fail(400,"Choose a listed service category.");
    const budget=body.budget?Number(body.budget):null;if(budget!==null&&(!Number.isInteger(budget)||budget<1||budget>10000000))fail(400,"Enter a valid budget in taka.");
    const phone=validateText(body.contact_phone||user.phone,"Contact phone",5,30);const address=validateText(body.exact_address||user.address,"Exact address",5,220);const point=coordinates(body);
    const result=db.prepare(`INSERT INTO jobs(customer_id,title,category,details,area,budget,contact_phone,exact_address,latitude,longitude)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(user.id,title,category,details,area,budget,phone,address,point.lat,point.lng);
    const newJobId = Number(result.lastInsertRowid);
    indexJob({ id: newJobId, title, category, details, area });
    return send(res,201,{id:newJobId,job:{id:newJobId,title,category,details,area,budget,status:"open"}});
  }
    if(req.method==="POST"&&url.pathname==="/api/offers") {
    requireUser(user,["worker"]);
    requirePhone(user);
    const body=await readBody(req);
    const jobId=Number(body.job_id);
    const price=Number(body.price);
    const message=validateText(body.message||"I am ready to help.","Offer message",5,500);
    if(!Number.isInteger(price)||price<1||price>10000000)fail(400,"Enter your offer in whole taka.");
    const job=db.prepare("SELECT id,status,customer_id FROM jobs WHERE id=?").get(jobId);
    if(!job||job.status!=="open")fail(409,"This task is no longer accepting bids.");
    if(job.customer_id===user.id)fail(403,"You cannot bid on your own task.");
    try {
      const result=db.prepare("INSERT INTO offers(job_id,worker_id,price,message) VALUES(?,?,?,?)").run(jobId,user.id,price,message);
      const offerId=Number(result.lastInsertRowid);
      notifyUser(job.customer_id, "New Offer Received", `${user.name} offered ৳${price} on your task.`, "offer", "/jobs");
      return send(res,201,{ok:true,id:offerId,offer:{id:offerId,job_id:jobId,worker_id:user.id,price,message}});
    } catch(error) {
      if(String(error.message).includes("UNIQUE"))fail(409,"You already bid on this task.");
      throw error;
    }
  }
  const offerMatch=url.pathname.match(/^\/api\/jobs\/(\d+)\/offers$/);
  if(req.method==="POST"&&offerMatch) {
    requireUser(user,["worker"]);if(!user.verified)fail(403,"Your provider profile needs verification before you can bid.");
    requirePhone(user);const jobId=Number(offerMatch[1]);const body=await readBody(req);const price=Number(body.price);const message=validateText(body.message,"Offer message",10,500);
    if(!Number.isInteger(price)||price<1||price>10000000)fail(400,"Enter your offer in whole taka.");
    const job=db.prepare("SELECT id,status,customer_id FROM jobs WHERE id=?").get(jobId);if(!job||job.status!=="open")fail(409,"This task is no longer accepting bids.");if(job.customer_id===user.id)fail(403,"You cannot bid on your own task.");
    try {
      const result=db.prepare("INSERT INTO offers(job_id,worker_id,price,message) VALUES(?,?,?,?)").run(jobId,user.id,price,message);
      notifyUser(job.customer_id, "New Offer Received", `${user.name} offered ৳${price} on your task.`, "offer", "/jobs");
      return send(res,201,{id:Number(result.lastInsertRowid)});
    }
    catch(error){if(String(error.message).includes("UNIQUE"))fail(409,"You already bid on this task.");throw error;}
  }
  const acceptMatch=url.pathname.match(/^\/api\/offers\/(\d+)\/accept$/);
  if(req.method==="POST"&&acceptMatch) {
    requireUser(user,["customer"]);
    requirePhone(user);
    const offerId=Number(acceptMatch[1]);
    const offer=db.prepare(`SELECT o.id,o.job_id,o.worker_id,o.price FROM offers o JOIN jobs j ON j.id=o.job_id
      WHERE o.id=? AND j.customer_id=? AND j.status='open' AND o.status='pending'`).get(offerId,user.id);
    if(!offer)fail(404,"That bid is no longer available.");

    const releaseOtp = String(crypto.randomInt(100000, 1000000));

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE offers SET status=CASE WHEN id=? THEN 'accepted' ELSE 'declined' END WHERE job_id=?").run(offerId,offer.job_id);
      db.prepare("UPDATE jobs SET status='accepted' WHERE id=?").run(offer.job_id);

      ensureWallet(user.id);
      ensureWallet(offer.worker_id);

      db.prepare(`INSERT INTO escrows(job_id, offer_id, customer_id, worker_id, amount, release_otp, status)
        VALUES(?,?,?,?,?,?,'held')
        ON CONFLICT(job_id) DO UPDATE SET
          offer_id=excluded.offer_id, worker_id=excluded.worker_id, amount=excluded.amount, release_otp=excluded.release_otp, status='held'`)
        .run(offer.job_id, offer.id, user.id, offer.worker_id, offer.price, releaseOtp);

      // The customer must actually hold the money: move it from spendable balance into escrow atomically.
      const hold = db.prepare("UPDATE wallets SET balance=balance-?, locked_escrow=locked_escrow+? WHERE user_id=? AND balance>=?").run(offer.price, offer.price, user.id, offer.price);
      if (!hold.changes) throw new Error("INSUFFICIENT_FUNDS");
      db.prepare("INSERT INTO transactions(user_id, type, amount, payment_method, details) VALUES(?,?,?,'Wallet Escrow',?)")
        .run(user.id, "escrow_hold", offer.price, `Escrow locked for Task #${offer.job_id}`);

      db.exec("COMMIT");
    } catch(error) {
      db.exec("ROLLBACK");
      if (error.message === "INSUFFICIENT_FUNDS") {
        if (!gateway.enabled) fail(503, "Online payments are not enabled yet, so this offer cannot be funded. Please try again soon.", { code: "payments_unavailable" });
        const bal = db.prepare("SELECT balance FROM wallets WHERE user_id=?").get(user.id)?.balance || 0;
        fail(402, `Add ৳${offer.price - bal} to your wallet to secure this task in escrow.`, { code: "insufficient_funds", shortfall: offer.price - bal, balance: bal, price: offer.price, offer_id: offerId });
      }
      throw error;
    }

    notifyUser(offer.worker_id, "Offer Accepted & Escrow Locked!", `Client secured ৳${offer.price} in ServiNear Escrow. Customer contact and address unlocked!`, "accepted", "/jobs");
    notifyUser(user.id, "Escrow Secured & Release OTP", `৳${offer.price} held safely in Escrow. Your 6-digit release OTP is: ${releaseOtp}. Provide to worker only after job completion.`, "escrow", "/jobs");

    return send(res,200,{ok:true,escrow:{amount:offer.price,release_otp:releaseOtp,status:"held"}});
  }
  // --- Job Completion Endpoint ---
  const completeMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/complete$/);
  if (req.method === "POST" && completeMatch) {
    requireUser(user, ["worker"]);
    const targetJobId = Number(completeMatch[1]);
    const result = db.prepare(`
      UPDATE jobs 
      SET status = 'completed' 
      WHERE id = ? 
        AND status = 'accepted'
        AND id IN (
          SELECT job_id 
          FROM offers 
          WHERE worker_id = ? 
            AND status = 'accepted'
        )
    `).run(targetJobId, user.id);

    if (!result.changes) {
      fail(404, "This accepted task is not assigned to your account.");
    }
    return send(res, 200, { ok: true });
  }
  // --- Customer Job Review Endpoint ---
  const reviewMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/review$/);
  if (req.method === "POST" && reviewMatch) {
    requireUser(user, ["customer"]);
    const jobId = Number(reviewMatch[1]);
    const body = await readBody(req);
    const rating = Number(body.rating);
    const comment = String(body.comment || "").trim().slice(0, 600);

    const job = db.prepare(`
      SELECT id, status 
      FROM jobs 
      WHERE id = ? AND customer_id = ?
    `).get(jobId, user.id);

    if (!job || job.status !== "completed") {
      fail(409, "Reviews are available after the job is complete.");
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      fail(400, "Choose a rating from 1 to 5.");
    }

    const offer = db.prepare(`
      SELECT worker_id 
      FROM offers 
      WHERE job_id = ? AND status = 'accepted'
    `).get(jobId);

    try {
      db.prepare(`
        INSERT INTO reviews (job_id, customer_id, worker_id, rating, comment)
        VALUES (?, ?, ?, ?, ?)
      `).run(jobId, user.id, offer.worker_id, rating, comment);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        fail(409, "You already reviewed this job.");
      }
      throw error;
    }
    return send(res, 201, { ok: true });
  }
  // --- Support / Helpdesk Ticket Submission ---
  if (req.method === "POST" && url.pathname === "/api/support") {
    const body = await readBody(req);
    const name = validateText(body.name || user?.name, "Name", 2, 80);
    const email = String(body.email || user?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fail(400, "Enter a valid email address.");
    }
    const subject = validateText(body.subject, "Subject", 4, 120);
    const message = validateText(body.message, "Message", 20, 2000);

    if (!limiter.hit("support:" + ctxIp, 5, 3600 * 1000).allowed) {
      fail(429, "Too many requests. Please try again later.");
    }

    const ticket = db.prepare(`
      INSERT INTO support_tickets (user_id, name, email, subject, message)
      VALUES (?, ?, ?, ?, ?)
    `).run(user?.id || null, name, email, subject, message);

    if (user && user.email === email) {
      mailService.enqueue({
        userId: user.id,
        to: email,
        kind: "ticket_received",
        category: "transactional",
        data: { name, subject, ticketId: Number(ticket.lastInsertRowid) }
      });
    }
    return send(res, 201, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/admin/summary") {
    requireUser(user, ["admin"]);
    const stats = {
      users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
      providers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'worker'").get().count,
      customers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'customer'").get().count,
      openJobs: db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'open'").get().count,
      pending: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'worker' AND verified = 0").get().count,
      tickets: db.prepare("SELECT COUNT(*) AS count FROM support_tickets WHERE status != 'resolved'").get().count
    };
    return send(res, 200, stats);
  }
  if(req.method==="GET"&&url.pathname==="/api/admin/support") {
    requireUser(user,["admin"]);return send(res,200,db.prepare("SELECT id,name,email,subject,message,status,created_at FROM support_tickets ORDER BY created_at DESC LIMIT 100").all());
  }
  const ticketMatch=url.pathname.match(/^\/api\/admin\/support\/(\d+)$/);
  if(req.method==="PATCH"&&ticketMatch) {
    requireUser(user,["admin"]);const body=await readBody(req);if(!["open","reviewing","resolved"].includes(body.status))fail(400,"Choose a valid support status.");
    const result=db.prepare("UPDATE support_tickets SET status=? WHERE id=?").run(body.status,Number(ticketMatch[1]));if(!result.changes)fail(404,"Support request not found.");auditLog(user,"ticket.status","ticket",ticketMatch[1],{status:body.status});return send(res,200,{ok:true});
  }
  const verifyMatch=url.pathname.match(/^\/api\/admin\/workers\/(\d+)\/verify$/);
  if(req.method==="PATCH"&&verifyMatch) {
    requireUser(user,["admin"]);const body=await readBody(req);const result=db.prepare("UPDATE users SET verified=? WHERE id=? AND role='worker'").run(body.verified?1:0,Number(verifyMatch[1]));if(!result.changes)fail(404,"Provider not found.");return send(res,200,{ok:true});
  }
  // --- NID Verification Endpoints ---
  if(req.method==="POST"&&(url.pathname==="/api/nid/apply"||url.pathname==="/api/user/nid/submit")) {
    requireUser(user);
    const body=await readBody(req);
    const front=String(body.nid_front||body.front||"").trim();
    const back=String(body.nid_back||body.back||"").trim();
    const selfie=String(body.selfie_nid||body.selfie||"").trim();
    if(!front||!back||!selfie)fail(400,"All 3 photos (NID front, NID back, and selfie holding NID) are required.");
    
    const existing = db.prepare("SELECT id, status FROM nid_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(user.id);
    if(existing && existing.status === 'pending') {
      db.prepare("UPDATE nid_verifications SET nid_front=?, nid_back=?, selfie_nid=?, created_at=CURRENT_TIMESTAMP WHERE id=?").run(front, back, selfie, existing.id);
    } else {
      db.prepare("INSERT INTO nid_verifications(user_id, nid_front, nid_back, selfie_nid) VALUES(?,?,?,?)").run(user.id, front, back, selfie);
    }
    notifyAdmins("New NID Verification", `${user.name} submitted NID photos for verification.`, "nid", "/admin");
    return send(res,200,{ok:true,status:'pending_review',message:"NID application submitted for review."});
  }
  if(req.method==="PATCH"&&url.pathname==="/api/admin/nid/verify") {
    requireUser(user,["admin"]);
    const body=await readBody(req);
    const targetUserId=Number(body.user_id);
    const action=body.action||"approve";
    const verified=action==="approve"?1:0;
    db.prepare("UPDATE users SET verified=? WHERE id=?").run(verified, targetUserId);
    db.prepare("UPDATE nid_verifications SET status=?, reviewed_at=CURRENT_TIMESTAMP WHERE user_id=? AND status='pending'").run(action==='approve'?'approved':'rejected', targetUserId);
    auditLog(user,"nid."+(action==='approve'?'approve':'reject'),"user",targetUserId);
    if(verified)notifyUser(targetUserId,"You are verified","Your NID verification was approved. The verified badge now shows on your profile.","system");
    return send(res,200,{ok:true,verified});
  }
  if(req.method==="GET"&&url.pathname==="/api/nid/status") {
    requireUser(user);
    const app = db.prepare("SELECT id, status, admin_notes, created_at, reviewed_at FROM nid_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(user.id);
    return send(res,200,{application: app || null, verified: Boolean(user.verified)});
  }
  // Admin: View submitted NID verification applications
  if (req.method === "GET" && url.pathname === "/api/admin/nid-applications") {
    requireUser(user, ["admin"]);
    const list = db.prepare(`
      SELECT 
        n.id, n.user_id, n.nid_front, n.nid_back, n.selfie_nid, 
        n.nid_front AS front_photo, n.nid_back AS back_photo, n.selfie_nid AS selfie_photo,
        n.status, n.admin_notes, n.created_at, n.reviewed_at,
        u.name, u.email, u.phone, 
        u.name AS user_name, u.email AS user_email, u.phone AS user_phone, 
        u.area, u.role, u.category, u.verified
      FROM nid_verifications n 
      JOIN users u ON u.id = n.user_id 
      ORDER BY 
        CASE WHEN n.status = 'pending' THEN 0 ELSE 1 END, 
        n.created_at DESC 
      LIMIT 50
    `).all();
    return send(res, 200, list);
  }
  const nidReviewMatch = url.pathname.match(/^\/api\/admin\/nid-applications\/(\d+)$/);
  if(req.method==="PATCH"&&nidReviewMatch) {
    requireUser(user,["admin"]);
    const appId = Number(nidReviewMatch[1]);
    const body = await readBody(req);
    const status = body.status === 'approved' ? 'approved' : 'rejected';
    const notes = String(body.notes || '').trim().slice(0, 300);
    const app = db.prepare("SELECT id, user_id FROM nid_verifications WHERE id=?").get(appId);
    if(!app)fail(404,"Application not found.");
    db.prepare("UPDATE nid_verifications SET status=?, admin_notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?").run(status, notes, appId);
    if(status === 'approved') {
      db.prepare("UPDATE users SET verified=1 WHERE id=?").run(app.user_id);
      notifyUser(app.user_id, "NID Verification Approved!", "Congratulations! Your identity is verified and the trust badge has been awarded to your profile.", "verification");
    } else {
      notifyUser(app.user_id, "NID Verification Review", `Your verification application was not approved: ${notes || 'Please resubmit clearer photos.'}`, "verification");
    }
    return send(res,200,{ok:true});
  }

  // --- Inbox & Chat Endpoints ---
    if(req.method==="GET"&&url.pathname==="/api/chat/messages") {
    requireUser(user);
    const peerId=Number(url.searchParams.get("peer_id")||url.searchParams.get("with"));
    const jobId=url.searchParams.get("job_id")?Number(url.searchParams.get("job_id")):null;
    if(!peerId) fail(400, "peer_id required");
    db.prepare("UPDATE messages SET read=1 WHERE recipient_id=? AND sender_id=? AND read=0").run(user.id, peerId);
    let sql = `SELECT m.id, m.sender_id, m.recipient_id, m.job_id, m.content, m.read, m.created_at,
      u.name as sender_name, u.role as sender_role
      FROM messages m JOIN users u ON u.id=m.sender_id
      WHERE ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?))`;
    const params = [user.id, peerId, peerId, user.id];
    if(jobId) {
      sql += " AND (m.job_id=? OR m.job_id IS NULL)";
      params.push(jobId);
    }
    sql += " ORDER BY m.created_at ASC";
    const messages = db.prepare(sql).all(...params);
    return send(res,200,{messages,ok:true});
  }
  if(req.method==="GET"&&url.pathname==="/api/messages") {
    requireUser(user);
    const withUserId = url.searchParams.get("with") ? Number(url.searchParams.get("with")) : null;
    if(withUserId) {
      // Mark received messages from this user as read
      db.prepare("UPDATE messages SET read=1 WHERE recipient_id=? AND sender_id=? AND read=0").run(user.id, withUserId);
      const thread = db.prepare(`SELECT m.id, m.sender_id, m.recipient_id, m.job_id, m.content, m.read, m.created_at,
        u.name as sender_name, u.role as sender_role
        FROM messages m JOIN users u ON u.id=m.sender_id
        WHERE (m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?)
        ORDER BY m.created_at ASC`).all(user.id, withUserId, withUserId, user.id);
      const recipient = currentUser(withUserId);
      return send(res,200,{messages: thread, recipient});
    } else {
      // Return conversations list with last message and unread count
      const contacts = db.prepare(`SELECT DISTINCT CASE WHEN sender_id=? THEN recipient_id ELSE sender_id END as contact_id
        FROM messages WHERE sender_id=? OR recipient_id=?`).all(user.id, user.id, user.id);
      const list = contacts.map(c => {
        const other = currentUser(c.contact_id);
        if(!other) return null;
        const lastMsg = db.prepare(`SELECT content, created_at, sender_id FROM messages
          WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)
          ORDER BY created_at DESC LIMIT 1`).get(user.id, other.id, other.id, user.id);
        const unread = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE sender_id=? AND recipient_id=? AND read=0`).get(other.id, user.id).count;
        return { user: other, last_message: lastMsg?.content || '', created_at: lastMsg?.created_at || '', unread };
      }).filter(Boolean).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
      return send(res,200,list);
    }
  }
  if(req.method==="POST"&&(url.pathname==="/api/messages"||url.pathname==="/api/chat/send")) {
    requireUser(user);
    const body=await readBody(req);
    const recipientId=Number(body.recipient_id);
    const content=validateText(body.content||body.message,"Message",1,1000);
    const jobId=body.job_id ? Number(body.job_id) : null;
    const recipient = db.prepare("SELECT id, name FROM users WHERE id=?").get(recipientId);
    if(!recipient)fail(404,"Recipient user not found.");
    if(recipient.id===user.id)fail(400,"You cannot message yourself.");
    const result=db.prepare("INSERT INTO messages(sender_id, recipient_id, job_id, content) VALUES(?,?,?,?)").run(user.id, recipientId, jobId, content);
    const msgId=Number(result.lastInsertRowid);
    notifyUser(recipientId, `New message from ${user.name}`, content.slice(0, 100), "chat", "/inbox");
    sendToUser(recipientId, { type: "chat_message", message: { id: msgId, sender_id: user.id, recipient_id: recipientId, job_id: jobId, content, created_at: new Date().toISOString() } });
    return send(res,201,{ok:true,id:msgId,message:{id:msgId,sender_id:user.id,recipient_id:recipientId,job_id:jobId,content}});
  }

  // --- Saved Posts (Bookmarks) Endpoints ---
  if(req.method==="GET"&&url.pathname==="/api/saved-posts") {
    requireUser(user);
    const saved = db.prepare("SELECT target_type, target_id, created_at FROM saved_posts WHERE user_id=? ORDER BY created_at DESC").all(user.id);
    const savedJobs = [];
    const savedWorkers = [];
    saved.forEach(s => {
      if(s.target_type === 'job') {
        const j = db.prepare("SELECT id, customer_id, title, category, details, area, budget, status, created_at FROM jobs WHERE id=?").get(s.target_id);
        if(j) savedJobs.push(j);
      } else if(s.target_type === 'worker') {
        const w = db.prepare("SELECT id, name, category, bio, rate, experience, area, verified, availability FROM users WHERE id=? AND role='worker'").get(s.target_id);
        if(w) savedWorkers.push(w);
      }
    });
    return send(res,200,{ok:true,jobs: savedJobs, workers: savedWorkers, posts: [...savedJobs, ...savedWorkers], total: saved.length});
  }
  if(req.method==="POST"&&url.pathname==="/api/saved-posts/toggle") {
    requireUser(user);
    const body=await readBody(req);
    const type=(body.target_type||body.type)==='worker'?'worker':'job';
    const id=Number(body.target_id||body.id);
    if(!id) fail(400, "Valid target ID required.");
    const existing = db.prepare("SELECT id FROM saved_posts WHERE user_id=? AND target_type=? AND target_id=?").get(user.id, type, id);
    if(existing) {
      db.prepare("DELETE FROM saved_posts WHERE id=?").run(existing.id);
      return send(res,200,{ok:true,saved:false});
    } else {
      db.prepare("INSERT INTO saved_posts(user_id, target_type, target_id) VALUES(?,?,?)").run(user.id, type, id);
      return send(res,200,{ok:true,saved:true});
    }
  }

  // --- Notifications Endpoints ---
  if(req.method==="GET"&&url.pathname==="/api/notifications") {
    requireUser(user);
    const list = db.prepare("SELECT id, title, message, type, link, read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50").all(user.id);
    const unread = db.prepare("SELECT COUNT(*) as count FROM notifications WHERE user_id=? AND read=0").get(user.id).count;
    return send(res,200,{notifications: list, unread});
  }
  const notifReadMatch = url.pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if(req.method==="PATCH"&&notifReadMatch) {
    requireUser(user);
    db.prepare("UPDATE notifications SET read=1 WHERE id=? AND user_id=?").run(Number(notifReadMatch[1]), user.id);
    return send(res,200,{ok:true});
  }
  if(req.method==="POST"&&url.pathname==="/api/notifications/read-all") {
    requireUser(user);
    db.prepare("UPDATE notifications SET read=1 WHERE user_id=?").run(user.id);
    return send(res,200,{ok:true});
  }

  // --- Vector Database Search & Stats Endpoints ---
  if(req.method==="GET"&&url.pathname==="/api/vector/search") {
    const vl=limiter.hit("vsearch:"+ctxIp,40,60*1000);
    if(!vl.allowed){res.setHeader("Retry-After",vl.retryAfter);fail(429,"Too many searches. Please slow down.");}
    const q=String(url.searchParams.get("q")||"").trim().slice(0,200);
    const type=url.searchParams.get("type")||"all";
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||20)));
    const lat=url.searchParams.has("lat")?Number(url.searchParams.get("lat")):null;
    const lng=url.searchParams.has("lng")?Number(url.searchParams.get("lng")):null;
    const start=Date.now();
    const found=await vectors.search({query:q,type,limit,lat,lng,category:url.searchParams.get("category")||null});
    return send(res,200,{query:q,total:found.results.length,took_ms:Date.now()-start,engine:found.engine,results:found.results});
  }
  if(req.method==="GET"&&url.pathname==="/api/vector/stats") {
    requireUser(user,["admin"]);
    return send(res,200,{...vectors.stats(),metric:"cosine (L2-normalised dot product)",status:"operational"});
  }

  // --- User Settings & Profile Customization Endpoints ---
  
  // --- AI Customer Care Chatbot Endpoint ---
  if(req.method==="POST"&&url.pathname==="/api/ai/chat") {
    const body=await readBody(req);
    const message=String(body.message||"").trim();
    if(!message) fail(400,"Message required.");
    const vectorMatches = vectorSearch(message, "all", 3);
    const result = generateAIResponse(message, vectorMatches, user);
    return send(res,200,result);
  }

  // --- Escrow Completion & OTP Release Endpoint ---
  const releaseMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/release-escrow$/);
  if(req.method==="POST"&&releaseMatch) {
    requireUser(user);
    const jobId = Number(releaseMatch[1]);
    const body = await readBody(req);
    const otp = String(body.otp||"").trim();
    const escrow = db.prepare("SELECT * FROM escrows WHERE job_id=? AND status='held'").get(jobId);
    if(!escrow) fail(404,"Active escrow record not found for this task.");
    if(user.id!==escrow.worker_id&&user.id!==escrow.customer_id) fail(403,"Only the customer or the provider on this task can release its escrow.");
    const rl=limiter.hit("release:"+escrow.id,5,30*60*1000);
    if(!rl.allowed){res.setHeader("Retry-After",rl.retryAfter);fail(429,"Too many wrong codes. Try again in "+Math.ceil(rl.retryAfter/60)+" minutes, or contact support.");}
    const okOtp=otp.length===escrow.release_otp.length&&crypto.timingSafeEqual(Buffer.from(otp),Buffer.from(escrow.release_otp));
    if(!okOtp) {
      fail(400,"Invalid 6-digit release OTP. Please ask the client for the correct completion OTP.");
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE escrows SET status='released', released_at=CURRENT_TIMESTAMP WHERE id=?").run(escrow.id);
      db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
      db.prepare("UPDATE wallets SET locked_escrow=MAX(0, locked_escrow-?) WHERE user_id=?").run(escrow.amount, escrow.customer_id);
      db.prepare("UPDATE wallets SET balance=balance+? WHERE user_id=?").run(escrow.amount, escrow.worker_id);

      db.prepare("INSERT INTO transactions(user_id, type, amount, payment_method, details) VALUES(?,?,?,'Escrow Release',?)")
        .run(escrow.worker_id, "escrow_release", escrow.amount, `Earnings credited from Task #${jobId}`);
      db.exec("COMMIT");
    } catch(err) {
      db.exec("ROLLBACK");
      throw err;
    }

    notifyUser(escrow.worker_id, "Earnings Released!", `৳${escrow.amount} has been added to your ServiNear balance.`, "wallet", "/profile");
    notifyUser(escrow.customer_id, "Task Completed & Escrow Settled", `Task #${jobId} completed. ৳${escrow.amount} released to technician.`, "completed", "/jobs");

    return send(res,200,{ok:true,amount:escrow.amount,status:"released"});
  }

  // --- Wallet & Transactions Endpoints ---
  // --- Phone verification (OTP) ---
  if(req.method==="POST"&&url.pathname==="/api/phone/request") {
    requireUser(user);
    const body=await readBody(req);
    return send(res,200,await otp.request(user,body.phone,ctxIp));
  }
  if(req.method==="POST"&&url.pathname==="/api/phone/verify") {
    requireUser(user);
    const body=await readBody(req);
    const result=otp.verify(user,body.code);
    notifyUser(user.id,"Mobile number verified","Your number is now verified. Thanks for helping keep ServiNear safe.","system");
    return send(res,200,{...result,user:currentUser(user.id)});
  }

  // --- Payments: wallet top-up through the gateway ---
  if(req.method==="POST"&&url.pathname==="/api/payments/create") {
    requireUser(user);
    requirePhone(user);
    if(!gateway.enabled) fail(503,"Online payments are not available right now.");
    const pl=limiter.hit("pay:"+user.id,10,3600*1000);
    if(!pl.allowed) fail(429,"Too many payment attempts. Please try again later.");
    const body=await readBody(req);
    const amount=Number(body.amount);
    if(!Number.isInteger(amount)||amount<MIN_TOPUP||amount>MAX_TOPUP) fail(400,`Enter a whole-taka amount between ৳${MIN_TOPUP} and ৳${MAX_TOPUP.toLocaleString()}.`);
    const offerId=Number.isInteger(Number(body.offer_id))?Number(body.offer_id):null;
    const tranId="SN"+Date.now().toString(36).toUpperCase()+crypto.randomBytes(4).toString("hex").toUpperCase();
    const base=publicApiUrl(req);
    const urls={base,success:`${base}/api/payments/${gateway.provider}/success`,fail:`${base}/api/payments/${gateway.provider}/fail`,cancel:`${base}/api/payments/${gateway.provider}/cancel`,ipn:`${base}/api/payments/${gateway.provider}/ipn`};
    db.prepare("INSERT INTO payments(tran_id,user_id,amount,offer_id,provider) VALUES(?,?,?,?,?)").run(tranId,user.id,amount,offerId,gateway.provider);
    let started;
    try { started=await gateway.init({tranId,amount,user,urls}); }
    catch(e){ db.prepare("UPDATE payments SET status='failed' WHERE tran_id=?").run(tranId); console.error("Payment init failed:",e.message); fail(502,"We couldn't start the payment. Please try again."); }
    db.prepare("UPDATE payments SET gateway_session=? WHERE tran_id=?").run(started.sessionKey,tranId);
    return send(res,200,{ok:true,tran_id:tranId,redirect_url:started.gatewayUrl,amount});
  }
  if(req.method==="GET"&&url.pathname==="/api/payments/status") {
    requireUser(user);
    const row=db.prepare("SELECT tran_id,amount,status,offer_id,created_at,paid_at FROM payments WHERE tran_id=? AND user_id=?").get(String(url.searchParams.get("tran_id")||""),user.id);
    if(!row) fail(404,"Payment not found.");
    return send(res,200,row);
  }
  const payCb=url.pathname.match(/^\/api\/payments\/(sslcommerz|mock)\/(success|fail|cancel|ipn)$/);
  if(payCb&&(req.method==="POST"||req.method==="GET")) {
    if(payCb[1]!==gateway.provider) fail(404,"Not found.");
    const form=req.method==="POST"?await readForm(req):Object.fromEntries(url.searchParams);
    const tranId=String(form.tran_id||"");
    const kind=payCb[2];
    const outcome=await settlePayment(tranId,kind,form);
    if(kind==="ipn") return send(res,200,{ok:true});
    const target=`${WEB_ORIGIN||""}/profile?payment=${outcome.status}&tran=${encodeURIComponent(tranId)}${outcome.offer_id?`&offer=${outcome.offer_id}`:""}`;
    res.writeHead(303,{Location:target,"Cache-Control":"no-store"});return res.end();
  }
  if(gateway.provider==="mock"&&url.pathname==="/api/payments/mock/checkout"&&req.method==="GET") {
    const t=String(url.searchParams.get("tran_id")||"");const sess=gateway.sessions.get(t);
    if(!sess) fail(404,"Unknown payment session.");
    const esc=(v)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const btn=(state,label,cls)=>`<form method="POST" action="${esc(sess.urls.base)}/api/payments/mock/pay"><input type="hidden" name="tran_id" value="${esc(t)}"><input type="hidden" name="state" value="${state}"><button class="${cls}">${label}</button></form>`;
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock payment</title><style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;background:#f4f1e8}main{background:#fff;padding:28px;border-radius:16px;max-width:360px;width:90%;text-align:center;box-shadow:0 20px 50px #0002}button{width:100%;margin:6px 0;padding:12px;border:0;border-radius:10px;font-weight:700;cursor:pointer}.p{background:#0e6b5c;color:#fff}.f{background:#bd4d2c;color:#fff}.c{background:#e5e0d0}</style><main><h2>Mock gateway</h2><p>Development only. Pay <b>৳${sess.amount}</b> to ServiNear.</p>${btn("paid","Pay now","p")}${btn("failed","Simulate failure","f")}${btn("cancelled","Cancel","c")}</main>`);
  }
  if(gateway.provider==="mock"&&url.pathname==="/api/payments/mock/pay"&&req.method==="POST") {
    const form=await readForm(req);
    const state=["paid","failed","cancelled"].includes(form.state)?form.state:"cancelled";
    const sess=gateway.complete(String(form.tran_id||""),state);
    if(!sess) fail(404,"Unknown payment session.");
    // Emulates the gateway redirecting the customer back with its result.
    const outcome=await settlePayment(String(form.tran_id),state==="paid"?"success":state==="failed"?"fail":"cancel",{val_id:sess.valId||""});
    res.writeHead(303,{Location:`${WEB_ORIGIN||""}/profile?payment=${outcome.status}&tran=${encodeURIComponent(form.tran_id)}${outcome.offer_id?`&offer=${outcome.offer_id}`:""}`,"Cache-Control":"no-store"});
    return res.end();
  }

  if(req.method==="GET"&&url.pathname==="/api/wallet") {
    requireUser(user);
    ensureWallet(user.id);
    const wallet = db.prepare("SELECT balance, locked_escrow FROM wallets WHERE user_id=?").get(user.id);
    const history = db.prepare("SELECT id, type, amount, payment_method, trx_id, details, created_at FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 20").all(user.id);
    const activeEscrows = db.prepare(`SELECT e.*, j.title as job_title FROM escrows e JOIN jobs j ON j.id=e.job_id
      WHERE (e.customer_id=? OR e.worker_id=?) AND e.status='held'`).all(user.id, user.id);
    return send(res,200,{ok:true,wallet,history,escrows:activeEscrows});
  }

  if(req.method==="POST"&&url.pathname==="/api/wallet/withdraw") {
    requireUser(user,["worker"]);
    requirePhone(user,true);
    const body = await readBody(req);
    const amount = Number(body.amount);
    const method = ["bKash","Nagad","Rocket"].includes(body.method)?body.method:"bKash";
    if(!Number.isInteger(amount)||amount<100) fail(400,"Minimum payout withdrawal is ৳100.");
    const dest = normalizeBdPhone(body.phone);
    const userPhone = normalizeBdPhone(user.phone);
    if (!dest || !userPhone || dest.e164 !== userPhone.e164) {
      fail(400, "For your security, payouts go only to your verified mobile number (" + user.phone + ").");
    }
    if(db.prepare("SELECT COUNT(*) AS c FROM payouts WHERE user_id=? AND status='pending'").get(user.id).c>=3) fail(429,"You already have 3 payouts waiting. Please wait for them to be processed.");

    ensureWallet(user.id);
    let payoutId;
    db.exec("BEGIN IMMEDIATE");
    try {
      const debit = db.prepare("UPDATE wallets SET balance=balance-? WHERE user_id=? AND balance>=?").run(amount, user.id, amount);
      if(!debit.changes){ db.exec("ROLLBACK"); fail(400,"Insufficient wallet balance."); }
      payoutId = Number(db.prepare("INSERT INTO payouts(user_id,amount,method,account) VALUES(?,?,?,?)").run(user.id, amount, method, dest.local).lastInsertRowid);
      db.prepare("INSERT INTO transactions(user_id, type, amount, payment_method, trx_id, details) VALUES(?,?,?,?,?,?)")
        .run(user.id, "withdrawal", amount, method, "PAYOUT-"+payoutId, `Payout request to ${method} (${dest.local}), awaiting processing`);
      db.exec("COMMIT");
    } catch(err) {
      try{db.exec("ROLLBACK");}catch{}
      throw err;
    }
    notifyUser(user.id, "Payout requested", `Your payout of ৳${amount} to ${method} (${dest.local}) is queued. We process payouts within 1 business day.`, "wallet", "/profile");
    notifyAdmins?.("Payout requested", `${user.name} requested a ৳${amount} payout.`, "wallet", "/admin");
    return send(res,200,{ok:true,payout_id:payoutId,amount,method,phone:dest.local,status:"pending"});
  }

  if(req.method==="GET"&&url.pathname==="/api/user/settings") {
    requireUser(user);
    const u=db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
    delete u.password_hash;
    delete u.reset_token;
    delete u.reset_expires;
    try { u.skills=JSON.parse(u.skills||"[]"); } catch { u.skills=[]; }
    return send(res,200,{
      settings: {
        id: u.id,
        email: u.email,
        display_name: u.name,
        username: u.username||`@${u.email.split("@")[0]}`,
        bio: u.bio||"",
        city: u.city||u.area||"Dhaka",
        phone: u.phone||"",
        occupation: u.occupation||(u.role==="worker"?u.category:"Student"),
        profession_icon: u.profession_icon||"student",
        skills: u.skills,
        avatar_photo: u.avatar_photo||null,
        language: u.language||"bn",
        notif_reactions: Boolean(u.notif_reactions??1),
        notif_comments: Boolean(u.notif_comments??1),
        notif_messages: Boolean(u.notif_messages??1),
        notif_all: Boolean(u.notif_all??1),
        notif_updates: Boolean(u.notif_updates??1),
        notif_hire: Boolean(u.notif_hire??0),
        verified: Boolean(u.verified)
      }
    });
  }

  if(req.method==="PATCH"&&url.pathname==="/api/user/settings") {
    requireUser(user);
    const body=await readBody(req);
    const name=body.display_name!==undefined?String(body.display_name).trim():user.name;
    const username=body.username!==undefined?String(body.username).trim():user.username;
    const bio=body.bio!==undefined?String(body.bio).slice(0,300):user.bio;
    const city=body.city!==undefined?String(body.city).trim():user.city;
    const phone=body.phone!==undefined?String(body.phone).trim():user.phone;
    const occupation=body.occupation!==undefined?String(body.occupation).trim():user.occupation;
    const profession_icon=body.profession_icon!==undefined?String(body.profession_icon).trim():user.profession_icon;
    const skills=Array.isArray(body.skills)?JSON.stringify(body.skills):(user.skills ? JSON.stringify(user.skills) : "[]");
    const notif_reactions=body.notif_reactions!==undefined?(body.notif_reactions?1:0):user.notif_reactions;
    const notif_comments=body.notif_comments!==undefined?(body.notif_comments?1:0):user.notif_comments;
    const notif_messages=body.notif_messages!==undefined?(body.notif_messages?1:0):user.notif_messages;
    const notif_all=body.notif_all!==undefined?(body.notif_all?1:0):user.notif_all;
    const notif_updates=body.notif_updates!==undefined?(body.notif_updates?1:0):user.notif_updates;
    if(body.email_notifications!==undefined) db.prepare("UPDATE users SET email_notifications=? WHERE id=?").run(body.email_notifications?1:0,user.id);
    const notif_hire=body.notif_hire!==undefined?(body.notif_hire?1:0):user.notif_hire;
    const language=body.language!==undefined?String(body.language).trim():user.language;

    db.prepare(`UPDATE users SET
      name=?,username=?,bio=?,city=?,phone=?,occupation=?,profession_icon=?,skills=?,
      notif_reactions=?,notif_comments=?,notif_messages=?,notif_all=?,notif_updates=?,notif_hire=?,language=?
      WHERE id=?`).run(
      name,username,bio,city,phone,occupation,profession_icon,skills,
      notif_reactions,notif_comments,notif_messages,notif_all,notif_updates,notif_hire,language,
      user.id
    );
    otp.resetIfChanged(user.id,phone);

    const updated=currentUser(user.id);
    if(updated&&updated.role==="worker") indexWorker(updated);
    return send(res,200,{ok:true,user:updated,settings:{...(updated||{}),sms_alerts:body.sms_alerts!==undefined?(body.sms_alerts?1:0):1,email_alerts:body.email_alerts!==undefined?(body.email_alerts?1:0):1,bio:updated?.bio||bio}});
  }

  if(req.method==="POST"&&url.pathname==="/api/user/photo") {
    requireUser(user);
    const body=await readBody(req);
    const photo=String(body.photo||"");
    if(!photo.startsWith("data:image/")) fail(400,"Invalid image format.");
    db.prepare("UPDATE users SET avatar_photo=? WHERE id=?").run(photo,user.id);
    const updated=currentUser(user.id);
    if(updated&&updated.role==="worker") indexWorker(updated);
    return send(res,200,{ok:true,avatar_photo:photo});
  }

  return send(res,404,{message:"That API route was not found."});
}

function contentType(file) { return ({".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".webp":"image/webp",".ico":"image/x-icon",".woff2":"font/woff2",".woff":"font/woff",".txt":"text/plain; charset=utf-8"})[path.extname(file)]||"application/octet-stream"; }
const zlib = require("node:zlib");
const COMPRESSIBLE = /\.(html|css|js|json|svg|txt)$/;
const compressedCache = new Map(); // "file|mtime|encoding" -> Buffer, so each asset is compressed once per change
function sendStatic(req, res, file) {
  const st = fs.statSync(file), ext = path.extname(file), vendor = file.includes(path.sep + "vendor" + path.sep);
  const headers = { "Content-Type": contentType(file), Vary: "Accept-Encoding",
    "Cache-Control": ext === ".html" ? "no-cache" : vendor ? "public, max-age=2592000" : "public, max-age=3600" };
  const accept = String(req.headers["accept-encoding"] || "");
  const enc = COMPRESSIBLE.test(file) && st.size > 1024 ? (/\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null) : null;
  if (enc) {
    const key = `${file}|${st.mtimeMs}|${enc}`;
    let buf = compressedCache.get(key);
    if (!buf) {
      const raw = fs.readFileSync(file);
      buf = enc === "br" ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.gzipSync(raw, { level: 6 });
      compressedCache.set(key, buf);
    }
    res.writeHead(200, { ...headers, "Content-Encoding": enc, "Content-Length": buf.length });
    return req.method === "HEAD" ? res.end() : res.end(buf);
  }
  res.writeHead(200, { ...headers, "Content-Length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
  ctxIp=limiter.clientIp(req,TRUST_PROXY);ctxUa=req.headers["user-agent"];
  const headers={"X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","Permissions-Policy":"geolocation=(self)","Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com https://www.gstatic.com; style-src 'self' https://fonts.googleapis.com https://accounts.google.com 'unsafe-inline'; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://*.googleusercontent.com https://lh3.googleusercontent.com; connect-src 'self' https://router.project-osrm.org https://nominatim.openstreetmap.org https://accounts.google.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseio.com https://*.firebaseapp.com https://*.googleapis.com ws: wss:; frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://*.firebase.com; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
  if(IS_PROD)headers["Strict-Transport-Security"]="max-age=31536000; includeSubDomains";
  headers["Cross-Origin-Opener-Policy"]="same-origin-allow-popups";
  Object.entries(headers).forEach(([key,value])=>res.setHeader(key,value));
  try {
    const gatewayCallback=/^\/api\/payments\/(sslcommerz|mock)\/(success|fail|cancel|ipn|pay)$/.test(url.pathname)||/^\/api\/email\/(unsubscribe|verify)$/.test(url.pathname);
    if(url.pathname.startsWith("/api/")&&gatewayCallback) {
      if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
      const gl=limiter.hit("pay-cb:"+ctxIp,120,60*1000);
      if(!gl.allowed)fail(429,"Too many requests.");
      return await handleApi(req,res,url);
    }
    if(url.pathname.startsWith("/api/")) {
      const origin=req.headers.origin;
      if(origin&&WEB_ORIGIN&&origin!==WEB_ORIGIN)fail(403,"This website origin is not allowed.");
      if(origin&&!WEB_ORIGIN&&new URL(origin).host!==req.headers.host)fail(403,"Cross-site requests are not allowed.");
      if(origin) {
        res.setHeader("Access-Control-Allow-Origin",origin);
        res.setHeader("Access-Control-Allow-Credentials","true");
        res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization,ngrok-skip-browser-warning");
        res.setHeader("Vary","Origin");
      }
      if(req.method==="OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods","GET,POST,PATCH,PUT,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization,ngrok-skip-browser-warning");
        res.writeHead(204);return res.end();
      }
      const gl=limiter.hit("api:"+ctxIp,600,60*1000);
      if(!gl.allowed){res.setHeader("Retry-After",gl.retryAfter);fail(429,"Too many requests. Please slow down.");}
      return await handleApi(req,res,url);
    }
    if(!["GET","HEAD"].includes(req.method))return send(res,405,{message:"Method not allowed."});
    const decoded=decodeURIComponent(url.pathname==="/"?"/index.html":url.pathname);const file=path.resolve(PUBLIC_DIR,`.${decoded}`);
    if(!file.startsWith(PUBLIC_DIR+path.sep)&&file!==path.join(PUBLIC_DIR,"index.html"))return send(res,403,{message:"Forbidden."});
    if(/^\/admin\/?$/.test(url.pathname)){res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});return res.end(fs.readFileSync(path.join(PUBLIC_DIR,"admin.html")));}
    const appRoute=/^\/(categories|jobs|hot-offers|about|how-it-works|help|profile|inbox|saved|tasks\/\d+)\/?$/.test(url.pathname);
    const actual=fs.existsSync(file)&&fs.statSync(file).isFile()?file:appRoute?path.join(PUBLIC_DIR,"index.html"):null;
    if(!actual)return send(res,404,{message:"Not found."});
    return sendStatic(req,res,actual);
  } catch(error) {
    if(res.headersSent)return res.end();const status=error.status||500;if(status===500)console.error(error);send(res,status,{message:status===500?"The request could not be completed.":error.message,...(status<500&&error.extra?error.extra:{})});
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`ServiNear is ready at http://0.0.0.0:${PORT}`));


// ============================================================================
// NATIVE WEBSOCKET ENGINE (INSTANT CHAT, TYPING STATUS, LIVE NOTIFICATIONS)
// ============================================================================
const wss = new WebSocketServer({ server });
const connectedClients = new Map();

wss.on("connection", (ws, req) => {
  const cookies = parseCookies(req.headers.cookie);
  let wsToken = cookies.servinear_session;
  try {
    const wsUrl = new URL(req.url, "http://localhost");
    wsToken = wsUrl.searchParams.get("token") || wsToken;
  } catch {}
  const token = wsToken;
  const wsUserId = userIdForToken(token);
  const user = wsUserId ? currentUser(wsUserId) : null;

  if (user) {
    ws.userId = user.id;
    if (!connectedClients.has(user.id)) connectedClients.set(user.id, new Set());
    connectedClients.get(user.id).add(ws);
    try { ws.send(JSON.stringify({ type: "auth_success", user_id: user.id, user_name: user.name })); } catch {}
  }

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "typing" && ws.userId && data.peer_id) {
        sendToUser(Number(data.peer_id), {
          type: "typing",
          sender_id: ws.userId,
          is_typing: Boolean(data.is_typing),
          job_id: data.job_id
        });
      }
    } catch {}
  });

  ws.on("close", () => {
    if (ws.userId && connectedClients.has(ws.userId)) {
      connectedClients.get(ws.userId).delete(ws);
      if (connectedClients.get(ws.userId).size === 0) connectedClients.delete(ws.userId);
    }
  });
});

function sendToUser(userId, payload) {
  const sockets = connectedClients.get(userId);
  if (sockets) {
    const msg = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch {}
      }
    }
  }
}


// ============================================================================
// 24/7 KEEP-ALIVE WORKER (PREVENTS RENDER FREE TIER SLEEP & 50s DELAY)
// ============================================================================
const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || "";
if (keepAliveUrl) {
  const pingTarget = `${keepAliveUrl.replace(/\/$/, "")}/api/health`;
  console.log(`[Keep-Alive] Self-ping active every 13 min: ${pingTarget}`);
  setInterval(() => {
    try {
      const client = pingTarget.startsWith("https") ? require("node:https") : require("node:http");
      client.get(pingTarget, (res) => {
        // Keeps Render container awake 24/7 with zero spin-down delay
      }).on("error", () => {});
    } catch {}
  }, 13 * 60 * 1000);
}
