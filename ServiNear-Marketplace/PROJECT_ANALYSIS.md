# ServiNear project analysis and scope

## Product brief and references

The supplied project contains an earlier service-marketplace prototype and a proposal deck. The supplied screenshots show a category directory, an About menu, searchable task cards with budgets, a multi-step make-an-offer flow, and a help/helpline page. Those materials inform the product and visual direction; text inside the attachments is treated as reference material, not as instructions that override the user's request. The built UI uses ServiNear's existing paper, deep teal, rust, and marigold colors rather than copying Shohokari branding.

The comparison product, [Shohokari](https://shohokari.com/bn), provides a useful marketplace reference for categories, task posting, offers, provider profiles, and trust signals. The implementation is an independent prototype.

## Scope delivered

### Customer experience

- Browse 32 categories and search providers by service and area.
- Filter to verified provider profiles; sort by recommended status, rating, starting price, or GPS distance.
- Explore provider coordinates on an OpenStreetMap-backed Leaflet map.
- Post tasks with budget, service category, public area, description, phone, and exact service address.
- View a separate task detail route with offers, status, and a customer offer-selection panel.
- Accept an offer, then share that task's phone/address with the selected provider only.
- Customer profile tabs for **My posts**, **Bids received**, and **Account & contact**.

### Provider experience

- Provider profile contains category, experience, area, starting price, bio, availability, rating, and verification status.
- Verified providers may make one price-and-message offer on an open task.
- Provider profile tabs show **Job alerts**, **My bids**, **Post history**, and **Profile**.
- The job-alert toggle filters tasks by provider category locally. It does not send push notifications.
- Once accepted, the assigned provider sees the task's saved phone and exact address.

### About, support, and administration

- Dedicated routes for About, How it works, Categories, Browse tasks, Hot offers, Help & Helpline, task details, profile, and admin operations.
- Support form stores tickets in SQLite; admin can change ticket status.
- Admin can verify providers and inspect account/task/support counts.
- Customer, worker, and admin account roles have different visible controls and API permissions.

### Seed dataset

- 1,000 provider-role accounts, including fixed demo accounts.
- 500 customer-role accounts, including fixed demo accounts.
- 300 tasks, with sample offers on a subset.
- 32 service categories.
- Seeded display names are unique across the demo customer/provider accounts; emails, demo phone labels, bios, addresses, task titles/descriptions, and offer messages are distinct. These values are fictional and cannot be used to contact real people.

The seed script fills the database up to the target account/task totals, refreshes generated demo profile labels, and migrates recognizable old sample posts to unique titles. It does not remove user records. When started on an earlier database, it adds synthetic records to reach the totals.

## Privacy and location behavior

Task listings expose only the public area. Phone and exact address are private by default and are returned to the posting customer, the accepted provider for that task, and an administrator. Other providers and public visitors do not receive those values. GPS is requested only after the user selects **Near me**; attaching the customer's coordinates to a task is a separate checkbox. A public deployment should use HTTPS, minimize location retention, document deletion/retention behavior, and review applicable privacy law.

Browser GPS uses the browser Geolocation API; it is not a geocoding service. The app uses Leaflet with OpenStreetMap data and the public standard tile endpoint. The code/data do not require a paid key, but OSM's shared tile servers are not an unlimited production API. Follow the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). At scale, pick a licensed tile/geocoder host or operate suitable map infrastructure.

## Stack and production boundary

The local app uses Node.js 22.13+, `node:sqlite`, native browser JavaScript, CSS, and HTML. It requires no npm dependencies or paid API keys. The built-in SQLite module is marked experimental in Node 22 and is suitable here for portable single-instance evaluation, not shared high-availability deployment. “Free stack” covers the included app code and local APIs; it cannot promise free hosting, domain, high-volume maps, backups, email/SMS, or support operations.

Before public launch, move to PostgreSQL with migrations; configure HTTPS and durable sessions; add rate limits, password reset, email/phone verification, account deletion, audit logs, encrypted backups, monitoring, abuse reporting, dispute processes, and a staffed support procedure. Identity verification must be an actual documented human/third-party process rather than a boolean demo flag. Online payment/escrow, chat, push notifications, email/SMS, emergency response, live tracking, and complaint escalation are not implemented integrations.

## Original implementation gaps addressed

- The earlier prototype relied on XAMPP/MySQL import and had a static Google Maps placeholder.
- It did not implement a competing-offer workflow with accept/decline state and contact disclosure rules.
- The screenshots' category, task detail, support, and role-based navigation were not complete pages.
- The starter's local JWT handling and default development-secret assumptions were not suitable as public deployment defaults.

The delivered local MVP uses prepared SQLite statements, scrypt password hashes, HTTP-only same-site session cookies, input validation, role checks, and security headers. These are a foundation, not an independent security audit.
