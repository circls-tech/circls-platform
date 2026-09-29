# Circls Sandbox — run the whole app on your own machine

Everything runs locally and offline. You cannot affect production, real users,
real payments, or send real emails/SMS. Break things freely — `./sandbox reset`
puts it back.

## One-time setup
1. Ask the maintainer to give your GitHub account **Write** access to the `circls-tech/circls-platform` repo (one-time).
2. Install **Docker Desktop** and the **GitHub CLI** (`gh`). Open Docker Desktop so it's running.
3. Sign in to GitHub: `gh auth login`.
4. Get the project:
   ```
   git clone https://github.com/circls-tech/circls-platform.git
   cd circls-platform
   ```
5. Run the setup (builds the app — a few minutes):
   ```
   ./sandbox setup
   ```
6. Quick check it worked: run `git remote -v`. The **origin** line should show `circls-tech/circls-platform`.

## Daily use
- Start everything:  `./sandbox up`
- Create demo logins: `./sandbox seed`  (run once after the first `up`)
- Open:
  - Partner portal — http://localhost:3001
  - Admin console  — http://localhost:3002
  - Consumer web   — http://localhost:3003
- **Logging in** (demo accounts printed by `./sandbox seed`):
  - Admin console & Partner portal — **email + password**: `admin@sandbox.local` / `partner@sandbox.local`, password `sandbox123`.
  - Consumer web — **phone OTP**: phone `+15555550102`; the OTP code is shown in
    the **Emulator UI** at http://localhost:4000 (and in
    `./sandbox logs firebase-emulator`). No real SMS is sent.
- **Emails** the app "sends" land in the inbox at http://localhost:8025.
- Messed it up? `./sandbox reset` — wipes and reseeds to a clean state.
- Stop: `./sandbox down`

## Payments
Payments are simulated: with no gateway keys, a paid checkout just reserves the
booking. To try Cashfree's real test checkout, put your Cashfree **test** keys
in the gitignored `.env` at the repo root (never in `.sandbox/env/api.env`,
which is committed):

    CASHFREE_CLIENT_ID=...
    CASHFREE_CLIENT_SECRET=...

Run `./sandbox up` again: with the keys set, Indian payments go to Cashfree by
default, as in production (the admin console's **Payments** page can switch
them). The sandbox always uses Cashfree's test environment. Cashfree's webhooks
can't reach your machine without a tunnel, but the checkout still confirms
payments by asking Cashfree directly.

## Shipping your work
Ask Claude Code to commit your changes, create a feature **branch in this repo**,
push the branch to `origin`, and **open a pull request against `main`**. A
maintainer reviews and merges.
