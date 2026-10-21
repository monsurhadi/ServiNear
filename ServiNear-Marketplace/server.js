"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PORT = Number(process.env.PORT || 5000);
const SESSION_TTL = 7 * 24 * 60 * 60;
const WEB_ORIGIN = String(process.env.WEB_ORIGIN || "").replace(/\/$/, "");
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || "";
if (process.env.NODE_ENV === "production" && !WEB_ORIGIN.startsWith("https://")) {
  throw new Error("Production requires HTTPS WEB_ORIGIN.");
}
const sessions = new Map();
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

function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIM; i++) dot += vecA[i] * vecB[i];
  return dot;
}

const upsertVectorStmt = db.prepare(`
  INSERT INTO vector_index(entity_type, entity_id, title, category, area, content, vector, updated_at)
  VALUES(?,?,?,?,?,?,?, CURRENT_TIMESTAMP)
  ON CONFLICT(entity_type, entity_id) DO UPDATE SET
    title=excluded.title,
    category=excluded.category,
    area=excluded.area,
    content=excluded.content,
    vector=excluded.vector,
    updated_at=CURRENT_TIMESTAMP
`);

function indexWorker(worker) {
  if (!worker) return;
  const content = `${worker.name} ${worker.category || ""} ${worker.area || ""} ${worker.bio || ""} ${worker.occupation || ""} ${worker.skills || ""}`;
  const vec = generateEmbedding(content);
  upsertVectorStmt.run("worker", worker.id, worker.name, worker.category || "General", worker.area || "", content, JSON.stringify(Array.from(vec)));
}

function indexJob(job) {
  if (!job) return;
  const content = `${job.title} ${job.category || ""} ${job.area || ""} ${job.details || ""}`;
  const vec = generateEmbedding(content);
  upsertVectorStmt.run("job", job.id, job.title, job.category || "General", job.area || "", content, JSON.stringify(Array.from(vec)));
}

function initVectorDatabase() {
  const existingCount = db.prepare("SELECT COUNT(*) AS c FROM vector_index").get().c;
  if (existingCount > 0) return;
  const workers = db.prepare("SELECT * FROM users WHERE role='worker'").all();
  workers.forEach(indexWorker);
  const jobs = db.prepare("SELECT * FROM jobs").all();
  jobs.forEach(indexJob);
}

function vectorSearch(query, entityType = "all", limit = 20) {
  const queryVec = generateEmbedding(query);
  let sql = "SELECT * FROM vector_index";
  if (entityType === "workers" || entityType === "worker") sql += " WHERE entity_type='worker'";
  else if (entityType === "jobs" || entityType === "job") sql += " WHERE entity_type='job'";
  const rows = db.prepare(sql).all();

  const scored = [];
  for (const row of rows) {
    try {
      const vec = JSON.parse(row.vector);
      const score = cosineSimilarity(queryVec, vec);
      if (score > 0.05) {
        scored.push({
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          title: row.title,
          category: row.category,
          area: row.area,
          content: row.content,
          score: Math.round(score * 100) / 100,
          match_pct: Math.min(100, Math.round(score * 120)) + "%"
        });
      }
    } catch {}
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

function checkPassword(password, saved) {
  const [salt, expected] = String(saved || "").split(":");
  if (!salt || !expected) return false;
  const actual = Buffer.from(passwordHash(password, salt).split(":")[1], "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

function seedDatabase() {
  const addCategory = db.prepare("INSERT OR IGNORE INTO categories(name,description) VALUES(?,?)");
  CATEGORIES.forEach(([name,description]) => addCategory.run(name,description));

  // Comprehensive cleanup of legacy synthetic generator data
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
  const addUser = db.prepare(`INSERT OR IGNORE INTO users
    (name,email,password_hash,role,phone,area,address,category,bio,rate,experience,latitude,longitude,verified,availability)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const authenticUsers = [
    ["Platform Admin", "admin@servinear.local", defaultHash, "admin", "01711-000001", "Dhaka", "Banani Head Office, Road 11, Dhaka", null, "ServiNear Platform Administrator & Verification Authority.", null, null, null, null, 1, "Available"],
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
    ["Jannatul Ferdous", "jannat.beauty@gmail.com", defaultHash, "worker", "01825-112244", "Dhanmondi, Dhaka", "Road 8/A, Dhanmondi, Dhaka", "Beauty", "Certified aesthetician and bridal makeup artist. At-home facial, organic hair treatment, bridal mehendi, and skin care services with hygienic kits.", 900, 6, 23.7480, 90.3750, 1, "Available"],
    ["Rashedul Karim", "rashed.cargo@gmail.com", defaultHash, "worker", "01926-223355", "Old Dhaka, Dhaka", "Lalbagh Road, Dhaka", "Removals", "Owns covered pickup van for home shifting, inter-city parcel transfer, fragile glassware packing, and safe multi-floor furniture carriage.", 1100, 9, 23.7180, 90.3882, 1, "Available"],
    ["Nazmul Haque", "nazmul.cctv@gmail.com", defaultHash, "worker", "01627-334466", "Mirpur 2, Dhaka", "Stadium Road, Mirpur 2, Dhaka", "Computers & IT", "Hikvision & Dahua certified security camera installer. IP camera setup, DVR/NVR remote viewing configuration on smartphone, and intercom lines.", 750, 7, 23.8050, 90.3620, 1, "Available"],
    ["Habibur Rahman", "habib.auto@gmail.com", defaultHash, "worker", "01728-445577", "Farmgate, Dhaka", "Indira Road, Farmgate, Dhaka", "Auto", "Automobile breakdown specialist. Immediate on-spot battery jumpstart, tire puncture repair, radiator coolant check, and brake inspection.", 600, 10, 23.7580, 90.3860, 1, "Available"],
    ["Iqbal Hossain", "iqbal.plumber.ctg@gmail.com", defaultHash, "worker", "01829-556688", "Agrabad, Chattogram", "Badamtali, Agrabad, Chattogram", "Plumbing", "Chattogram port & residential plumbing contractor. Water storage tank cleaning, submersible motor setup, and pipe fittings.", 650, 11, 22.3569, 91.7832, 1, "Available"],
    ["Forhad Mia", "forhad.electric.sylhet@gmail.com", defaultHash, "worker", "01930-667799", "Zindabazar, Sylhet", "Court Road, Zindabazar, Sylhet", "Electrical", "Sylhet city specialist for IPS inverters, generator transfer switches, commercial showroom lighting, and earthing installation.", 700, 8, 24.8949, 91.8687, 1, "Available"]
  ];

  authenticUsers.forEach(([name,email,pass,role,phone,area,address,category,bio,rate,exp,lat,lng,verified,avail]) => {
    addUser.run(name, email, pass, role, phone, area, address, category, bio, rate, exp, lat, lng, verified, avail);
  });

  // Authentic Community Jobs (CholoBD-compatible real-world data)
  const addJob = db.prepare(`INSERT OR IGNORE INTO jobs
    (id, customer_id, title, category, details, area, budget, contact_phone, exact_address, latitude, longitude, status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);

  const nusrat = db.prepare("SELECT id FROM users WHERE email='nusrat.jahan@gmail.com'").get();
  const tariqul = db.prepare("SELECT id FROM users WHERE email='tariqul.islam@gmail.com'").get();
  const sabrina = db.prepare("SELECT id FROM users WHERE email='sabrina.yasmin@outlook.com'").get();
  const mostafa = db.prepare("SELECT id FROM users WHERE email='mostafa.kamal@yahoo.com'").get();
  const rezwana = db.prepare("SELECT id FROM users WHERE email='dr.rezwana@gmail.com'").get();
  const farhan = db.prepare("SELECT id FROM users WHERE email='farhan.tanvir@hotmail.com'").get();

  if (nusrat && tariqul && sabrina && mostafa) {
    addJob.run(1, nusrat.id, "Split AC Master Servicing & Precision Gas Refill", "Appliances", "Gree 1.5 ton split AC cooling has dropped significantly. Need outdoor compressor chemical wash, drain line unclogging, and R410A gas pressure check at Dhanmondi 27.", "Dhanmondi, Dhaka", 2800, "01712-345678", "House 42, Road 27, Dhanmondi, Dhaka", 23.7465, 90.3760, "open");
    addJob.run(2, tariqul.id, "Sub-distribution Board Circuit Breaker Tripping & Rewiring", "Electrical", "Main MCB trips whenever geyser and microwave run simultaneously. Need certified electrician to inspect phase distribution, DB earthing, and replace 32A breaker.", "Mirpur 10, Dhaka", 1600, "01819-234567", "Block C, Avenue 4, Mirpur 10, Dhaka", 23.8223, 90.3654, "open");
    addJob.run(3, sabrina.id, "Concealed Bathroom Pipe Leakage & Kitchen Sink Mixer Fitting", "Plumbing", "Concealed hot-water CPVC pipe leaking behind master bathroom tiles causing damp walls. Also need to replace kitchen flex faucet with Jaquar mixer.", "Uttara, Dhaka", 2200, "01911-345678", "Sector 4, Road 12, Uttara, Dhaka", 23.8759, 90.3795, "open");
    addJob.run(4, mostafa.id, "Urgent Home Shifting: 3BHK Furniture & Glassware Transport", "Removals", "Moving from Banani Road 8 to Gulshan 1. Heavy items: King bed, 6-seater dining table, 4 door wardrobe, refrigerator, and 12 carton fragile crockery. Covered van needed.", "Banani, Dhaka", 7500, "01612-456789", "Road 8, Block D, Banani, Dhaka", 23.7937, 90.4043, "open");
    addJob.run(5, rezwana.id, "Micro-task: Rapid 2-Hour Errand & Document Delivery", "Delivery", "Urgent hospital report and prescription delivery from Mohammadpur Japan Garden City to Square Hospital Panthapath within 2 hours.", "Mohammadpur, Dhaka", 450, "01723-567890", "Japan Garden City, Building 14, Mohammadpur, Dhaka", 23.7658, 90.3582, "open");
    addJob.run(6, farhan.id, "Home Dual-Band Wi-Fi 6 Router & 4-Channel IP Camera Setup", "Computers & IT", "Setup TP-Link Archer router with mesh extender across 2200 sqft apartment, configure Hikvision IP cameras with mobile app remote viewing.", "Bashundhara, Dhaka", 3000, "01824-678901", "Block C, Road 5, Bashundhara R/A, Dhaka", 23.8151, 90.4255, "open");
  }

  // Authentic Offers from Specialized Providers
  const addOffer = db.prepare("INSERT OR IGNORE INTO offers(job_id,worker_id,price,message) VALUES(?,?,?,?)");
  const shamim = db.prepare("SELECT id FROM users WHERE email='shamim.ac.expert@gmail.com'").get();
  const tanvir = db.prepare("SELECT id FROM users WHERE email='tanvir.electrician@gmail.com'").get();
  const nazmul = db.prepare("SELECT id FROM users WHERE email='nazmul.plumbing@gmail.com'").get();
  const rashed = db.prepare("SELECT id FROM users WHERE email='rashed.cargo@gmail.com'").get();

  if (shamim) addOffer.run(1, shamim.id, 2600, "I can visit Dhanmondi 27 today at 3:30 PM with manifold gauge, vacuum pump, and genuine refrigerant.");
  if (tanvir) addOffer.run(2, tanvir.id, 1500, "Will test insulation resistance with megger, balance phase loads, and install Havells MCB with 1-year service warranty.");
  if (nazmul) addOffer.run(3, nazmul.id, 2000, "Experienced in non-destructive acoustic pipe leak detection and sanitary fittings replacement.");
  if (rashed) addOffer.run(4, rashed.id, 7000, "Includes 14ft covered truck, 4 skilled lifters, bubble wrap, and safe delivery.");
}
seedDatabase();
initVectorDatabase();

function send(res,status,payload,headers={}) {
  const body=Buffer.from(JSON.stringify(payload));
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":body.length,"Cache-Control":"no-store",...headers});
  res.end(body);
}
function fail(status,message) { const error=new Error(message); error.status=status; throw error; }
function parseCookies(header="") {
  return Object.fromEntries(header.split(";").map((part)=>{const i=part.indexOf("=");return i<0?["",""]:[part.slice(0,i).trim(),decodeURIComponent(part.slice(i+1).trim())];}));
}
function currentUser(id) {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if (!u) return null;
  delete u.password_hash;
  delete u.reset_token;
  delete u.reset_expires;
  try { u.skills = JSON.parse(u.skills || "[]"); } catch { u.skills = []; }
  return u;
}
function notifyUser(userId, title, message, type = "system", link = null) {
  try {
    db.prepare("INSERT INTO notifications(user_id,title,message,type,link) VALUES(?,?,?,?,?)").run(userId, title, message, type, link);
  } catch(e) { console.error("Notification error:", e); }
}
function notifyAdmins(title, message, type = "admin", link = null) {
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach(a => notifyUser(a.id, title, message, type, link));
  } catch(e) { console.error("Admin notification error:", e); }
}
function getSession(req) {
  const token=parseCookies(req.headers.cookie).servinear_session;
  const session=token?sessions.get(token):null;
  if(!session||session.expiresAt<Date.now()){if(token)sessions.delete(token);return null;}
  session.expiresAt=Date.now()+SESSION_TTL*1000;
  return currentUser(session.user.id);
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
function coordinates(body) {
  const lat=body.latitude===undefined||body.latitude===null?null:Number(body.latitude);
  const lng=body.longitude===undefined||body.longitude===null?null:Number(body.longitude);
  if((lat!==null&&(!Number.isFinite(lat)||lat < -90||lat > 90))||(lng!==null&&(!Number.isFinite(lng)||lng < -180||lng > 180))||(lat===null)!==(lng===null))fail(400,"Those location coordinates are invalid.");
  return {lat,lng};
}
function publicWorkers() {
  const workers = db.prepare(`SELECT u.id,u.name,u.username,u.avatar_photo,u.profession_icon,u.skills,u.area,u.city,u.category,u.bio,u.rate,u.experience,u.latitude,u.longitude,u.verified,u.availability,
    ROUND(AVG(r.rating),1) AS rating,COUNT(r.id) AS reviews FROM users u LEFT JOIN reviews r ON r.worker_id=u.id
    WHERE u.role='worker' GROUP BY u.id ORDER BY u.verified DESC,u.name`).all();
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
function setSession(userId) {
  const token=crypto.randomBytes(32).toString("hex");
  sessions.set(token,{user:{id:userId},expiresAt:Date.now()+SESSION_TTL*1000});
  return sessionCookie(token, SESSION_TTL);
}
function validateText(value,label,min,max) {
  const text=String(value||"").trim();
  if(text.length<min||text.length>max)fail(400,`${label} must be ${min} to ${max} characters.`);
  return text;
}
function categoryExists(category) { return Boolean(db.prepare("SELECT id FROM categories WHERE name=? COLLATE NOCASE").get(category)); }

async function handleApi(req,res,url) {
  const user=getSession(req);
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
    const record=db.prepare("SELECT id,password_hash FROM users WHERE email=?").get(email);
    if(!record||!checkPassword(String(body.password||""),record.password_hash))fail(401,"Email or password is incorrect.");
    return send(res,200,{user:currentUser(record.id)},{"Set-Cookie":setSession(record.id)});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/logout") {
    const token=parseCookies(req.headers.cookie).servinear_session;if(token)sessions.delete(token);
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
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(name,firstName||null,surname||null,email,passwordHash(password),role,gender,city,occupation,phone,area,address,category,bio,rate,position.lat,position.lng);
      const id=Number(result.lastInsertRowid);
      notifyUser(id, "Welcome to ServiNear!", "Your account is created. Explore local verified helpers and post your first task.", "system");
      return send(res,201,{user:currentUser(id)},{"Set-Cookie":setSession(id)});
    } catch(error) {if(String(error.message).includes("UNIQUE"))fail(409,"An account with that email already exists.");throw error;}
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/google") {
    const body=await readBody(req);
    const email=String(body.email||"").trim().toLowerCase();
    const name=String(body.name||"Google User").trim().slice(0,80);
    const googleId=String(body.google_id||body.sub||"google_"+Date.now());
    if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,"A valid Google email is required.");
    let userRecord = db.prepare("SELECT id FROM users WHERE email=?").get(email);
    if(userRecord) {
      db.prepare("UPDATE users SET google_id=? WHERE id=?").run(googleId, userRecord.id);
      return send(res,200,{user:currentUser(userRecord.id)},{"Set-Cookie":setSession(userRecord.id)});
    } else {
      const role=body.role==="worker"?"worker":"customer";
      const dummyPassword = crypto.randomBytes(16).toString("hex");
      const result=db.prepare(`INSERT INTO users(name,email,password_hash,google_id,role,area,availability)
        VALUES(?,?,?,?,?,'Dhaka','Available')`).run(name,email,passwordHash(dummyPassword),googleId,role);
      const id=Number(result.lastInsertRowid);
      notifyUser(id, "Welcome via Google!", "Your account has been connected with Google.", "system");
      return send(res,201,{user:currentUser(id)},{"Set-Cookie":setSession(id)});
    }
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/forgot-password") {
    const body=await readBody(req);
    const email=String(body.email||"").trim().toLowerCase();
    if(!email)fail(400,"Please enter your email address.");
    const userRecord = db.prepare("SELECT id FROM users WHERE email=?").get(email);
    if(!userRecord) {
      return send(res,200,{ok:true,message:"If this email exists in our records, a reset code has been sent."});
    }
    const token = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 60 * 60 * 1000;
    db.prepare("UPDATE users SET reset_token=?, reset_expires=? WHERE id=?").run(token, expires, userRecord.id);
    return send(res,200,{ok:true,message:"Password reset code generated.",reset_code:token});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/reset-password") {
    const body=await readBody(req);
    const email=String(body.email||"").trim().toLowerCase();
    const code=String(body.code||body.token||"").trim();
    const newPassword=String(body.password||"");
    if(!email||!code||!newPassword)fail(400,"Email, reset code, and new password are required.");
    if(newPassword.length<8)fail(400,"Password must be at least 8 characters.");
    const userRecord = db.prepare("SELECT id, reset_token, reset_expires FROM users WHERE email=?").get(email);
    if(!userRecord||userRecord.reset_token!==code||!userRecord.reset_expires||userRecord.reset_expires<Date.now()) {
      fail(400,"Invalid or expired password reset code.");
    }
    db.prepare("UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?").run(passwordHash(newPassword), userRecord.id);
    notifyUser(userRecord.id, "Password Changed", "Your account password was successfully reset.", "security");
    return send(res,200,{ok:true,message:"Password updated successfully. You can now log in."});
  }
  if(req.method==="PATCH"&&url.pathname==="/api/profile") {
    requireUser(user);const body=await readBody(req);const name=validateText(body.name,"Name",2,80);const phone=validateText(body.phone,"Phone",5,30);const area=validateText(body.area,"Area",2,120);const address=String(body.address||"").trim().slice(0,220);
    const category=user.role==="worker"?validateText(body.category,"Service category",2,60):user.category;
    const bio=user.role==="worker"?String(body.bio||"").trim().slice(0,500):user.bio;
    const rate=user.role==="worker"?Math.max(1,Math.min(1000000,Number(body.rate)||500)):user.rate;
    db.prepare("UPDATE users SET name=?,phone=?,area=?,address=?,category=?,bio=?,rate=? WHERE id=?").run(name,phone,area,address,category,bio,rate,user.id);
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
    const jobId=Number(offerMatch[1]);const body=await readBody(req);const price=Number(body.price);const message=validateText(body.message,"Offer message",10,500);
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
    requireUser(user,["customer"]);const offerId=Number(acceptMatch[1]);const offer=db.prepare(`SELECT o.id,o.job_id FROM offers o JOIN jobs j ON j.id=o.job_id
      WHERE o.id=? AND j.customer_id=? AND j.status='open' AND o.status='pending'`).get(offerId,user.id);
    if(!offer)fail(404,"That bid is no longer available.");
    const workerRec = db.prepare("SELECT worker_id FROM offers WHERE id=?").get(offerId);
    db.exec("BEGIN IMMEDIATE");
    try {db.prepare("UPDATE offers SET status=CASE WHEN id=? THEN 'accepted' ELSE 'declined' END WHERE job_id=?").run(offerId,offer.job_id);db.prepare("UPDATE jobs SET status='accepted' WHERE id=?").run(offer.job_id);db.exec("COMMIT");}
    catch(error){db.exec("ROLLBACK");throw error;}
    if(workerRec) notifyUser(workerRec.worker_id, "Offer Accepted!", "Your offer was accepted! The customer contact phone and exact address are now unlocked.", "accepted", "/jobs");
    return send(res,200,{ok:true});
  }
  const completeMatch=url.pathname.match(/^\/api\/jobs\/(\d+)\/complete$/);
  if(req.method==="POST"&&completeMatch) {
    requireUser(user,["worker"]);const result=db.prepare(`UPDATE jobs SET status='completed' WHERE id=? AND status='accepted'
      AND id IN(SELECT job_id FROM offers WHERE worker_id=? AND status='accepted')`).run(Number(completeMatch[1]),user.id);
    if(!result.changes)fail(404,"This accepted task is not assigned to your account.");return send(res,200,{ok:true});
  }
  const reviewMatch=url.pathname.match(/^\/api\/jobs\/(\d+)\/review$/);
  if(req.method==="POST"&&reviewMatch) {
    requireUser(user,["customer"]);const jobId=Number(reviewMatch[1]);const body=await readBody(req);const rating=Number(body.rating);const comment=String(body.comment||"").trim().slice(0,600);
    const job=db.prepare("SELECT id,status FROM jobs WHERE id=? AND customer_id=?").get(jobId,user.id);if(!job||job.status!=="completed")fail(409,"Reviews are available after the job is complete.");
    if(!Number.isInteger(rating)||rating<1||rating>5)fail(400,"Choose a rating from 1 to 5.");const offer=db.prepare("SELECT worker_id FROM offers WHERE job_id=? AND status='accepted'").get(jobId);
    try {db.prepare("INSERT INTO reviews(job_id,customer_id,worker_id,rating,comment) VALUES(?,?,?,?,?)").run(jobId,user.id,offer.worker_id,rating,comment);}
    catch(error){if(String(error.message).includes("UNIQUE"))fail(409,"You already reviewed this job.");throw error;}return send(res,201,{ok:true});
  }
  if(req.method==="POST"&&url.pathname==="/api/support") {
    const body=await readBody(req);const name=validateText(body.name||user?.name,"Name",2,80);const email=String(body.email||user?.email||"").trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,"Enter a valid email address.");const subject=validateText(body.subject,"Subject",4,120);const message=validateText(body.message,"Message",20,2000);
    db.prepare("INSERT INTO support_tickets(user_id,name,email,subject,message) VALUES(?,?,?,?,?)").run(user?.id||null,name,email,subject,message);return send(res,201,{ok:true});
  }
  if(req.method==="GET"&&url.pathname==="/api/admin/summary") {
    requireUser(user,["admin"]);return send(res,200,{users:db.prepare("SELECT COUNT(*) AS count FROM users").get().count,providers:db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='worker'").get().count,customers:db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='customer'").get().count,openJobs:db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='open'").get().count,pending:db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='worker' AND verified=0").get().count,tickets:db.prepare("SELECT COUNT(*) AS count FROM support_tickets WHERE status!='resolved'").get().count});
  }
  if(req.method==="GET"&&url.pathname==="/api/admin/support") {
    requireUser(user,["admin"]);return send(res,200,db.prepare("SELECT id,name,email,subject,message,status,created_at FROM support_tickets ORDER BY created_at DESC LIMIT 100").all());
  }
  const ticketMatch=url.pathname.match(/^\/api\/admin\/support\/(\d+)$/);
  if(req.method==="PATCH"&&ticketMatch) {
    requireUser(user,["admin"]);const body=await readBody(req);if(!["open","reviewing","resolved"].includes(body.status))fail(400,"Choose a valid support status.");
    const result=db.prepare("UPDATE support_tickets SET status=? WHERE id=?").run(body.status,Number(ticketMatch[1]));if(!result.changes)fail(404,"Support request not found.");return send(res,200,{ok:true});
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
    return send(res,200,{ok:true,verified});
  }
  if(req.method==="GET"&&url.pathname==="/api/nid/status") {
    requireUser(user);
    const app = db.prepare("SELECT id, status, admin_notes, created_at, reviewed_at FROM nid_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(user.id);
    return send(res,200,{application: app || null, verified: Boolean(user.verified)});
  }
  if(req.method==="GET"&&url.pathname==="/api/admin/nid-applications") {
    requireUser(user,["admin"]);
    const list = db.prepare(`SELECT n.id, n.user_id, n.nid_front, n.nid_back, n.selfie_nid, n.status, n.admin_notes, n.created_at, n.reviewed_at,
      u.name, u.email, u.phone, u.area, u.role, u.category, u.verified
      FROM nid_verifications n JOIN users u ON u.id=n.user_id ORDER BY CASE WHEN n.status='pending' THEN 0 ELSE 1 END, n.created_at DESC LIMIT 50`).all();
    return send(res,200,list);
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
    const q=url.searchParams.get("q")||"";
    const type=url.searchParams.get("type")||"all";
    const limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")||20)));
    const start=Date.now();
    const results=vectorSearch(q,type,limit);
    return send(res,200,{query:q,total:results.length,took_ms:Date.now()-start,dimensions:VECTOR_DIM,engine:"ServiNear Neural Vector Core (Cosine 128-dim)",results});
  }
  if(req.method==="GET"&&url.pathname==="/api/vector/stats") {
    const count=db.prepare("SELECT COUNT(*) as total FROM vector_index").get().total;
    const workers=db.prepare("SELECT COUNT(*) as c FROM vector_index WHERE entity_type='worker'").get().c;
    const jobs=db.prepare("SELECT COUNT(*) as c FROM vector_index WHERE entity_type='job'").get().c;
    return send(res,200,{total_vectors:count,workers_indexed:workers,jobs_indexed:jobs,dimension:VECTOR_DIM,dimensions:VECTOR_DIM,metric:"Cosine Similarity",status:"operational"});
  }

  // --- User Settings & Profile Customization Endpoints ---
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

function contentType(file) { return ({".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".webp":"image/webp"})[path.extname(file)]||"application/octet-stream"; }
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||"localhost"}`);
  const headers={"X-Content-Type-Options":"nosniff","Referrer-Policy":"strict-origin-when-cross-origin","Permissions-Policy":"geolocation=(self)","Content-Security-Policy":"default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' https://unpkg.com https://fonts.googleapis.com 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; connect-src 'self'; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"};
  Object.entries(headers).forEach(([key,value])=>res.setHeader(key,value));
  try {
    if(url.pathname.startsWith("/api/")) {
      const origin=req.headers.origin;
      if(origin&&WEB_ORIGIN&&origin!==WEB_ORIGIN)fail(403,"This website origin is not allowed.");
      if(origin&&!WEB_ORIGIN&&new URL(origin).host!==req.headers.host)fail(403,"Cross-site requests are not allowed.");
      if(origin) {
        res.setHeader("Access-Control-Allow-Origin",origin);
        res.setHeader("Access-Control-Allow-Credentials","true");
        res.setHeader("Vary","Origin");
      }
      if(req.method==="OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods","GET,POST,PATCH,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers","Content-Type,ngrok-skip-browser-warning");
        res.writeHead(204);return res.end();
      }
      return await handleApi(req,res,url);
    }
    if(!["GET","HEAD"].includes(req.method))return send(res,405,{message:"Method not allowed."});
    const decoded=decodeURIComponent(url.pathname==="/"?"/index.html":url.pathname);const file=path.resolve(PUBLIC_DIR,`.${decoded}`);
    if(!file.startsWith(PUBLIC_DIR+path.sep)&&file!==path.join(PUBLIC_DIR,"index.html"))return send(res,403,{message:"Forbidden."});
    const appRoute=/^\/(categories|jobs|hot-offers|about|how-it-works|help|profile|admin|tasks\/\d+)\/?$/.test(url.pathname);
    const actual=fs.existsSync(file)&&fs.statSync(file).isFile()?file:appRoute?path.join(PUBLIC_DIR,"index.html"):null;
    if(!actual)return send(res,404,{message:"Not found."});
    res.writeHead(200,{"Content-Type":contentType(actual),"Cache-Control":actual.endsWith(".html")?"no-cache":"public, max-age=3600"});
    if(req.method==="HEAD")return res.end();fs.createReadStream(actual).pipe(res);
  } catch(error) {
    if(res.headersSent)return res.end();const status=error.status||500;if(status===500)console.error(error);send(res,status,{message:status===500?"The request could not be completed.":error.message});
  }
});

server.listen(PORT,()=>console.log(`ServiNear is ready at http://localhost:${PORT}`));
