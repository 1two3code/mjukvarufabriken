# Documentation & repo-hygiene audit — mjukvaruhuset

Scope: `/home/wsl/dev/mjukvarufabriken/.claude/worktrees/deep-review` @ `8574129`
(`review/deep-audit-2026-08-31`). Date: 2026-08-31. No tracked file was modified.

Evidence base: full test run (152 files / 1178 tests), `git ls-files`, `git worktree list`,
`git branch --merged`, targeted greps against `apps/`, `packages/`, `infra/`.

---

## Verdict

The documentation is **unusually rich and unusually unreliable at the same time**. Almost every
fact in it was true when written; the problem is that nothing is ever retracted — PLAN.md,
README.md and TODO-EXTERNAL.md each hold a different generation of the same fact, all in the
present tense, with no "supersedes" marker. A reader cannot tell which one is current without
reading the code.

Three structural problems, in order of damage:

1. **The `[x]` convention is broken.** PLAN.md's own legend says *"Milestones (checkbox = done and
   verified)"*, and `docs/backlog/README.md` instructs agents to *"Tick PLAN.md boxes only for what
   is verified"*. At least 8 ticked boxes carry, in their own text, "live run pending", "deploy
   pending", "not deployed" or "LIVE-UNVERIFIED". The checkbox therefore means "code written", not
   "verified" — so the milestone list no longer answers the one question it exists to answer.
2. **PLAN.md has become an append-only log, not a plan.** Single bullets run past 2 000 characters
   and contain four dated revisions of the same decision (M5 "Deployed with URL" both claims
   LIVE-VERIFIED and "live deploy pending" in the same paragraph). It is not readable by a human
   and it is expensive and ambiguous for an AI session.
3. **README.md is a snapshot from 2026-08-27 that says so and was never updated.** Its milestone
   table, its stack list, its verify commands and its repo layout are all measurably behind the
   code (details in *Stale claims*).

Two findings are genuinely dangerous rather than merely untidy:

- **`.claude/worktrees/` is untracked AND not gitignored** — 34 worktrees, each with full
  `node_modules`, sit as `?? .claude/worktrees/` in the main checkout, one `git add -A` away from
  being committed.
- **The site still sells the S/M/L ladder (15/45/120 k SEK)** which PLAN.md's own pricing note says
  is under revision with a *"hard ceiling … nothing offered above 5 000 SEK"*. Docs and the
  customer-facing product disagree about the price.

Nothing found is a code defect. Test suite is green: **1175 passed / 3 skipped, 152 files**.

---

## Overstated milestone claims

| Claim (quoted from PLAN.md) | Where | Reality in code | Verdict |
|---|---|---|---|
| `[x]` "GitHub repo created, README + handover doc, **transferred to customer**" | PLAN.md M5, first box | `packages/harness/src/job/delivery/github.ts:68` `repos.createInOrg`, `:82` `repos.addCollaborator`. There is **no** `repos.transfer` call anywhere. `deliver.ts:148-176` sets `transferPending` and, at best, adds the customer as *admin collaborator* on a repo we still own | **overstated** — "transferred" is not implemented; the transfer is a manual step (TODO-EXTERNAL says so) |
| `[x]` "Deployed with URL in portal — **LIVE-VERIFIED end-to-end 2026-08-28**" | PLAN.md M5, second box | Same bullet, ~1 500 chars later: "The real Express/CodeBuild calls stay **live-unverified** (post-cutoff API) … live deploy pending". Code is real (`delivery/ecsExpress.ts`, `imageBuild.ts`) but behind `ImageBuilderLike`/fake seams | **partial + self-contradictory** — one bullet asserts both |
| `[x]` "Independent review agent …" / "Acceptance-check agent …" / "Job fails closed …" | PLAN.md M4, boxes 3, 4, 6 | Code present and good: `packages/harness/src/job/gates.ts`, `gates/review.ts`, `gateSessions.ts`. But each box's own text ends "unit-verified, **live run pending**" | **partial** — ticked against PLAN's own "done and verified" legend |
| M4 header implies the milestone is complete | PLAN.md M4 | M4's **first** box is `[ ]` (M3 hardening) — the milestone is open, but 5 of 6 boxes are `[x]` and README calls it "mostly" | accurate-but-misleading |
| `[x]` "Order flow: … → Stripe deposit → build → deliver → **Stripe balance**" | PLAN.md M6, box 3 | `apps/api/src/services/paymentService.ts` implements deposit + balance checkout; box text itself: "**Balance-on-delivery + live still pending**" | **partial** |
| `[x]` "Admin view: all jobs, budgets, kill switch … **not yet exercised on dev**" | PLAN.md M6, box 5 | Real and larger than claimed: `apps/portal/src/app/router.tsx:37-41` = 5 admin routes (overview/jobs/customers/resident/pricing), `features/admin/` has 8 components | accurate (understated) |
| `[ ]` "Metering → Stripe usage-based billing … not built" | PLAN.md M8, box 3 | It **is** built: `apps/api/src/services/paymentService.ts:357` calls `paymentProvider.reportUsage`, `plugins/stripe.ts:134` implements it against a Stripe billing meter. The sub-bullet admits this; the box stays open pending a real invoiced month | accurate box, **misleading one-liner** ("not built" is false) |
| `[x]` "Logs + alerts … **9 alarms**" | PLAN.md M9, box 2 | `infra/lib/ops-stack.ts`: 9 `new …Alarm(` constructs. Verified | **accurate** |
| `[x]` "Job liveness sweep … `apps/api/src/lib/jobSweep.ts` + `jobSweeper` plugin" | PLAN.md M9, box 1 | Both files exist (`apps/api/src/lib/jobSweep.ts`, `apps/api/src/plugins/jobSweeper.ts`); box honestly marks the STOPPED branch LIVE-UNVERIFIED | **accurate** |
| `[x]` "Give mjukvaruhuset itself a real dev/qa/live pipeline" | PLAN.md M11, box 1 | `infra/lib/config.ts:3` `EnvironmentName = 'dev' \| 'qa' \| 'live'`, `:161` `name: 'qa'` with its own domain block at `:171` | **accurate** |
| "M12 — Margin calculator (admin) — captured 2026-08-30, **NOT started**" + `[ ]` "Infra cost allocation" + `[ ]` "Revenue model per customer" | PLAN.md M12 header and boxes 2, 3 | Backend exists: `apps/api/src/services/marginService.ts` (59 lines, registered plugin), `apps/api/src/routes/bff/admin/margin/getInfraCost.ts`, `.../getRevenue.ts`, mock at `services/__mocks__/marginService.ts`. Only the UI is genuinely absent (`router.tsx:42` is a comment placeholder) | **understated / stale** — the header is simply wrong |
| `[x]` "Deploy agent into customer's AWS account (CDK template)" | PLAN.md M8, box 1 | `infra/resident/` exists and synths; but the 2026-08-28 Decision says the account is one **we vend and operate**, not the customer's. The box text was never updated | **stale framing** (see DOC-04) |

Pattern: the overstatement is almost never invention — it is **a ticked box whose own prose
contradicts the tick**. Nine of the eleven rows above would be fixed by splitting the checkbox into
`[x] built` vs `[x] verified in the environment it must run in`.

---

## Contradictions

### DOC-01 — Does the `mjukvaruhuset` GitHub org exist?

> "2026-08-28 **LIVE**: repo created in the `mjukvaruhuset` org via the App install (org install 157185356)"
> — PLAN.md, M5 box 1

> "REMAINING: the App is installed on the personal `1two3code` account, but delivery creates repos in the `mjukvaruhuset` org (`createInOrg`) **which doesn't exist** — so create that org + install the App there … Until then delivery fails closed at `createRepo`"
> — TODO-EXTERNAL.md, "GitHub delivery" row

> "M5 Delivery | done (dry-run) | … live delivery **waits on the GitHub org**"
> — README.md, milestone table

Three documents, three states, same date range. Code (`delivery/github.ts:68`) unconditionally
targets `createInOrg`, so if the org does not exist, delivery cannot work at all — this is the
single most load-bearing unresolved fact in the repo and it is documented three different ways.

### DOC-02 — Is "Sign in with GitHub" working?

> "**\"Sign in with GitHub\" has no button yet.** Code is done, but it is inert until the GitHub OAuth App exists and its client id/secret are provided (TODO-EXTERNAL)."
> — PLAN.md, *Standing reminders* (top of file)

> "`[x]` Sign in with GitHub — **LIVE-VERIFIED on dev 2026-08-28** (Hasse logged into the portal via GitHub end-to-end …)"
> — PLAN.md, M6 box 2 (same file, ~90 lines later)

> "GitHub sign-in **built but not exercised against GitHub**" — README.md, M6 row
> "Until then the api answers 404 on `/bff/auth/github` and the magic link is the only way in" — TODO-EXTERNAL.md

PLAN.md contradicts *itself*, and the standing reminder — the part a fresh session is most likely
to read — is the wrong one.

### DOC-03 — What does the product cost?

> "Pricing v1: S/M/L = **15k / 45k / 120k SEK** ex moms (decided 2026-08-26)" — PLAN.md, *Decisions*

> "**Hard ceiling for now: nothing offered above 5 000 SEK.**" — PLAN.md, *Decisions*, pricing-under-revision note (14 lines later)

Code and the public site are on the old ladder:
`packages/harness/src/spec/priceEstimator.ts:4` — `priceForSize = { S: 15_000, M: 45_000, L: 120_000 }`;
`apps/site/src/pages/PricingPage.tsx:51` renders `pricing.size.${size}.price` for S/M/L.
The note says "do not build against this", which is fine — but nothing says *what a customer is
quoted today*, and the site is the live answer. Also self-flagged in PLAN: the M10 dogfood app #2
spec deliberately classifies **L**, "a tier this new direction explicitly wants to stop selling".

### DOC-04 — Whose AWS account does the resident run in?

> "a long-running agent lives **in the customer's own AWS account**, on **the customer's own Anthropic key**"
> — docs/RESIDENT.md:3-5

> "After delivery a 'resident' agent can keep working on the repo from inside the **customer's own AWS account**"
> — README.md, intro paragraph

> "Each customer gets a **vended member account** … **account-per-customer** … This resolves M11's 'whose AWS account' fork and **revises the earlier 'resident on the customer's own account' line** — the account is one **we vend and operate** in our org, not one the customer sets up."
> — PLAN.md, *Decisions*, 2026-08-28

The superseding decision exists and is explicit; the two documents it supersedes were never
touched. `infra/resident/` is still described as "a separate CDK app **a customer** deploys into
their account" in CLAUDE.md too. This one also has legal exposure — `legal/sla-resident.md` and
`legal/pub-avtal.md` are drafted for lawyer review against the old model.

### DOC-05 — Which environments are deployed, and how many stacks are there?

> "M9 Ops | **done (synth)** | … template-tested; `ops`/`budget` **land with the next dev deploy**, then confirm the SNS subscription e-mails" — README.md

> "**LIVE-VERIFIED 2026-08-30**: both `ops-dev` and `budget-dev` are `CREATE_COMPLETE`, all 9 `mf-dev-*` alarms `OK`, and the `mf-alerts-dev` SNS subscription … is **confirmed**" — PLAN.md, M9 box 2

Same for env count: README says `cd infra && npx cdk synth` covers "**4 stacks × 2 envs** offline",
but `infra/lib/config.ts:3` now has three envs and the repo has five separate CDK apps
(`infra`, `infra/resident`, `infra/org`, `infra/mail`, `infra/status` — per CLAUDE.md). README
mentions only the first two and never mentions `qa` at all.

### DOC-06 — What does "dev email" mean?

> "**Dev email is silent by design, not broken.** `emailTransport` is `log` until AWS SES production access clears the sandbox (TODO-EXTERNAL) — magic links land in the API log, not an inbox."
> — PLAN.md, *Standing reminders*

> "~~Catch-all inbound mail on mjukvaruhuset.se~~ — **DONE 2026-08-30**: `infra/mail` deployed … MX live … **live-verified end-to-end** (a test send to `test@mjukvaruhuset.se` landed forwarded)"
> — TODO-EXTERNAL.md

These are compatible (outbound sandboxed vs inbound working) but **no document says so**. A reader
who has seen mail arrive will reasonably conclude the standing reminder is stale and start
debugging the magic link — exactly the failure mode the reminder was written to prevent.

### DOC-07 — Hosting target

Resolved cleanly in code — `infra/lib/resources-stack.ts:321` is a `// MARK:` comment explaining
the App Runner → ECS Express move, `delivery/appRunner.ts` is gone, `delivery/ecsExpress.ts` +
`ecsExpressClient.ts` are the implementation. But `docs/backlog/m5-delivery.md`,
`docs/backlog/wave6-test-and-replay.md` and `docs/backlog/teardown-deprovisioning.md` still
describe App Runner in the present tense with no superseded banner, and `docs/backlog/ecs-express.md`
(the brief that *did* the migration) has no "DONE" marker.

### DOC-08 — Test counts

> "Ultracode waves 7–10 (2026-08-28/29) — shipped, all on `main`, **1116 tests green**." — PLAN.md banner

Actual, this session: **1175 passed | 3 skipped (1178) across 152 files (1 skipped)**. Not wrong so
much as frozen — but it is quoted as a live health metric, and no document states the current
number. README claims `npm test` runs "vitest across api, site, job, utils, harness, db, resident"
— it omits `portal` (`apps/portal/test/` exists), `org` and `models`.

### DOC-09 — The delivery repo-transfer story

> "Delivery target: GitHub repo — **we create a GitHub org/account for the customer** during onboarding if they lack one, **then transfer**" — PLAN.md, *Decisions*

> "customer added as **admin** when the order carries `customerGithubLogin` (M6) else `transferPending`" — PLAN.md, M5 box 1

> "delivered repos live there, **then transfer to the customer**" — TODO-EXTERNAL.md

Code does the middle one only (`github.ts:82` `addCollaborator`). There is no onboarding flow that
creates a customer org, and no transfer call. Three documents describe an end state as if it were
the implementation.

### DOC-10 — What is `docs/backlog/`?

> "# **Overnight backlog (2026-08-26 → 27)** … Hasse asked for the rest of PLAN.md to be worked overnight" — docs/backlog/README.md:1, with a table listing waves **1–3 only** (9 streams)

> "[docs/backlog/](docs/backlog/README.md) — the overnight wave briefs (one per stream, **waves 1–5**)" — README.md, *Further reading*

Reality: **21 briefs** in `docs/backlog/` plus a 5-file `hardening-2026-08-30/` subfolder, spanning
waves 1–12 and including things that are not wave streams at all (`phoenix.md`, `org-accounts.md`,
`single-use-software.md`, `self-host-tools.md`, `dev-escalation.md`). The index describes ~40 % of
its own folder and both descriptions of it are wrong.

---

## Stale claims

Each verified against code before listing.

1. **README milestone table** — self-labelled "Hand-copied from PLAN.md on **2026-08-27**". PLAN has
   since gained M11, M12 and the "dedicated dev server" side quest; none appear. The table is the
   first thing a reader sees and is four days and two milestones behind.
2. **README: "M3 … has run on dev but not yet to a green end-to-end delivery"** — false.
   `docs/TESTING.md` and PLAN both cite "the first green live delivery (2026-08-27, job `5e894e2a`)".
3. **README repo layout omits `packages/org`** — the workspace exists (`packages/org/src/actuator.ts`,
   `deprovision.ts`) and is central to the vended-account model. README lists
   "packages/utils, packages/access-control" and stops.
4. **README: `infra/` = "resources-`<env>`, mf-`<env>`, ops-`<env>`, budget-`<env>`"** — misses the
   `github-deploy` stack (`infra/lib/github-deploy-stack.ts`, referenced as deployed in
   TODO-EXTERNAL) and the four sibling CDK apps `infra/org`, `infra/mail`, `infra/status`,
   `infra/resident`.
5. **README install line: `npm i && npm i --prefix infra && npm i --prefix infra/resident`** —
   incomplete. CLAUDE.md states a fresh worktree also needs `npm i --prefix templates/web` or the
   harness offline e2e fails; `infra/org`, `infra/mail`, `infra/status` are separate npm projects
   too. A new contributor following README alone gets a red `npm run e2e`.
6. **README "Verify (what CI runs)" omits `npm run e2e`** — while `docs/TESTING.md:3` calls the
   offline e2e "**the default iteration loop**". The two most important testing documents disagree
   about what you run.
7. **README "4 stacks × 2 envs offline"** — three envs since M11 phase 1.
8. **`docs/backlog/README.md` rules: "Tick PLAN.md boxes only for what is verified; otherwise leave
   the box and add a dated note."** — contradicted by ~8 boxes in PLAN.md (see table above). Either
   the rule or the boxes should move.
9. **PLAN M8 box 3 one-liner "Stripe usage-based billing of those records … — not built"** — it is
   built (`plugins/stripe.ts:134`); only a real invoiced month is missing.
10. **README intro: "Payment is Stripe Checkout (50 % deposit before the build, 50 % on delivery)"** —
    still true in code, but PLAN's pricing note explicitly questions whether 50/50 survives at
    "$50 order" ticket sizes. README states it as settled.
11. **`docs/backlog/ecs-express.md`, `m4-gates.md`, `m5-delivery.md`, `m6-orders.md`, `m7-site.md`,
    `m8-resident.md`, `m9-ops.md`, `persistence.md`, `m3-hardening.md`, `efficiency.md`,
    `offline-e2e.md`, `stripe-klarna.md`, `wave4/5/6*.md`** — all written as future-tense work
    orders ("Do NOT touch…", "must be green before you finish"), all shipped. Only
    `environments.md`, `org-accounts.md`, `phoenix.md`, `teardown-deprovisioning.md`,
    `self-host-tools.md` and `dev-escalation.md` carry a `> STATUS` banner.

---

## Backlog state

`docs/backlog/` — 21 briefs + `hardening-2026-08-30/` (5 files). Status column derived from the
brief's own banner where present, otherwise from PLAN.md + code.

| Brief | Lines | Banner? | State | Note |
|---|---|---|---|---|
| `README.md` | 31 | — | **stale index** | Describes waves 1–3 only; 12 of 21 briefs unlisted |
| `persistence.md` | 42 | no | completed (wave 1) | Postgres orders/specs/users/auth shipped |
| `m4-gates.md` | 54 | no | completed (wave 1) | `harness/src/job/gates*` exist |
| `m7-site.md` | 45 | no | completed (wave 1) | site + `/bff/contact` shipped |
| `m9-ops.md` | 46 | no | completed (wave 1) | 9 alarms verified in `ops-stack.ts` |
| `m5-delivery.md` | 49 | no | **completed but misleading** | still describes App Runner |
| `m6-orders.md` | 42 | no | completed (wave 2) | order state machine + Stripe shipped |
| `m3-hardening.md` | 28 | no | completed (wave 2) | per-job token + `/internal/jobs/:id` |
| `m8-resident.md` | 34 | no | completed (wave 3) | `packages/resident` + `infra/resident` |
| `efficiency.md` | 32 | no | completed (wave 3) | folded into `docs/EFFICIENCY.md` |
| `ecs-express.md` | 82 | no | **completed, unmarked** | migration done; brief reads as pending |
| `offline-e2e.md` | 75 | no | completed | `npm run e2e` exists and is green |
| `stripe-klarna.md` | 41 | no | completed | test-mode verified 2026-08-28 per PLAN |
| `wave4.md` | 58 | no | completed | github-signin, billing-and-tls, legal, api-hygiene |
| `wave5.md` | 58 | no | completed | ci-and-deploy, licence-gate, portal-polish, sandbox-uid |
| `wave6-api-hygiene.md` | 28 | no | completed | branch `wave6/api-hygiene` merged |
| `wave6-product-polish.md` | 33 | no | completed | branch merged |
| `wave6-test-and-replay.md` | 41 | no | **completed but misleading** | App Runner references |
| `wave7.md` | 118 | no | completed | waves 7–10 banner in PLAN |
| `environments.md` | 104 | **yes** (2026-08-29) | **live, partially done** | phase 1 built; customer-side open |
| `org-accounts.md` | 108 | **yes** (2026-08-28/29) | **live, partially done** | `@mf/org` + `infra/org` built; cross-account deploy path open |
| `phoenix.md` | 108 | **yes** (2026-08-30) | **live** | qa account vended; rest pending |
| `teardown-deprovisioning.md` | 69 | **yes** (2026-08-28/29) | **live, partially done** | `deprovision()` built; policy open |
| `self-host-tools.md` | 90 | **yes** (2026-08-30) | **live** | Trivy/Sentry/Uptime Kuma landed; rest advisory |
| `dev-escalation.md` | 98 | **yes** (design draft) | **live, not started** | M11 escalation design |
| `single-use-software.md` | 114 | **yes** (brainstorm) | **live, not started** | newest (2026-08-31) |
| `hardening-2026-08-30/README.md` + 4 gate files | 72+104+138+90+83 | yes | **live, critical** | Gate A blocks `deploy.sh live`; F3/H1 open |

**Does `docs/backlog/README.md` reflect reality? No.** It is a wave-1–3 dispatch note being used as
the index for a 26-file folder that now mixes (a) shipped work orders, (b) living design documents,
(c) an active security gate that blocks production deploys, and (d) product brainstorms. The
hardening folder — the only content that currently blocks an action — is not linked from it at all.

---

## Repo hygiene

**Tracked build artifacts / generated output** (`git ls-files`, 1 049 tracked files):

| Path | Tracked | Size | Assessment |
|---|---|---|---|
| `coverage/` | **no** | — | correctly gitignored (`coverage` in `.gitignore`); exists on disk only |
| `infra/cdk.out/` | **no** | — | correctly ignored |
| `infra/cdk-outputs-dev.json` | **yes** | 100 B | **generated** by `cdk deploy --outputs-file`; should not be tracked |
| `infra/cdk-outputs-qa.json` | **yes** | 4 369 B | **generated**; contains a full qa deploy's outputs |
| `infra/org/cdk-outputs.json` | **yes** | 133 B | **generated** |
| `infra/cdk.context.json` | **yes** | 255 B | acceptable — CDK explicitly recommends committing this |
| `packages/db/certs/rds-global-bundle.pem` | **yes** | — | intentional (PLAN M9: "pinned by commit"), but committed **against** the `*.pem` ignore rule, i.e. force-added |
| `.vscode/{settings,extensions,launch,tasks}.json` | yes | — | intentional, explicit `!` negations in `.gitignore` |
| `apps/{site,portal}/.env{,.dev,.qa}` | yes | — | intentional, explicit `!` negations; contain only `VITE_*` public values |
| any other `*.pem` | none | — | clean |

**`.gitignore` gaps:**

1. **`.claude/worktrees/` is neither tracked nor ignored** — `git status --porcelain` in the main
   checkout reports `?? .claude/worktrees/`. That is 34 worktrees with full `node_modules` trees
   permanently dirtying `git status` and one careless `git add -A` from disaster. Add
   `.claude/worktrees/` to `.gitignore`. **Highest-value single fix in this section.**
2. No ignore for `*.tsbuildinfo`, `.vite/`, `.turbo/` — none are currently present, but `tsgo:watch`
   tasks exist in four workspaces.
3. `*.pem` is a blanket deny with no `!packages/db/certs/*.pem` negation, so the one legitimately
   committed cert is invisible to the rule that is supposed to govern it. Make the exception
   explicit so the next person who regenerates the bundle does not silently fail to commit it.
4. `cdk-outputs*.json` is not ignored anywhere — hence the three tracked files above.

**Dead `package.json` scripts:** none found. All 21 root scripts resolve to files that exist
(`scripts/gen-auth-key.mjs`, `scripts/smoke-spa.mjs`, `packages/harness/scripts/*.ts`,
`packages/db/scripts/*.ts`, `apps/job/src/index.ts` all verified present). Workspace scripts are
consistent (`lint` everywhere, `test` where tests exist, `tsgo:watch` in the three TS-heavy apps).
The gap is the reverse: **`e2e` and `e2e:replay` exist but are documented nowhere in README**, and
`packages/access-control` + `packages/models` have no `test` script although both are covered by
the root vitest projects — harmless, but it means `npm run test -w @mf/models` fails confusingly.

**Stale worktrees and branches:**

- `git worktree list` → **34 worktrees**, of which **8 are locked** (`delivery-quality`,
  `wf_12af5ea3-ac1-16/17/18/19/20/21`, …) and at least 5 are detached HEADs on commits that are no
  longer branch tips. Names like `wf_12af5ea3-ac1-*` (wave 12) and `wf_b63b8a4b-4d9-*` (wave 11)
  are machine-generated leftovers from completed waves.
- `git branch -a` → **186 refs**; `git branch --merged main` → **101 already merged**. So ~99
  branches are safely deletable, including all of `wave1/*`, `wave2/*`, `wave3/*`, `wave4/*`,
  `wave5/*`, `wave6/*`, `task/c`, `task/contact`, and ~80 `worktree-wf_*` refs.
- Recommended (destructive — confirm before running): `git worktree prune`, unlock + remove the
  wave 11/12 worktrees, then delete merged branches excluding `main` and any in-flight review
  branch. **Do not** delete the unmerged ones (`fix/gate-*`, `docs/gate-*`,
  `feat/stripe-mor-and-visitable-delivery`, `harness-learned-log`, `single-use-software`) without
  checking them — several look like unlanded Gate A/B work.

---

## Proposed reorganisation

The current split is *by document age*, not by audience. Proposed split is by **question answered**.

### (a) For a new human contributor

| File | Target size | Holds | Change |
|---|---|---|---|
| `README.md` | **≤ 80 lines** | What the product is, repo layout, how to run it locally, how to verify, where to go next. Nothing dated, nothing status-bearing. | **Delete the milestone table entirely** (it is a hand-copy that guarantees drift — link to PLAN.md instead). Fix the layout list (`packages/org`, the 5 CDK apps), fix the install line (`templates/web`, `infra/org`, `infra/mail`, `infra/status`), add `npm run e2e` to Verify, move the 25-row env-var table to a new `docs/CONFIGURATION.md`. |
| `docs/CONFIGURATION.md` | new, ~90 lines | The env-var table currently occupying a third of README, plus which secret name each maps to in AWS. | Split out of README. It is reference material, not onboarding. |
| `docs/ARCHITECTURE.md` | new, ~120 lines | Order → spec → job → gates → delivery as one diagram + one page. Which package owns which step. The data model (`orders`, `jobs`, `payments`, `resident_usage`, `model_prices`, 18 migrations). | **Does not exist today** — see *Missing documentation*. |
| `docs/STATUS.md` | new, ~60 lines | The single source of truth for "what is actually deployed / verified right now", regenerated (not hand-copied) each session: env × stack × verified-date, plus the top 5 blockers. | Replaces README's table, PLAN's "standing reminders", and half of TODO-EXTERNAL's strikethroughs. |

### (b) For a fresh AI session with limited context

`PLAN.md` at 206 lines is deceptive — the lines are enormous (multiple >2 000 chars) and it is
effectively a 40 k-character document that a session must read to find one checkbox. Split it:

| File | Holds |
|---|---|
| `PLAN.md` (**≤ 100 short lines**) | Milestone list only. One line per box. Two states: `[x] built` / `[x] verified`. A link per box to its brief. No prose, no dated revisions, no dogfood specs. |
| `docs/DECISIONS.md` (new) | The *Decisions* section as dated ADR entries, **each with a `Superseded by:` line**. DOC-03, DOC-04 and DOC-07 all exist because there is nowhere to record a supersession today. |
| `docs/backlog/dogfood-apps.md` (new) | The three M10 app specs (~60 % of PLAN's byte weight). They are specs, not plan. |
| `docs/backlog/pricing-rethink.md` (new) | The pricing-under-revision block, cross-linked from `single-use-software.md`. |
| `CLAUDE.md` | Keep as is — it is the best-calibrated file in the repo: short, current, and it is what a session actually reads first. Add one line pointing at `docs/STATUS.md`. |

**Delete or archive:** `docs/M3-BRIEF.md` + `docs/M3-REVIEW.md` (298 lines of findings, all either
fixed or migrated into PLAN M4/M9 boxes — archive under `docs/archive/`). Move the 15 shipped
wave briefs to `docs/backlog/archive/` and reduce `docs/backlog/README.md` to two tables: **Live**
(7 briefs) and **Archive** (15). Promote `hardening-2026-08-30/` out of `backlog/` to
`docs/GATE-A.md` — it is not backlog, it is a live production blocker.

**Rule to add** (to `CLAUDE.md`, one line): *a fact stated in more than one file must be stated in
exactly one file and linked from the others.* Every contradiction in this report is a duplicated
fact that drifted.

---

## Missing documentation

Ranked by how quickly a new contributor hits the wall.

1. **A data-model / architecture overview.** There is no document that shows the `orders → jobs →
   payments` schema, the 18 migrations, or the request path SPA → `/bff` → service → repository.
   `docs/M3-BRIEF.md` covers the orchestrator only. A newcomer must read
   `packages/db/migrations/` and `apps/api/src/routes/` to learn the shape of the product.
2. **How to read a failed job.** The most common real task — a Fargate job failed, now what? Which
   log group (`/mf/<env>/jobs`), which stream naming, how to map a `gate` event to the gate that
   emitted it, what `capped-via-throw` / `error_max_turns` / `transferPending` mean, how to tell a
   budget kill from a gate failure. Fragments exist across `docs/RUNBOOK.md`, `docs/LEARNINGS.md`
   (4 OPEN entries) and PLAN's M3 box; nothing joins them.
3. **How to run one gate in isolation.** `npm run gates:demo -- --repo <dir> --spec <json>` appears
   once, in README's code block, with no explanation of where `<spec json>` comes from or what a
   passing output looks like. The five gates are the product's quality claim and are the least
   documented part of it.
4. **A threat model.** The system runs *model-authored, untrusted code* against an egress proxy, in
   a two-uid sandbox, with an IAM role that can `sts:AssumeRole` into an artifacts role, inside an
   AWS Organization with a guardrail SCP. All of the mechanisms are documented individually
   (`apps/job/README.md`, PLAN M4/M9, `hardening-2026-08-30/3-platform-security.md`); nothing states
   the **trust boundaries and what each one is defending against**. TODO-EXTERNAL even records a
   known partial defence ("Fargate sidecars share the task ENI, so the tinyproxy allowlist is
   app-level") with no threat-model home.
5. **Local troubleshooting.** No document covers: Postgres not up → which error you see; missing
   `ANTHROPIC_API_KEY` → demos "exit skipped"; magic link not arriving (DOC-06); `npm run e2e`
   failing because `templates/web/node_modules` is absent (CLAUDE.md mentions the cause; README
   does not mention the command); port conflicts on 5173/5174/5175.
6. **The onboarding → delivery runbook for a real customer.** Docs describe every component but no
   document walks the actual sequence: create order → spec chat → freeze → deposit → job → gates →
   repo → transfer → resident. Given DOC-01 and DOC-09, nobody currently knows end-to-end which
   steps are manual.
7. **A "how to update these docs" note.** Given the drift found here, the cheapest durable fix is a
   short convention: where each kind of fact lives, and that superseding a decision means editing
   the old one, not appending a newer one.
