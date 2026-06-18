# Circls Sandbox — run the whole app on your own machine

Everything runs locally and offline. You cannot affect production, real users,
real payments, or send real emails/SMS. Break things freely — `./sandbox reset`
puts it back.

## One-time setup
1. Install **Docker Desktop** and the **GitHub CLI** (`gh`), then `gh auth login`.
2. In the project folder, run: `./sandbox setup`
   (this forks the repo to your own GitHub account and builds the app — a few minutes).

## Daily use
- Start everything:  `./sandbox up`
- Create demo logins: `./sandbox seed`  (run once after the first `up`)
- Open:
  - Partner portal — http://localhost:3001
  - Admin console  — http://localhost:3002
  - Consumer web   — http://localhost:3003
- **Logging in:** use the demo phone numbers printed by `./sandbox seed`. The
  OTP code is shown in the **Emulator UI** at http://localhost:4000 (and in
  `./sandbox logs firebase-emulator`). No real SMS is sent.
- **Emails** the app "sends" land in the inbox at http://localhost:8025.
- Messed it up? `./sandbox reset` — wipes and reseeds to a clean state.
- Stop: `./sandbox down`

## Shipping your work
Ask Claude Code to commit your changes and **open a pull request**. You cannot
push to the main project — that is intentional. A maintainer reviews and merges.
