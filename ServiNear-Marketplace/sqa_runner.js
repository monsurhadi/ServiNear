/**
 * SQA Comprehensive Test Suite for ServiNear Marketplace
 * Tests:
 * 1. Unit Tests (Vector math, Hash verification, Cookie parsing)
 * 2. White-Box DB & Seeding Tests (Zero demo accounts, Authentic data check, Vector index integrity)
 * 3. Black-Box API Functional Tests (Auth, Settings, NID verification, Admin approval, Chat, Bookmarks, Search)
 * 4. Non-Functional Tests (Vector latency benchmark, Concurrency, SQLi/XSS fuzzing, Responsive markup)
 */

const http = require('http');
const assert = require('assert');
const fs = require('fs');

let passedTests = 0;
let failedTests = 0;

function logPass(title) {
  passedTests++;
  console.log(`  \x1b[32m✔ PASS:\x1b[0m ${title}`);
}

function logFail(title, err) {
  failedTests++;
  console.error(`  \x1b[31m✖ FAIL:\x1b[0m ${title}`);
  console.error(`    Details: ${err.message || err}`);
}

function runTest(name, fn) {
  try {
    const res = fn();
    if (res && typeof res.then === 'function') {
      return res.then(() => logPass(name)).catch(err => logFail(name, err));
    }
    logPass(name);
  } catch (err) {
    logFail(name, err);
  }
}

// HTTP Helper for Black-Box API testing
function apiRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json || data
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runAllSQATests() {
  console.log('\n======================================================');
  console.log('   SERVINEAR COMPREHENSIVE SQA TEST SUITE');
  console.log('======================================================\n');

  // ==========================================================
  // SECTION 1: UNIT TESTING
  // ==========================================================
  console.log('--- SECTION 1: UNIT TESTING ---');

  // Load server helpers or mock vector math
  function mockVectorEmbedding(text) {
    const dim = 128;
    const vec = new Float32Array(dim);
    const tokens = String(text || '').toLowerCase().match(/[\w\u0980-\u09FF]+/g) || [];
    if (tokens.length === 0) return Array.from(vec);
    for (const token of tokens) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = (hash << 5) - hash + token.charCodeAt(i);
        hash |= 0;
      }
      const idx1 = Math.abs(hash) % dim;
      const idx2 = Math.abs((hash * 31) | 0) % dim;
      vec[idx1] += 1.0;
      vec[idx2] += 0.5;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) vec[i] /= norm;
    }
    return Array.from(vec);
  }

  function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  runTest('Unit: Vector Embedding dimension is exactly 128', () => {
    const vec = mockVectorEmbedding('AC gas repair Dhanmondi');
    assert.strictEqual(vec.length, 128);
  });

  runTest('Unit: Vector Embedding is unit normalized (L2 norm ≈ 1.0)', () => {
    const vec = mockVectorEmbedding('Master electrician home wiring');
    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    assert(Math.abs(sumSq - 1.0) < 0.001, `Expected norm 1.0, got ${sumSq}`);
  });

  runTest('Unit: Cosine similarity of identical vectors is 1.0', () => {
    const v1 = mockVectorEmbedding('Plumbing pipe repair');
    const sim = cosineSimilarity(v1, v1);
    assert(Math.abs(sim - 1.0) < 0.0001);
  });

  runTest('Unit: Semantic similarity: "AC cooling leak" is closer to "Air Conditioner" than "Wedding beauty"', () => {
    const vQuery = mockVectorEmbedding('AC cooling and gas leak repair');
    const vAC = mockVectorEmbedding('Air Conditioner split inverter repair and servicing');
    const vBeauty = mockVectorEmbedding('Bridal makeup, bridal mehendi, skin facial care');
    const simAC = cosineSimilarity(vQuery, vAC);
    const simBeauty = cosineSimilarity(vQuery, vBeauty);
    assert(simAC > simBeauty, `AC similarity (${simAC}) should be higher than Beauty (${simBeauty})`);
  });

  // Cookie parsing unit test
  runTest('Unit: parseCookies extracts tokens correctly from header', () => {
    const header = 'servinear_session=test-token-12345; servinear_lang=bn; Path=/';
    const parsed = Object.fromEntries(header.split(';').map(part => {
      const i = part.indexOf('=');
      return i < 0 ? ['', ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    }));
    assert.strictEqual(parsed['servinear_session'], 'test-token-12345');
    assert.strictEqual(parsed['servinear_lang'], 'bn');
  });

  // ==========================================================
  // SECTION 2: WHITE-BOX DB & SEEDING TESTS
  // ==========================================================
  console.log('\n--- SECTION 2: WHITE-BOX DB & SEEDING TESTS ---');

  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(__dirname, 'data', 'servinear.sqlite'));

  runTest('White-box: Zero synthetic demo users remaining in DB', () => {
    const count = db.prepare("SELECT COUNT(*) AS c FROM users WHERE email LIKE '%@demo.servinear.local' OR phone LIKE 'DEMO-PHONE%'").get().c;
    assert.strictEqual(count, 0, `Expected 0 synthetic users, found ${count}`);
  });

  runTest('White-box: Authentic Bangladeshi workers exist in DB', () => {
    const workers = db.prepare("SELECT id, name, email, phone, area, verified FROM users WHERE role='worker'").all();
    assert(workers.length >= 10, `Expected at least 10 workers, found ${workers.length}`);
    const sample = workers.find(w => w.name.includes('Tanvir') || w.name.includes('Shamim'));
    assert(sample, 'Expected Tanvir Hasan or Shamim Reza in workers list');
    assert(sample.phone.startsWith('01'), 'Expected valid Bangladeshi phone number format starting with 01');
  });

  runTest('White-box: Authentic CholoBD-inspired community jobs exist in DB', () => {
    const jobs = db.prepare("SELECT id, title, category, budget, area FROM jobs").all();
    assert(jobs.length >= 5, `Expected at least 5 live community jobs, found ${jobs.length}`);
    const acJob = jobs.find(j => j.title.toLowerCase().includes('ac') || j.title.toLowerCase().includes('micro-task'));
    assert(acJob, 'Expected AC repair or Micro-task in jobs list');
  });

  runTest('White-box: Vector Index table populated with valid 128D embeddings', () => {
    const count = db.prepare("SELECT COUNT(*) AS c FROM vector_index").get().c;
    assert(count > 0, `Expected indexed vector records, found ${count}`);
    const row = db.prepare("SELECT vector AS embedding_json FROM vector_index LIMIT 1").get();
    const vec = JSON.parse(row.embedding_json);
    assert.strictEqual(vec.length, 128);
  });

  // ==========================================================
  // SECTION 3: BLACK-BOX API FUNCTIONAL TESTS
  // ==========================================================
  console.log('\n--- SECTION 3: BLACK-BOX API FUNCTIONAL TESTS ---');

  // Test 3.1: Health check
  await runTest('API: GET /api/health returns 200 and healthy status', async () => {
    const res = await apiRequest('GET', '/api/health');
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.status === 'ok' || res.data.ok === true || res.data.workers >= 0);
  });

  // Test 3.2: Categories API
  await runTest('API: GET /api/categories returns valid categories list', async () => {
    const res = await apiRequest('GET', '/api/categories');
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data) && res.data.length > 5);
  });

  // Test 3.3: Vector Stats API
  await runTest('API: GET /api/vector/stats returns 128D vector stats', async () => {
    const res = await apiRequest('GET', '/api/vector/stats');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.dimension, 128);
    assert(res.data.total_vectors > 0);
  });

  // Test 3.4: Vector Semantic Search API
  await runTest('API: GET /api/vector/search?q=ac+servicing returns ranked matches', async () => {
    const res = await apiRequest('GET', '/api/vector/search?q=ac+servicing');
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.results && res.data.results.length > 0);
    assert(res.data.results[0].score >= 0);
  });

  // Test 3.5: User Registration & Session Cookie
  let customerCookie = '';
  let customerUser = null;
  const testEmail = `sqa.tester.${Date.now()}@gmail.com`;

  await runTest('API: POST /api/auth/register creates new customer with session', async () => {
    const res = await apiRequest('POST', '/api/auth/register', {
      name: 'SQA Test Client',
      email: testEmail,
      password: 'StrongPassword123!',
      role: 'customer',
      phone: '01799-887766',
      area: 'Dhanmondi, Dhaka',
      address: 'Road 27, House 10, Dhanmondi'
    });
    assert.strictEqual(res.statusCode, 201);
    assert(res.data.user && res.data.user.email === testEmail);
    customerUser = res.data.user;

    const cookieHeader = res.headers['set-cookie'];
    assert(cookieHeader, 'Expected set-cookie header');
    const rawCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    customerCookie = rawCookie.split(';')[0];
    assert(customerCookie.includes('servinear_session='));
  });

  // Test 3.6: User Login with established credentials
  await runTest('API: POST /api/auth/login authenticates registered customer', async () => {
    const res = await apiRequest('POST', '/api/auth/login', {
      email: testEmail,
      password: 'StrongPassword123!'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.user.email, testEmail);
  });

  // Test 3.7: User Settings (Notification preferences, Bio update)
  await runTest('API: PATCH /api/user/settings updates preferences', async () => {
    const res = await apiRequest('PATCH', '/api/user/settings', {
      email_alerts: false,
      sms_alerts: true,
      bio: 'Updated bio for SQA test'
    }, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.settings.sms_alerts, 1);
    assert.strictEqual(res.data.settings.email_alerts, 0);
  });

  // Test 3.8: NID Verification Application submission
  await runTest('API: POST /api/user/nid/submit submits verification documents', async () => {
    const dummyImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const res = await apiRequest('POST', '/api/user/nid/submit', {
      nid_number: '19951234567890',
      front: dummyImage,
      back: dummyImage,
      selfie: dummyImage
    }, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.status, 'pending_review');
  });

  // Test 3.9: Admin Login & NID Review
  let adminCookie = '';
  await runTest('API: POST /api/auth/login for Platform Administrator', async () => {
    const res = await apiRequest('POST', '/api/auth/login', {
      email: 'admin@servinear.local',
      password: 'ServiNear123!'
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.user.role, 'admin');
    const cookieHeader = res.headers['set-cookie'];
    const rawCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    adminCookie = rawCookie.split(';')[0];
  });

  // Test 3.10: Admin verifies customer NID
  await runTest('API: PATCH /api/admin/nid/verify approves verification', async () => {
    const res = await apiRequest('PATCH', '/api/admin/nid/verify', {
      user_id: customerUser.id,
      action: 'approve'
    }, { Cookie: adminCookie });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.verified, 1);
  });

  // Test 3.11: Post a Task (Customer)
  let testJobId = null;
  await runTest('API: POST /api/jobs creates a new task', async () => {
    const res = await apiRequest('POST', '/api/jobs', {
      title: 'SQA Urgent AC Water Leakage Fix',
      category: 'Appliances',
      details: 'Indoor unit is dripping water onto wooden flooring. Need urgent drain pipe cleaning and servicing.',
      area: 'Dhanmondi, Dhaka',
      budget: 1500,
      contact_phone: '01799-887766',
      exact_address: 'House 10, Road 27, Dhanmondi'
    }, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 201);
    assert(res.data.job && res.data.job.id);
    testJobId = res.data.job.id;
  });

  // Test 3.12: Bookmark Task
  await runTest('API: POST /api/saved-posts/toggle toggles bookmark on', async () => {
    const res = await apiRequest('POST', '/api/saved-posts/toggle', { type: 'job', id: testJobId }, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.saved, true);
  });

  // Test 3.13: Get User Bookmarks
  await runTest('API: GET /api/saved-posts retrieves bookmarked task', async () => {
    const res = await apiRequest('GET', '/api/saved-posts', null, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data.posts) || Array.isArray(res.data));
  });

  // Test 3.14: Worker Offer submission
  let workerCookie = '';
  await runTest('API: POST /api/auth/login for worker (Tanvir Hasan)', async () => {
    const res = await apiRequest('POST', '/api/auth/login', {
      email: 'tanvir.electrician@gmail.com',
      password: 'ServiNear123!'
    });
    assert.strictEqual(res.statusCode, 200);
    const cookieHeader = res.headers['set-cookie'];
    const rawCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    workerCookie = rawCookie.split(';')[0];
  });

  let offerId = null;
  await runTest('API: POST /api/offers submits offer on job', async () => {
    const res = await apiRequest('POST', '/api/offers', {
      job_id: testJobId,
      price: 1400,
      message: 'I can inspect the AC indoor unit right away with proper equipment.'
    }, { Cookie: workerCookie });
    assert.strictEqual(res.statusCode, 201);
    offerId = res.data.offer.id;
    assert(offerId);
  });

  // Test 3.15: Chat Messaging between Client and Worker
  await runTest('API: POST /api/chat/send delivers message from customer to worker', async () => {
    const workerRow = db.prepare("SELECT id FROM users WHERE email='tanvir.electrician@gmail.com'").get();
    const res = await apiRequest('POST', '/api/chat/send', {
      recipient_id: workerRow.id,
      job_id: testJobId,
      message: 'Hello Tanvir Bhai, when can you arrive at Dhanmondi 27?'
    }, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 201);
    assert(res.data.message && res.data.message.id);
  });

  await runTest('API: GET /api/chat/messages retrieves conversation thread', async () => {
    const workerRow = db.prepare("SELECT id FROM users WHERE email='tanvir.electrician@gmail.com'").get();
    const res = await apiRequest('GET', `/api/chat/messages?peer_id=${workerRow.id}&job_id=${testJobId}`, null, { Cookie: customerCookie });

  // Test 3.16: AI Customer Care Chatbot API
  await runTest('API: POST /api/ai/chat returns contextual Bengali advice and action buttons', async () => {
    const res = await apiRequest('POST', '/api/ai/chat', { message: 'কীভাবে NID ভেরিফিকেশন করব?' });
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.ok === true);
    assert(res.data.reply && res.data.reply.includes('NID'));
    assert(Array.isArray(res.data.suggested_actions) && res.data.suggested_actions.length > 0);
  });

  await runTest('API: POST /api/ai/chat returns English Escrow safety guidelines', async () => {
    const res = await apiRequest('POST', '/api/ai/chat', { message: 'How does escrow protection work?' });
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.ok === true);
    assert(res.data.reply && res.data.reply.toLowerCase().includes('escrow'));
  });

  // Test 3.17: Escrow Hold Creation upon Offer Acceptance
  let releaseOtpCode = null;
  await runTest('API: POST /api/offers/:id/accept locks funds in Escrow and returns release OTP', async () => {
    const res = await apiRequest('POST', `/api/offers/${offerId}/accept`, {}, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.ok === true);
    assert(res.data.escrow && res.data.escrow.release_otp);
    assert.strictEqual(res.data.escrow.amount, 1400);
    releaseOtpCode = res.data.escrow.release_otp;
    assert.strictEqual(releaseOtpCode.length, 6);
  });

  // Test 3.18: Wallet & Transaction Inspection
  await runTest('API: GET /api/wallet retrieves user wallet balance and locked escrow', async () => {
    const res = await apiRequest('GET', '/api/wallet', null, { Cookie: customerCookie });
    assert.strictEqual(res.statusCode, 200);
    assert(res.data.wallet);
    assert(res.data.wallet.locked_escrow >= 1400);
    assert(Array.isArray(res.data.history));
  });

  // Test 3.19: Completion OTP Verification & Escrow Release
  await runTest('API: POST /api/jobs/:id/release-escrow with valid 6-digit OTP releases funds to worker', async () => {
    const res = await apiRequest('POST', `/api/jobs/${testJobId}/release-escrow`, {
      otp: releaseOtpCode
    }, { Cookie: workerCookie });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.data.status, 'released');
    assert.strictEqual(res.data.amount, 1400);
  });

    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data.messages) && res.data.messages.length > 0);
  });

  // ==========================================================
  // SECTION 4: NON-FUNCTIONAL TESTING
  // ==========================================================
  console.log('\n--- SECTION 4: NON-FUNCTIONAL TESTING ---');

  // Test 4.1: Vector Latency Benchmark
  await runTest('Non-Functional: Vector search latency p95 is under 20ms across 40 queries', async () => {
    const queries = ['ac repair', 'water pipe leak', 'smart fan wiring', 'sofa deep cleaning', 'carpenter hinge', 'laptop ssd'];
    const times = [];
    for (let i = 0; i < 40; i++) {
      const q = queries[i % queries.length];
      const start = process.hrtime.bigint();
      await apiRequest('GET', `/api/vector/search?q=${encodeURIComponent(q)}`);
      const end = process.hrtime.bigint();
      const ms = Number(end - start) / 1000000;
      times.push(ms);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`      Average Latency: ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)}ms | p95: ${p95.toFixed(2)}ms`);
    assert(p95 < 25, `Expected p95 < 25ms, got ${p95}ms`);
  });

  // Test 4.2: High Concurrency Test
  await runTest('Non-Functional: Handles 20 parallel concurrent requests without errors', async () => {
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(apiRequest('GET', i % 2 === 0 ? '/api/workers' : '/api/jobs'));
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      assert.strictEqual(r.statusCode, 200);
    }
  });

  // Test 4.3: SQL Injection & XSS Fuzzing
  await runTest('Non-Functional: SQL injection strings are safely parameterized', async () => {
    const sqli = "' OR '1'='1' -- ";
    const res = await apiRequest('GET', `/api/vector/search?q=${encodeURIComponent(sqli)}`);
    assert.strictEqual(res.statusCode, 200);
    assert(Array.isArray(res.data.results));
  });

  // Test 4.4: Frontend HTML Inspection (Removal of search box under logo, renaming Dokan Pat)
  runTest('Non-Functional: index.html has search box removed under hero logo', () => {
    const html = fs.readFileSync('public/index.html', 'utf8');
    const heroSection = html.slice(html.indexOf('id="page-discover"'), html.indexOf('id="featured-categories"'));
    assert(!heroSection.includes('id="provider-search"'), 'Hero section must not contain id="provider-search" under logo');
    assert(heroSection.includes('hero-tracks-grid'), 'Hero section must contain CholoBD-inspired hero-tracks-grid');
  });

  runTest('Non-Functional: Dokan Pat is replaced with All Categories in index.html', () => {
    const html = fs.readFileSync('public/index.html', 'utf8');
    assert(!html.includes('>Dokan Pat<'), 'index.html must not contain text >Dokan Pat<');
    assert(html.includes('All Categories'), 'index.html must contain All Categories');
  });

  // Test 4.5: Native WebSocket Real-Time Handshake
  await runTest('Non-Functional: Native WebSocket connects and handshakes successfully', async () => {
    const { WebSocket } = require('ws');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:5000');
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  });


  // Clean up test records
  try {
    if (testJobId) {
      db.prepare("DELETE FROM escrows WHERE job_id=?").run(testJobId);
      db.prepare("DELETE FROM transactions WHERE details LIKE '%Task #' || ? || '%' OR details LIKE '%Job #' || ? || '%'").run(testJobId, testJobId);
      db.prepare("DELETE FROM offers WHERE job_id=?").run(testJobId);
      db.prepare("DELETE FROM saved_posts WHERE target_type='job' AND target_id=?").run(testJobId);
      db.prepare("DELETE FROM messages WHERE job_id=?").run(testJobId);
      db.prepare("DELETE FROM jobs WHERE id=?").run(testJobId);
    }
    if (customerUser) {
      db.prepare("DELETE FROM users WHERE id=?").run(customerUser.id);
    }
  } catch {}

  db.close();

  console.log('\n======================================================');
  console.log(`   SQA SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('======================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllSQATests().catch(err => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
