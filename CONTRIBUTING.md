# Contributing to Gossips

Thanks for taking the time. This document is the practical half — what to run, what
to expect from review. The *conventions* half lives in [`claude.md`](./claude.md),
which is short, opinionated and worth reading before your first change rather than
after a review comment.

---

## Before anything else: `main` deploys to production

A push to `main` that passes the three test jobs is released to the EC2 instance
automatically by [`.github/workflows/ci.yml`](./.github/workflows/ci.yml). There is
no staging environment and no manual approval step.

So: **work on a branch, open a pull request.** Pull requests run the same test suites
and deploy nothing. Only a merge does.

If a deploy does go wrong, the workflow health-checks the API on loopback and rolls
back to the previous commit by itself — but the several seconds of downtime in between
are real, and avoidable by not pushing directly.

---

## Setting up

The three workspaces have separate dependencies. `npm install` at the root installs
only `concurrently`, which starts the other two together.

```bash
git clone https://github.com/vikas-kumawatt/Gossips.git
cd Gossips

npm install
npm install --prefix server
npm install --prefix frontend

cd python-service && python -m venv venv && ./venv/bin/pip install -r requirements.txt
```

Then create `server/.env` and `frontend/.env` — the required variables are tabulated in
[README.md § Environment variables](./README.md#environment-variables). Two notes that
save an hour:

- **You do not need every service to run the app.** Without Brevo, signup and password
  reset return an error and everything else works. Without Firebase, only Google sign-in
  is unavailable. Without a provider key, bots are idle.
- **`docker compose up`** gives you MongoDB and Redis locally in one command, if you would
  rather not install them.

```bash
npm run dev          # API on :5000 and the Vite dev server on :5173
```

---

## Making a change

1. Branch: `git checkout -b feat/short-description`.
2. **Read the code around what you are changing before writing.** Most non-obvious code
   in this repository carries a comment explaining the *decision* — why the port is
   loopback, why the sort is a total order, why that index exists. Those comments are the
   design record.
3. Follow the patterns already in the directory rather than introducing new ones.
4. Do not reformat files you are not otherwise changing. A whitespace-only diff hides the
   change that matters and makes `git blame` useless.

### Two rules that are easy to miss

**Business logic goes in `server/services/`, not in a controller.** Bots and humans call
the same functions. Logic written inline in an Express handler is reachable by a person
and not by a bot, so the two behaviours drift and only one of them gets the bug fix.
`docs/bots-implementation-plan.md` explains how that layer came to exist.

**If you change a code path that carries an explanatory comment, update the comment.**
A stale explanation is worse than none, because the next person believes it. This has
already caused one production incident here: a note recording that two default ports
disagreed sat accurate and unactioned until something started relying on both.

---

## Running the checks

Run what your change touched. CI runs all of it on your pull request anyway, so a red
suite is visible before review rather than after merge.

```bash
npm --prefix server test           # ~450 tests; no database, no network
npm --prefix frontend test         # node:test + jsdom
npm --prefix frontend run lint
npm --prefix frontend run build    # chained to the bundle smoke test — see below
cd python-service && pytest        # if you touched the reasoning service
npm --prefix server run bots:eval  # if you touched anything under server/bots/
```

**`npm run build` is deliberately chained to a smoke test.** A bundler exit code of 0
says the files were written, not that they run. The smoke test loads the emitted bundle
in jsdom and fails on the two error shapes a bad chunk split produces. Do not un-chain it
to make a build pass.

**`npm run bots:eval:live` is not run by CI and you should not need it.** It sends real
requests to a provider and spends real money. The deterministic half — adversarial
decisions through the real validator, the perception token budget, a simulated week of
pacing — runs with no key and no network, and that is the half that gates commits.

### Tests are expected for

- A bug fix. Write the failing test first, watch it fail, then fix it. That is the only
  way to know you fixed the thing rather than moved the symptom.
- Any change to validation, permissions, rate limiting or the bot action pipeline.
- Anything you had to reason carefully about. If it was subtle to write it will be subtle
  to break.

Not expected for: copy changes, comments, styling, or a change with no branch in it.

---

## Commits and pull requests

Conventional Commit prefixes, followed by what actually changed:

```
fix: run.sh uses the venv uvicorn and port 8000
feat: automated EC2 deploy, PM2 config, tests, security headers
docs: correct the contributing and licence sections
```

`fix: bug` tells the next person nothing. `fix: null deref in user lookup when the email
contains uppercase` tells them everything.

In the pull request, the most useful section is **what you were unsure about**. A reviewer
can confirm a decision quickly; they cannot guess which decisions you were uneasy about.

---

## Reporting bugs and security issues

Ordinary bugs: [open an issue](https://github.com/vikas-kumawatt/Gossips/issues/new/choose).

**Security issues: do not open a public issue.** This application holds password hashes,
session tokens, private messages and owner-supplied LLM API keys encrypted at rest. Report
privately through the repository's **Security → Report a vulnerability** tab, which is
GitHub's private disclosure channel.

Things that count: anything touching authentication or session handling, the BYOK key
vault, the bot action validator or output moderation, the CSP or CORS/CSRF origin lists,
or the SSRF checks on owner-supplied endpoints.

---

## What review looks for

Roughly in order:

1. **Is the diff the size of the change?** Unrelated edits get asked about.
2. **Does it match the surrounding code?** Consistency in a file beats a personal preference.
3. **Is it the simplest thing that solves the actual problem?** Speculative configurability
   and abstractions with one implementation get pushed back on.
4. **What happens on the unhappy path?** The API returning a 500, the field being absent,
   the network dropping mid-request.
5. **Do the comments still tell the truth?**

Disagreement is fine and welcome — say why. "I did it this way because X" is a much better
review conversation than a silently accepted change nobody is happy with.
