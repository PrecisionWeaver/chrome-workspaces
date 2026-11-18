# Your review's status on review requests

## Goal

In **Review requests**, show at a glance whether you have reviewed a PR, and whether it needs your re-review before it can merge. Filter the list by it.

## Today

- `ReviewRequest.approved`: your latest review is an approval → **Approved** pill.
- `ReviewRequest.needsReReview`: your latest review commented or requested changes and the head moved since → **New commits** pill.
- PRs you reviewed are searched only in `watchRepos`/`repoDirs`, and kept only when `needsReReview`. Elsewhere a reviewed PR leaves the list, since it no longer matches `--review-requested=@me`.
- The facet filters are Authors, Repos and Status (merge state).

## Design

### Data

`shared/protocol/pull-requests.ts` replaces `approved` and `needsReReview` with one field:

```ts
/** Where your own review on the PR stands. */
export type MyReview = 'none' | 'rereview' | 'new-commits' | 'changes-requested' | 'commented' | 'approved';
myReview: MyReview;
```

### Rules

Worked out in `helper/src/git/review-parse.ts` from your latest review (`latestReviews`), the PR's head commit and its user review requests. The first rule that matches wins.

1. `rereview`, **Re-review to merge**. Your review is what stands in the way:
   - your latest review requested changes, and the head has moved on from the commit it was on; or
   - your latest review was dismissed (e.g. an approval removed by a push under stale-review dismissal); or
   - you have a review on the PR, and your review is requested again by you as a user (not through a team).
2. `new-commits`, **New commits**: your latest review commented and the head has moved on.
3. `changes-requested`, **Changes requested**: you requested changes and nothing has been pushed since; it waits on the author.
4. `commented` / `approved`: you reviewed and nothing has changed since.
5. `none`: you have no review on the PR.

A missing commit on either side never counts as "moved on" (as today). A `PENDING` review (your unsubmitted draft) counts as no review.

`mergeStatusQuery` adds `reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }` to each lookup.

### Fetching

`ghReviewedPrs` drops its repo flags: `gh search prs --state=open --reviewed-by=@me … --limit 50`, run always (not only when repos are configured). `ReviewsPoller.withMergeStatus` no longer filters reviewed-only PRs by `needsReReview`; every open PR you reviewed stays listed. Without `fetchMerge` (no review state can be learned), reviewed-only PRs are still left out, as today.

When a lookup fails, `myReview` keeps the last good value, as `approved` and `needsReReview` do now; a PR never seen before gets `none`.

### Panel

- **Pills** in `extension/src/source-control/launcher.ts`, one per PR, none for `none`:
  - `rereview`: "Re-review to merge", warning colour, title explains which case it is generically ("Your review is needed again before this can merge").
  - `new-commits`: "New commits", today's `.rereview` style.
  - `changes-requested`: "Changes requested" (muted).
  - `commented`: "Commented" (muted).
  - `approved`: "Approved", today's `.approved` style.
- **Filter**: a fourth facet button, **My review**, alongside Authors, Repos and Status, with values Re-review to merge, New commits, Changes requested, Commented, Approved, Not reviewed. Hidden values persist in `reviewsHidden` like the others.
- **Search**: the pill's label joins the searchable text, so `re-review` or `approved` matches.
- Order is unchanged (newest update first).

`approved`/`needsReReview` are read only by `review-parse.ts`, `reviews.ts` and `launcher.ts` (plus tests and `extension/testing/fixtures.ts`); all move to `myReview`. `helper/src/main.ts` calls `ghReviewedPrs()` with no repos and always passes `fetchReviewed`.

### Docs

`docs/features.md` (Review requests) describes the pills, the filter and the wider reviewed-PR search; `docs/configuration.md`'s `repoDirs` row no longer claims reviewed PRs come from those repos only.

## Tests

- `review-parse` (or its existing test file): each rule, rule precedence (e.g. re-requested + commented → `rereview`), team-only request does not count, pending review counts as none, missing commits.
- `review-queries`: the query asks for `reviewRequests`; `ghReviewedPrs` has no repo flags.
- `reviews` poller: reviewed-only PRs kept whatever their `myReview`; failed lookup keeps the last `myReview`.
- `launcher`: one pill per state, none for `none`; the My review facet hides and restores items and persists.
- Placeholder names (`acme/app`, `PROJ-123`) throughout.

## Out of scope

Sorting by review state; notifications; reviews by anyone but you.
