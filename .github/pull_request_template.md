<!--
Merging to main deploys to production automatically — there is no staging and no
approval step. Everything below is here because of something that has actually gone
wrong in this repository, not as ceremony.
-->

## What this changes

<!-- One or two sentences. What behaviour is different afterwards. -->

## Why

<!--
The problem, not the patch. If it fixes an issue, "Fixes #12" — that closes it on merge.
-->

## What I was unsure about

<!--
The most useful section in this template, and the one most often left blank.

A reviewer can confirm a decision in seconds; they cannot guess which decisions you were
uneasy about. Naming a trade-off you took, an edge case you were not certain of, or a
place you could not tell which existing pattern applied is not a weakness in the PR —
it is the part that makes review worth doing. "Nothing" is a fine answer when true.
-->

## How it was verified

<!-- Tick what you ran. CI runs all of it too, but say what you actually saw pass. -->

- [ ] `npm --prefix server test`
- [ ] `npm --prefix frontend test`
- [ ] `npm --prefix frontend run lint`
- [ ] `npm --prefix frontend run build` (chained to the bundle smoke test)
- [ ] `cd python-service && pytest` — touched the reasoning service
- [ ] `npm --prefix server run bots:eval` — touched anything under `server/bots/`
- [ ] Exercised by hand in a browser or against a local API

<!-- If a check does not apply, delete the line rather than leaving it unticked. -->

## Checklist

- [ ] **The diff is the size of the change.** No drive-by reformatting, no unrelated edits.
- [ ] **Comments still tell the truth.** If a code path with an explanatory comment changed,
      the comment changed with it — a stale explanation is worse than none, because it is
      believed.
- [ ] **A bug fix has a test that failed before it.** Written first, watched fail, then fixed.
- [ ] **No secret, key or token is in the diff**, including in a test fixture or a comment.
- [ ] **Business logic that bots also use lives in `server/services/`**, not inline in a
      controller — otherwise the human path and the bot path drift.

## Anything that needs doing at deploy time

<!--
Delete if none. Otherwise say so plainly — this is the section that stops a green deploy
from being a broken one:

  - A new environment variable (the process may refuse to boot without it)
  - A new index (large collections build in the background; the feature is degraded meanwhile)
  - A one-off script from server/scripts/
  - Anything about it that is not reversible by redeploying the previous commit
-->
