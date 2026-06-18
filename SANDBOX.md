# Circls Sandbox — run the whole app on your own machine

Everything runs locally and offline. You cannot affect production, real users,
real payments, or send real emails/SMS. Break things freely — `./sandbox reset`
puts it back.

## One-time setup
1. Ask the maintainer to give your GitHub account **Read** access to the `circls-tech` org repo (one-time).
2. Install **Docker Desktop** and the **GitHub CLI** (`gh`). Open Docker Desktop so it's running.
3. Sign in to GitHub: `gh auth login`.
4. Get the project:
   ```
   gh repo clone circls-tech/circls-platform
   cd circls-platform
   ```
5. Run the setup (forks the repo to **your** account, installs the safety guard, builds the app — a few minutes):
   ```
   ./sandbox setup
   ```
6. Quick check it worked: run `git remote -v`. The **origin** line should show **your-username/circls-platform** (your personal fork). If it still shows `circls-tech`, tell the maintainer before continuing.

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

## Shipping your work
Ask Claude Code to commit your changes and **open a pull request**. You cannot
push to the main project — that is intentional. A maintainer reviews and merges.
