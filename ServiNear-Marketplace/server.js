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
if (process.env.NODE_ENV === "production" && (!WEB_ORIGIN.startsWith("https://") || !COOKIE_DOMAIN)) {
  throw new Error("Production requires HTTPS WEB_ORIGIN and COOKIE_DOMAIN settings.");
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
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("users", "address", "TEXT");
ensureColumn("jobs", "contact_phone", "TEXT");
ensureColumn("jobs", "exact_address", "TEXT");

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
  if (process.env.SEED_DEMO_DATA === "false") {
    const email=String(process.env.ADMIN_EMAIL||"").trim().toLowerCase();
    const password=String(process.env.ADMIN_PASSWORD||"");
    if(email&&password.length>=14&&!db.prepare("SELECT id FROM users WHERE email=?").get(email)) {
      db.prepare(`INSERT INTO users(name,email,password_hash,role,phone,area,address)
        VALUES(?,?,?,'admin','', 'Platform', 'Private admin account')`).run("Platform Administrator",email,passwordHash(password));
    }
    return;
  }
  const demoHash = passwordHash("ServiNear123!");
  const addUser = db.prepare(`INSERT OR IGNORE INTO users
    (name,email,password_hash,role,phone,area,address,category,bio,rate,experience,latitude,longitude,verified,availability)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const byEmail = db.prepare("SELECT id FROM users WHERE email=?");
  const demoUsers = [
    ["Demo Customer","customer@servinear.local","customer","DEMO-PHONE-0001","Mirpur, Dhaka","Sample Road 1, Mirpur, Dhaka",null,null,null,null,null,null,0,"Available"],
    ["Demo Customer Two","customer2@servinear.local","customer","DEMO-PHONE-0002","Dhanmondi, Dhaka","Sample Road 2, Dhanmondi, Dhaka",null,null,null,null,null,null,0,"Available"],
    ["Demo Worker","worker@servinear.local","worker","DEMO-PHONE-1001","Mirpur, Dhaka",null,"Electrical","Electrical repairs, switches and safe home wiring. Clear quotes before work begins.",650,8,23.8223,90.3654,1,"Available"],
    ["Faisal Ahmed","faisal@servinear.local","worker","DEMO-PHONE-1002","Dhanmondi, Dhaka",null,"Plumbing","Leak repairs, bathroom fittings and water line maintenance.",550,7,23.7465,90.3760,1,"Available"],
    ["Athoy Rahman","athoy@servinear.local","worker","DEMO-PHONE-1003","Uttara, Dhaka",null,"Cleaning","Deep cleaning for homes, move-ins and small offices.",450,6,23.8759,90.3795,1,"Busy today"],
    ["Shanto Ali","shanto@servinear.local","worker","DEMO-PHONE-1004","Banani, Dhaka",null,"Carpentry","Furniture repair, doors, cabinets and custom woodwork.",700,5,23.7937,90.4043,1,"Available"],
    ["Nafis Kamal","nafis@servinear.local","worker","DEMO-PHONE-1005","Mohammadpur, Dhaka",null,"Appliances","Appliance servicing, installation and seasonal maintenance.",800,9,23.7658,90.3582,1,"Available"],
    ["Platform Admin","admin@servinear.local","admin","DEMO-PHONE-9001","Dhaka","Sample admin office, Dhaka",null,null,null,null,null,null,0,"Available"]
  ];
  demoUsers.forEach(([name,email,role,phone,area,address,category,bio,rate,experience,lat,lng,verified,availability]) => addUser.run(name,email,demoHash,role,phone,area,address,category,bio,rate,experience,lat,lng,verified,availability));

  const cities = [
    ["Mirpur",23.8223,90.3654],["Dhanmondi",23.7465,90.3760],["Uttara",23.8759,90.3795],
    ["Banani",23.7937,90.4043],["Mohammadpur",23.7658,90.3582],["Bashundhara",23.8151,90.4255],
    ["Chattogram",22.3569,91.7832],["Sylhet",24.8949,91.8687],["Rajshahi",24.3745,88.6042],
    ["Khulna",22.8456,89.5403],["Cumilla",23.4607,91.1809],["Mymensingh",24.7471,90.4203]
  ];
  const firstNames = ["Ayesha","Nusrat","Sadia","Farhan","Rafi","Tania","Mahmud","Sanjana","Rahim","Mitu","Shuvo","Jannat","Kamal","Moumita","Tanvir","Sohana"];
  const middleNames = ["Amin","Anika","Arif","Binte","Fahim","Ishrat","Jahan","Nabil","Nawrin","Omar","Parveen","Raisa","Samia","Tasnim","Uzair","Zara"];
  const lastNames = ["Rahman","Ahmed","Hossain","Akter","Islam","Karim","Chowdhury","Hasan","Sultana","Khan","Alam","Mia"];
  const blurbs = ["On-time service with a clear quote before work begins.","Experienced with home visits, careful repairs and customer updates.","Friendly local professional who confirms the scope before starting.","Available for planned work and neighborhood service requests.","Focused on tidy work, realistic timing and clear communication.","Provides practical options and explains materials before purchase."];
  const pad = (number) => String(number).padStart(4, "0");
  const uniqueName = (number, offset = 0) => {
    const value = number + offset;
    return `${firstNames[value % firstNames.length]} ${middleNames[Math.floor(value / firstNames.length) % middleNames.length]} ${lastNames[Math.floor(value / (firstNames.length * middleNames.length)) % lastNames.length]}`;
  };
  const providerBio = (number, category) => `${blurbs[number % blurbs.length]} Service focus: ${category}. Synthetic profile SN-P-${pad(number)}.`;
  let customers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='customer'").get().count;
  while (customers < 500) {
    const n = ++customers;
    const city = cities[(n * 7) % cities.length];
    addUser.run(uniqueName(n),`customer-${pad(n)}@demo.servinear.local`,demoHash,"customer",`DEMO-PHONE-C${pad(n)}`,`${city[0]}, Bangladesh`,`Sample address ${pad(n)}, ${city[0]}, Bangladesh`,null,null,null,null,null,null,0,"Available");
  }
  let providers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='worker'").get().count;
  while (providers < 1000) {
    const n = ++providers;
    const city = cities[(n * 5) % cities.length];
    const category = CATEGORIES[n % CATEGORIES.length][0];
    addUser.run(uniqueName(n, 2048),`provider-${pad(n)}@demo.servinear.local`,demoHash,"worker",`DEMO-PHONE-P${pad(n)}`,`${city[0]}, Bangladesh`,null,category,providerBio(n, category),350 + (n * 137) % 1900,1 + n % 18,city[1] + (((n * 17) % 61) - 30) / 1200,city[2] + (((n * 29) % 61) - 30) / 1200,n % 10 === 0 ? 0 : 1,n % 7 === 0 ? "Busy today" : "Available");
  }

  const refreshCustomerName = db.prepare("UPDATE users SET name=? WHERE email=?");
  for (let n = 3; n <= 500; n++) refreshCustomerName.run(uniqueName(n), `customer-${pad(n)}@demo.servinear.local`);
  const refreshProvider = db.prepare("UPDATE users SET name=?,bio=? WHERE email=?");
  for (let n = 6; n <= 1000; n++) refreshProvider.run(uniqueName(n, 2048), providerBio(n, CATEGORIES[n % CATEGORIES.length][0]), `provider-${pad(n)}@demo.servinear.local`);

  const allCustomers = db.prepare("SELECT id FROM users WHERE role='customer' ORDER BY id").all();
  const allWorkers = db.prepare("SELECT id,category FROM users WHERE role='worker' ORDER BY id").all();
  const addJob = db.prepare(`INSERT INTO jobs(customer_id,title,category,details,area,budget,contact_phone,exact_address,latitude,longitude)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const titleByCategory = {
    Cleaning:"Deep-clean a family apartment",Electrical:"Diagnose a faulty switch and wiring",Plumbing:"Repair a leaking kitchen tap",Appliances:"Service a home appliance",
    Painting:"Repaint a bedroom wall",Handyman:"Fix several small home repairs",Carpentry:"Repair a wardrobe hinge", "Building & Construction":"Repair a damaged boundary wall",
    Removals:"Move furniture between nearby homes",Delivery:"Pick up and deliver a parcel",Gardening:"Trim and tidy a home garden",Assembly:"Assemble a study desk",
    Auto:"Inspect a car that will not start",Beauty:"Book an at-home beauty service",Tutoring:"Find a tutor for a school student",Cooking:"Prepare a family meal at home",
    "Food Delivery":"Arrange a local food delivery",Photography:"Photograph a family event", "Computers & IT":"Repair a laptop that will not start",
    "Audio Visual":"Set up sound equipment for an event",Design:"Create a small business design",Marketing:"Prepare a local business campaign",
    Business:"Get help reviewing a business plan",Accounting:"Organize small business accounts",Admin:"Get help organizing office records",
    Driving:"Book a driver for a planned trip",Alterations:"Alter a formal outfit",Bricklaying:"Repair a short section of brickwork",
    Concreting:"Repair a concrete walkway",Decking:"Repair an outdoor deck",Childcare:"Arrange short-term childcare",Events:"Set up a small family event"
  };
  const oldSeedTitles = ["Repair a leaking kitchen tap","Install two ceiling fans","Clean a two-bedroom apartment","Fix a broken wardrobe hinge","Service a split AC","Paint a bedroom wall","Assemble a study desk","Pick up a parcel across town","Tutor a class 8 student","Repair a laptop that will not start","Trim the front garden","Move a sofa and bookshelf"];
  const descriptions = ["Please inspect the issue, explain the work and share a clear price before starting.","Looking for a careful local professional. Please mention your next available time.","The work is at a family home. Call before arriving and bring the basic tools needed.","Please quote for labour and list any parts that may need to be purchased."];
  let jobs = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
  while (jobs < 300) {
    const n = ++jobs;
    const city = cities[(n * 7) % cities.length];
    const customer = allCustomers[(n * 13) % allCustomers.length];
    const category = CATEGORIES[(n * 3) % CATEGORIES.length][0];
    const reference = `SN-JOB-${pad(n)}`;
    const title = `${titleByCategory[category] || `Find help with ${category.toLowerCase()}`} · ${reference}`;
    const details = `${descriptions[n % descriptions.length]} Request ref ${reference}. Please include your proposed visit window and any materials in your offer.`;
    addJob.run(customer.id,title,category,details,`${city[0]}, Bangladesh`,500 + (n * 227) % 9500,`DEMO-PHONE-C${pad((n * 13) % 500 + 1)}`,`Sample lane ${pad(n)}, ${city[0]}, Bangladesh`,city[1] + (((n * 19) % 45) - 22) / 1000,city[2] + (((n * 11) % 45) - 22) / 1000);
  }
  const legacyJobs = db.prepare(`SELECT j.id,j.category FROM jobs j JOIN users u ON u.id=j.customer_id
    WHERE j.id<=300 AND j.title IN (${oldSeedTitles.map(() => "?").join(",")})
    AND (u.email LIKE 'customer-%@demo.servinear.local' OR u.email IN ('customer@servinear.local','customer2@servinear.local'))`).all(...oldSeedTitles);
  const updateSeedJob = db.prepare("UPDATE jobs SET title=?,details=? WHERE id=?");
  legacyJobs.forEach((job) => {
    const reference = `SN-JOB-${pad(job.id)}`;
    updateSeedJob.run(`${titleByCategory[job.category] || `Find help with ${job.category.toLowerCase()}`} · ${reference}`,
      `${descriptions[job.id % descriptions.length]} Request ref ${reference}. Please include your proposed visit window and any materials in your offer.`,job.id);
  });
  const addOffer = db.prepare("INSERT OR IGNORE INTO offers(job_id,worker_id,price,message) VALUES(?,?,?,?)");
  const firstJobs = db.prepare("SELECT id,category FROM jobs ORDER BY id LIMIT 80").all();
  firstJobs.forEach((job,index) => {
    const matched = allWorkers.filter((worker) => worker.category === job.category);
    const worker = matched[index % Math.max(matched.length,1)] || allWorkers[index % allWorkers.length];
    addOffer.run(job.id,worker.id,700 + (index * 173) % 6000,`I can do this ${job.category.toLowerCase()} work with a clear quote and confirm the visit time. Offer ref SN-O-${pad(index + 1)}.`);
    if (index < 12) addOffer.run(job.id,allWorkers[(index + 17) % allWorkers.length].id,900 + (index * 211) % 6500,`I have relevant experience and can provide a detailed ${job.category.toLowerCase()} quote. Offer ref SN-O-${pad(index + 81)}.`);
  });
  const legacyOffers = db.prepare(`SELECT o.id,o.job_id,o.worker_id,j.category,w.email FROM offers o
    JOIN jobs j ON j.id=o.job_id JOIN users w ON w.id=o.worker_id WHERE j.id<=80
    AND o.message IN ('I can do this work with a clear quote and confirm the visit time with you.','I have experience with this type of job and can share a detailed quote.')
    AND (w.email LIKE 'provider-%@demo.servinear.local' OR w.email IN ('worker@servinear.local','faisal@servinear.local','athoy@servinear.local','shanto@servinear.local','nafis@servinear.local'))`).all();
  const updateSeedOffer = db.prepare("UPDATE offers SET message=? WHERE id=?");
  legacyOffers.forEach((offer) => updateSeedOffer.run(`I can provide a clear ${offer.category.toLowerCase()} quote and confirm the visit time. Offer ref SN-O-${pad(offer.id)}.`,offer.id));
}
seedDatabase();

function send(res,status,payload,headers={}) {
  const body=Buffer.from(JSON.stringify(payload));
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":body.length,"Cache-Control":"no-store",...headers});
  res.end(body);
}
function fail(status,message) { const error=new Error(message); error.status=status; throw error; }
function parseCookies(header="") {
  return Object.fromEntries(header.split(";").map((part)=>{const i=part.indexOf("=");return i<0?["",""]:[part.slice(0,i).trim(),decodeURIComponent(part.slice(i+1).trim())];}));
}
function currentUser(id) { return db.prepare("SELECT id,name,email,role,phone,area,address,category,bio,rate,experience,latitude,longitude,verified,availability FROM users WHERE id=?").get(id)||null; }
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
    req.on("data",chunk=>{data+=chunk;if(data.length>24000){reject(Object.assign(new Error("That request is too large."),{status:413}));req.destroy();}});
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
  return db.prepare(`SELECT u.id,u.name,u.area,u.category,u.bio,u.rate,u.experience,u.latitude,u.longitude,u.verified,u.availability,
    ROUND(AVG(r.rating),1) AS rating,COUNT(r.id) AS reviews FROM users u LEFT JOIN reviews r ON r.worker_id=u.id
    WHERE u.role='worker' GROUP BY u.id ORDER BY u.verified DESC,u.name`).all();
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
function setSession(userId) {
  const token=crypto.randomBytes(32).toString("hex");
  sessions.set(token,{user:{id:userId},expiresAt:Date.now()+SESSION_TTL*1000});
  return `servinear_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}${COOKIE_DOMAIN?`; Domain=${COOKIE_DOMAIN}`:""}${process.env.NODE_ENV==="production"?"; Secure":""}`;
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
    return send(res,200,{user,workers:publicWorkers(),categories:db.prepare("SELECT name,description FROM categories ORDER BY id").all(),...data});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/login") {
    const body=await readBody(req);const email=String(body.email||"").trim().toLowerCase();
    const record=db.prepare("SELECT id,password_hash FROM users WHERE email=?").get(email);
    if(!record||!checkPassword(String(body.password||""),record.password_hash))fail(401,"Email or password is incorrect.");
    return send(res,200,{user:currentUser(record.id)},{"Set-Cookie":setSession(record.id)});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/logout") {
    const token=parseCookies(req.headers.cookie).servinear_session;if(token)sessions.delete(token);
    return send(res,200,{ok:true},{"Set-Cookie":"servinear_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"});
  }
  if(req.method==="POST"&&url.pathname==="/api/auth/register") {
    const body=await readBody(req);const name=validateText(body.name,"Name",2,80);const email=String(body.email||"").trim().toLowerCase();
    const password=String(body.password||"");const role=body.role==="worker"?"worker":"customer";
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>180)fail(400,"Enter a valid email address.");
    if(password.length<10||password.length>200)fail(400,"Use a password with at least 10 characters.");
    const phone=validateText(body.phone,"Phone",5,30);const area=validateText(body.area,"Area",2,120);
    const address=String(body.address||"").trim().slice(0,220)||null;
    const category=role==="worker"?validateText(body.category,"Service category",2,60):null;
    const bio=role==="worker"?String(body.bio||"").trim().slice(0,500):null;
    const rate=role==="worker"?Math.max(1,Math.min(1000000,Number(body.rate)||500)):null;
    const position=role==="worker"?coordinates(body):{lat:null,lng:null};
    try {
      const result=db.prepare(`INSERT INTO users(name,email,password_hash,role,phone,area,address,category,bio,rate,latitude,longitude)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(name,email,passwordHash(password),role,phone,area,address,category,bio,rate,position.lat,position.lng);
      const id=Number(result.lastInsertRowid);return send(res,201,{user:currentUser(id)},{"Set-Cookie":setSession(id)});
    } catch(error) {if(String(error.message).includes("UNIQUE"))fail(409,"An account with that email already exists.");throw error;}
  }
  if(req.method==="PATCH"&&url.pathname==="/api/profile") {
    requireUser(user);const body=await readBody(req);const name=validateText(body.name,"Name",2,80);const phone=validateText(body.phone,"Phone",5,30);const area=validateText(body.area,"Area",2,120);const address=String(body.address||"").trim().slice(0,220);
    const category=user.role==="worker"?validateText(body.category,"Service category",2,60):user.category;
    const bio=user.role==="worker"?String(body.bio||"").trim().slice(0,500):user.bio;
    const rate=user.role==="worker"?Math.max(1,Math.min(1000000,Number(body.rate)||500)):user.rate;
    db.prepare("UPDATE users SET name=?,phone=?,area=?,address=?,category=?,bio=?,rate=? WHERE id=?").run(name,phone,area,address,category,bio,rate,user.id);
    return send(res,200,{user:currentUser(user.id)});
  }
  if(req.method==="POST"&&url.pathname==="/api/jobs") {
    requireUser(user,["customer"]);const body=await readBody(req);const title=validateText(body.title,"Job title",5,100);const category=validateText(body.category,"Category",2,60);
    const details=validateText(body.details,"Description",15,1500);const area=validateText(body.area,"Area",2,140);if(!categoryExists(category))fail(400,"Choose a listed service category.");
    const budget=body.budget?Number(body.budget):null;if(budget!==null&&(!Number.isInteger(budget)||budget<1||budget>10000000))fail(400,"Enter a valid budget in taka.");
    const phone=validateText(body.contact_phone||user.phone,"Contact phone",5,30);const address=validateText(body.exact_address||user.address,"Exact address",5,220);const point=coordinates(body);
    const result=db.prepare(`INSERT INTO jobs(customer_id,title,category,details,area,budget,contact_phone,exact_address,latitude,longitude)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(user.id,title,category,details,area,budget,phone,address,point.lat,point.lng);
    return send(res,201,{id:Number(result.lastInsertRowid)});
  }
  const offerMatch=url.pathname.match(/^\/api\/jobs\/(\d+)\/offers$/);
  if(req.method==="POST"&&offerMatch) {
    requireUser(user,["worker"]);if(!user.verified)fail(403,"Your provider profile needs verification before you can bid.");
    const jobId=Number(offerMatch[1]);const body=await readBody(req);const price=Number(body.price);const message=validateText(body.message,"Offer message",10,500);
    if(!Number.isInteger(price)||price<1||price>10000000)fail(400,"Enter your offer in whole taka.");
    const job=db.prepare("SELECT id,status,customer_id FROM jobs WHERE id=?").get(jobId);if(!job||job.status!=="open")fail(409,"This task is no longer accepting bids.");if(job.customer_id===user.id)fail(403,"You cannot bid on your own task.");
    try {const result=db.prepare("INSERT INTO offers(job_id,worker_id,price,message) VALUES(?,?,?,?)").run(jobId,user.id,price,message);return send(res,201,{id:Number(result.lastInsertRowid)});}
    catch(error){if(String(error.message).includes("UNIQUE"))fail(409,"You already bid on this task.");throw error;}
  }
  const acceptMatch=url.pathname.match(/^\/api\/offers\/(\d+)\/accept$/);
  if(req.method==="POST"&&acceptMatch) {
    requireUser(user,["customer"]);const offerId=Number(acceptMatch[1]);const offer=db.prepare(`SELECT o.id,o.job_id FROM offers o JOIN jobs j ON j.id=o.job_id
      WHERE o.id=? AND j.customer_id=? AND j.status='open' AND o.status='pending'`).get(offerId,user.id);
    if(!offer)fail(404,"That bid is no longer available.");db.exec("BEGIN IMMEDIATE");
    try {db.prepare("UPDATE offers SET status=CASE WHEN id=? THEN 'accepted' ELSE 'declined' END WHERE job_id=?").run(offerId,offer.job_id);db.prepare("UPDATE jobs SET status='accepted' WHERE id=?").run(offer.job_id);db.exec("COMMIT");}
    catch(error){db.exec("ROLLBACK");throw error;}return send(res,200,{ok:true});
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
        res.setHeader("Access-Control-Allow-Headers","Content-Type");
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
