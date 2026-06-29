# Start here — how we work

Welcome! This is the short version of how we ship changes. It takes 5 minutes to
read and saves everyone (especially across timezones) a lot of back-and-forth.

> Deeper detail lives in [`SANDBOX.md`](../SANDBOX.md) (running the app locally)
> and [`docs/CONTRIBUTING.md`](./CONTRIBUTING.md) (the full contribution loop).

## What changed (if you used the old fork flow)

- **No more forking.** You now have **Write** access to the main repo. Clone it
  directly and work on branches inside it.
- A safety **ruleset** protects `main`/`release` for you — you literally cannot
  break them, so you don't have to be careful, just follow the loop.
- When you get stuck, you ask **`@claude`** on your PR instead of pinging a human.

## One-time setup

1. Ask the maintainer for **Write** access to `circls-tech/circls-platform`.
2. Install the GitHub CLI (`gh`) and Docker Desktop. Sign in: `gh auth login`.
3. Clone and set up:
   ```
   git clone https://github.com/circls-tech/circls-platform.git
   cd circls-platform
   ./sandbox setup
   ```
4. Run it: `./sandbox up`, then `./sandbox seed` once for demo logins. (See
   [`SANDBOX.md`](../SANDBOX.md) for the full list of local URLs and commands.)

## The loop — how to ship a change

1. **Start a branch** in the repo: `git checkout -b my-change`
2. **Make your change** (with your Claude Code agent as usual).
3. **Push the branch** and **open a Pull Request** against `main`.
4. **Wait for the green checks** (`verify` + `db`) **and the maintainer's
   approval.** The maintainer merges — you don't.

That's it. You never push to `main` or `release`, and you never merge.

## Stuck? Don't call — ask `@claude` on the PR

Comment one of these directly on your pull request:

- `@claude this PR has conflicts with main — rebase and resolve them`
- `@claude the failing check needs fixing, please fix it`
- `@claude address the review comments above`

The bot fixes your branch for you. (These also appear in the PR template.)

## Filing work

Open a **New issue** and pick a form: **Bug report**, **Change request**, or
**Question**. Filling the form in full means we can act on it without a follow-up
call. (Questions often have answers in the Partner Help Centre — there's a link
on the issue page.)

## Where to check status (instead of asking)

- The **[Circls Delivery board](https://github.com/orgs/circls-tech/projects/1)** —
  every issue/PR flows through `Backlog → Ready to release → Released`.
- The pinned **🚀 Release tracker** issue — what's merged and waiting to go live.
- The **twice-daily Teams digest** — review queue, failing checks, conflicts,
  and anything blocked.

**Please look there first.** "Where's my thing?" almost always has a self-serve
answer.

## Need a decision from the maintainer?

Add the **`needs-vedant`** label and write the question on the issue/PR. It shows
up in the digest under **"Blocked on product decision."** The maintainer reviews
once a day (~08:00 IST) and clears these in a batch — **no call needed.**

## The only hard rules

- ❌ Never push to `main` or `release` (a push to `release` deploys to production).
- ❌ Never merge a PR — the maintainer does that.
- ❌ Never force-push or delete `main`/`release`, and never use `--no-verify`.
- ✅ Always: branch → push → PR → green checks + approval.
