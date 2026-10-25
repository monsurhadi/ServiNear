# ServiNear Marketplace

A local, database-backed service marketplace inspired by the supplied UI references and the original ServiNear project's warm paper, deep teal, rust, and marigold visual language. The app uses a free, no-install local stack: Node.js, built-in SQLite, browser JavaScript, Leaflet, and OpenStreetMap tiles.

## What is included

- 32 task/service categories with a searchable provider directory and responsive category pages.
- Provider discovery by service and area; verified-only, rating, price, and optional GPS-distance sorting; map view with up to 150 visible provider pins.
- Separate pages for task browsing, task details, hot offers, About, How it works, Helpline, customer/provider profiles, and admin operations.
- Customer task posts with a public area, budget, private phone and exact address, and optional customer-authorized GPS coordinates.
- Provider offers with a price and message; customers can review offers and accept one.
- Customer workspace: My posts, Bids received, Account & contact.
- Provider workspace: Job alerts, My bids, Post history, Profile. Job alerts can be toggled to the provider's category; this is an in-app filter, not push notification delivery.
- After offer acceptance, the chosen provider and task customer can see that task's phone/address. Public visitors and other providers cannot.
- Admin workspace for provider verification and helpline ticket status.
- Seed data: 1,000 service-provider accounts, 500 customer accounts, 300 uniquely titled tasks, and sample offers. Seeded names, emails, phones, bios, task titles, descriptions, addresses, and offer messages are distinct. All contact values and addresses are synthetic.

## Requirements and costs

- Windows, macOS, or Linux
- Node.js 22.13 or newer
- No `npm install`, database server, paid API key, or paid GPS service
- Internet is needed for the map tiles, icons, and fonts; the core marketplace runs locally without map tiles.

SQLite is provided by Node's built-in `node:sqlite` API. In Node 22 this API is marked experimental. The app creates and seeds `data/servinear.sqlite` on first launch. It fills the database up to the listed minimum counts, refreshes generated demo names/bios, and upgrades recognizable older sample tasks to unique titles without deleting user records. The SQLite database is local to the machine and the app process; it is not a hosted, multi-user internet service.

GPS uses the browser's Geolocation API, which asks for permission. It works on `localhost` and requires HTTPS when hosted elsewhere. The map uses Leaflet and OpenStreetMap's public tile endpoint without an API key. Public OSM tile servers are community-funded and best-effort, not an unlimited production API. Follow their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). A public service may need paid hosting, domain, tile/geocoding capacity, backups, monitoring, email/SMS, and operational support even when its software stack is free.

## Run on Windows

1. Install Node.js 22.13 or newer from [nodejs.org](https://nodejs.org/).
2. Extract `ServiNear-Marketplace.zip` to a folder you can write to.
3. Open that folder in File Explorer. Click the address bar, type `powershell`, and press Enter.
4. Check the installed version and start the app:

   ```powershell
   node --version
   npm start
   ```

5. Wait for `ServiNear is ready at http://localhost:5000`. First start creates SQLite and seeds 1,800 accounts plus tasks/offers, so allow a few seconds.
6. Open [http://localhost:5000](http://localhost:5000) in your browser. Keep the terminal open while using the app. Press `Ctrl+C` to stop it.

If port 5000 is busy, start with another port:

```powershell
$env:PORT=5050
npm start
```

Then open `http://localhost:5050`.

## Production setup

1. Copy `.env.example` to `.env` (or set the same variables in your host) and fill in the values.
2. **Administrator:** set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (14+ characters). The account is created on first boot. In production the old demo admin (`admin@servinear.local`) is suspended automatically.
3. **Google sign-in:** create an OAuth *Web application* client in Google Cloud Console, add your site origin under *Authorized JavaScript origins*, and set `GOOGLE_CLIENT_ID`. The server verifies every Google ID token (signature, audience, expiry, verified email); admins sign in with a password only.
4. **Demo data** is loaded only outside production, or when `SEED_DEMO_DATA=true`. Demo accounts share the password `ServiNear123!`, so never enable them alongside real customers.
5. Open `/admin` while signed in as an administrator for the control dashboard (users, tasks, verification, payments, reviews, support, categories, audit log, CSV export).
6. Run `npm test` for the end-to-end smoke tests (also executed by CI).

### Payments, phone verification and search (new)

| Feature | How it works | Turn it on |
| --- | --- | --- |
| **Wallet top-up** | Customers pay through SSLCOMMERZ (bKash, Nagad, Rocket, cards). Every payment is confirmed server-to-server with the gateway before the wallet is credited, exactly once. Risky payments are held for admin review. | `PAYMENT_PROVIDER=sslcommerz`, `SSLCOMMERZ_STORE_ID`, `SSLCOMMERZ_STORE_PASSWORD`, `PUBLIC_API_URL` |
| **Funded escrow** | Accepting an offer moves the price from the customer's wallet into escrow. If the wallet is short, the app asks for exactly the shortfall and finishes the acceptance after payment. | automatic |
| **Payouts** | Providers request a withdrawal to their *verified* bKash/Nagad/Rocket number. Admins send the money and record the reference in `/admin` > Payments; declined payouts return to the wallet. | automatic |
| **Phone OTP** | 6-digit single-use codes, hashed, expiring in 5 minutes, 5 attempts, resend cooldown, per-user/phone/IP limits. One verified account per number. | `SMS_PROVIDER` (+ provider keys) |
| **Semantic search** | Providers and tasks are embedded by a real model, ranked together with keywords, verified status, rating and distance. Falls back to keyword search if the provider is down. | `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY` |

Development uses a mock gateway and a console SMS provider (the OTP is printed in the server log and returned as `dev_code`). Both are refused when `NODE_ENV=production`. `npm test` runs three suites (core, money/phone, search).

**Business decisions you still need to make:** who pays the gateway fee (currently ServiNear absorbs it, so a ৳1,000 top-up credits ৳1,000), your platform commission on completed tasks (currently none), and refund policy for disputes (admins decide per case in `/admin`).

## Demo accounts (development only)
All fixed and generated demo accounts use password `ServiNear123!`.

| Role | Email |
| --- | --- |
| Customer | `nusrat.jahan@gmail.com` |
| Second customer | `tariqul.islam@gmail.com` |
| Verified provider | `tanvir.electrician@gmail.com` |
| Administrator | `admin@servinear.local` |

Use the dialog's demo buttons for the customer, provider, and admin accounts. These accounts and all contact values are synthetic demo data.

## Try the main workflow

1. Log in as the customer and choose **Post task**. Add a title, category, public area, description, synthetic/demo contact phone, and exact address.
2. Log in as the verified provider, browse tasks, open the task detail page, and select **Make an offer**.
3. Log in again as the customer, open the task, and accept the provider's offer. The chosen provider can now see the contact phone and exact address for that task; other providers cannot.
4. Log in as the selected provider and open the task to see the accepted assignment and contact details, then mark it complete.
5. Visit **My profile** to see the role-specific workspace. The customer sees posts and offers received. The provider sees job alerts, bids, and task history.
6. Submit a ticket from **Help & Helpline**. Log in as admin and update the request status in the admin workspace.

## Database and project files

`data/servinear.sqlite` stores users, categories, tasks, offers, reviews, and support requests. Keep a backup before moving or replacing it. To start with a fresh local dataset, stop the app and remove only the local `data/servinear.sqlite` plus its `-shm` and `-wal` siblings; the next launch will reseed it. Do not include a live database in the project ZIP.

- `server.js` — Node HTTP API, sessions, SQLite schema/seeds, authorization, and static hosting
- `public/index.html` — app pages and workflow dialogs
- `public/app.js` — routes, filters, map, offers, account workspaces, and support interactions
- `public/styles.css` — responsive visual system
- `PROJECT_ANALYSIS.md` — project scope and production considerations

## Production-readiness boundary

The included Vercel/Docker setup is a public-pilot deployment path, not a claim that the app is production-ready. The backend uses SQLite and in-memory sessions; a container restart logs users out. It does not yet have rate limits, verified email/phone, password reset, admin audit trails, actual identity checks, backups/restore automation, or operational incident response. Do not put real customer data or take payments until these are addressed. The Docker volume persists the SQLite file but is not a managed PostgreSQL service.

## Deploy the frontend to Vercel and the API on your laptop

This split setup requires a custom domain you control, Docker Desktop, a Cloudflare account managing that domain (for the tunnel), a GitHub account, and a Vercel account. Use sibling hostnames such as `app.yourdomain.com` and `api.yourdomain.com`; this keeps secure session cookies same-site. A Vercel `*.vercel.app` hostname paired with an unrelated API hostname may have browser third-party-cookie issues.

**Important:** your laptop becomes the public backend and database host. If it sleeps, reboots, loses power, Docker stops, or home internet fails, the app's API goes offline. This is not reliable production hosting. Keep the machine patched, encrypted, always-on, backed up, and monitored. For a real launch, move the API and database to an always-on host and managed PostgreSQL. Also, Vercel's free Hobby plan is for personal/non-commercial use; a marketplace intended for business use needs a Vercel plan that permits commercial use. Check the current [Vercel Hobby terms](https://vercel.com/docs/plans/hobby).

### 1. Set up the laptop backend

1. Install and start Docker Desktop. Extract this project and open PowerShell in the `ServiNear-Marketplace` folder.
2. Create the private environment file and edit the four values to match the domain and admin account you control:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Set `WEB_ORIGIN=https://app.yourdomain.com`, `COOKIE_DOMAIN=.yourdomain.com`, an admin email, and a unique admin password with at least 14 characters. Do not commit `.env` or send its contents to anyone.
3. Build and start the API container:

   ```powershell
   docker compose up --build -d
   docker compose ps
   Invoke-RestMethod http://localhost:5000/api/health
   ```

   The database is stored in the Docker named volume `servinear_data`. Demo accounts/tasks are disabled in this compose profile. Category records and the initial admin account are created on first boot. The API binds only to laptop loopback, not directly to the public network.
4. For a simple consistent manual backup, pause the API briefly, copy the database file from the stopped container, then restart:

   ```powershell
   docker compose stop servinear-api
   docker cp servinear-api:/app/data/servinear.sqlite .\servinear-backup.sqlite
   docker compose start servinear-api
   ```

   Move that backup off the laptop using encrypted backup storage. This manual process is not an automated or tested backup/restore plan.

### 2. Publish the API through Cloudflare Tunnel

1. In Cloudflare Zero Trust, create a named Tunnel and install/run its connector on the laptop.
2. Add a **Published application** route with hostname `api.yourdomain.com` and service `http://localhost:5000`. Do not expose the Docker database port. Cloudflare documents this hostname-to-local-service pattern in [Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/).
3. Confirm `https://api.yourdomain.com/api/health` returns `{ "ok": true, ... }`. Confirm the API hostname is HTTPS and resolves through your tunnel.

### 3. Deploy the frontend to Vercel

1. Push this project folder to a GitHub repository. Import that repository into Vercel.
2. Configure the project root as the repository root if `package.json` is at the repository root; otherwise set **Root Directory** to `ServiNear-Marketplace`.
3. Use the included `vercel.json` settings: build command `npm run build:vercel`, output directory `dist`, framework **Other** (or no framework preset).
4. In Vercel Project Settings → Environment Variables, add `SERVINEAR_API_BASE=https://api.yourdomain.com` for Production, then redeploy. The build script writes that public API origin into the static client bundle; never put secrets in this variable.
5. Add `app.yourdomain.com` as the Vercel production domain and complete the DNS instructions Vercel provides. Ensure the app and API hostnames use the same registrable domain as configured by `.env`.
6. Visit `https://app.yourdomain.com`, create a customer and provider account, and verify task posting/offers. Only test with fictional contact details until production security and privacy controls are implemented.

The `vercel.json` SPA rewrite keeps routes such as `/categories` and `/tasks/123` loading on refresh. Vercel supports static output and external routing/configuration, but it will not run this Node API; the API stays in Docker on your laptop. See [Vercel rewrites](https://vercel.com/docs/routing/rewrites) and [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json).
