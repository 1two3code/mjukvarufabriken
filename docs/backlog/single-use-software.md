# Single-use software ("engångsmjukvara")

Hasse, 2026-08-31, sparked by dogfood app #1 (Ögonblick, the wedding shared-camera PWA):
software built for **one occasion or one short-lived purpose, then deliberately torn down**.
Status: brainstorm, filtered and written down so it isn't lost. Nothing here is scheduled.
Pricing/GTM were decided later the same day ([strategy-2026-08-31.md](strategy-2026-08-31.md)) —
this brief was reconciled against those decisions 2026-08-31; where they diverge, the strategy
doc wins.

## Why this is a mjukvaruhuset-shaped idea (not just a cute niche)

Traditional dev economics made single-use software absurd: weeks of work for a weekend of use.
Our marginal cost for an S-class build is ~$10–50 of tokens plus a bounded hosting window. That
inverts the economics — and the concept lines up with almost everything already built or decided:

1. **Pricing-ladder fit.** The decided ladder (strategy-2026-08-31: free quote → 500 kr voucher
   demo → 3–5k kr real build → 600 kr/mo managed subscription) already has the right slot: an
   occasion app is a **3–5k kr real-build ticket incl. its hosting window** — with a buyer who
   already has an occasion budget and a deadline, so no procurement, no "do we need this", no
   agency-project expectations. (The 500 kr voucher tier doesn't fit hosted occasion apps — a
   demo build has no event to live at — but the *occasion shapes* can appear in the demo
   gallery as sales collateral.) The 600 kr/mo subscription doesn't map onto a 3-week lifespan
   either; occasion pricing is flat-per-occasion, and "same app next year" is the recurring
   variant (below).
2. **GTM alignment — a vertical, not the funnel.** The decided GTM targets SMB problem-apps via
   the voucher discovery machine; occasion apps are a **candidate vertical** for the
   verticalize-what-recurs step, not the primary funnel. Within the shortlist, the
   kickoff/offsite and förening/BRF ideas are closest to the SMB motion (same buyers, adjacent
   budgets); weddings/gifts are a consumer segment that would need its own funnel — strong
   concept, but don't confuse it with the 40-monthly-customers plan.
3. **Teardown becomes product, not churn.** The suspend/teardown lifecycle, account-per-customer
   vending and per-account cost metering were built as hygiene
   ([teardown-deprovisioning.md](teardown-deprovisioning.md), org-accounts). For single-use
   software, a scheduled death date is a *selling point* (privacy, price) and the ops story is
   already half-built.
4. **Built-in distribution.** This is maybe the strongest strategic point: an occasion app is
   used by *all the guests*, not just the buyer. Every wedding is a live demo in the pockets of
   50–150 people at their emotional peak, with a "byggd av Mjukvaruhuset" footer. Single-use
   software markets itself; enterprise software doesn't.
5. **Privacy by design as a feature.** "The app and all photos are deleted after the event" is a
   strong European/GDPR pitch, and for once deletion costs us nothing — we wanted to tear it
   down anyway. Pair with a final artifact (below) so deletion never feels like loss.
6. **Repetition trains the factory.** Occasions are unique; their *shapes* recur (camera+gallery,
   schedule+map, signup+list, vote+result). Each repeat feeds LEARNINGS.md and the spec engine,
   margins improve on the second wedding, tenth is near-pure margin — while every customer still
   gets the bespoke personalization (names, branding, inside jokes) that app-store alternatives
   can't do. v1 stays full harness builds (dogfooding value + the bespoke promise); "occasion
   packs" as semi-templates is a later optimization, not the start.

## The filter — what makes a *good* single-use idea

Score candidates against these; the list below already applies them.

1. **Hard date.** A real occasion with a deadline → urgency to buy, natural teardown date.
2. **Existing occasion budget.** The buyer already spends on this event (photo-booth rentals go
   for 5–10k SEK; we undercut a *rental* with *custom software*).
3. **S-class shape.** ≤3 features, no payments/roles/integrations in v1 (see the estimator
   keyword note under PLAN.md M10 app #1). Knowingly-M is fine if priced for it.
4. **Group value.** A crowd shares it — a single person's tool has app-store substitutes; a
   group's *own* app doesn't.
5. **Personalization is the point.** Names, branding, quirks — the reason "just use an app" fails.
6. **Clean exit.** A defined final artifact + full deletion (see "the artifact endpoint").
7. **No traps.** Skip: public UGC needing moderation, gambling-adjacent mechanics, anything
   election/medical, unaccompanied-minors audiences. Guest-only URLs (unlisted link = the access
   model, like app #1) keep UGC private-circle and low-risk.

## Filtered shortlist (best first)

1. **Wedding suite** — flagship. Shared camera (= dogfood app #1, already specced), guest info page
   (schedule, map, RSVP, dietary), **speech/toast signup for the toastmaster** (very Swedish,
   genuinely painful today via SMS), quiz about the couple, guestbook (text/audio). Sell as one
   app or à-la-carte occasions. Buyer: couple or toastmaster, budget context where 2 000 SEK is
   a rounding error. Ögonblick's dogfood run doubles as the pilot build.
2. **Company kickoff / offsite app** — B2B version of the same shapes: agenda + room map,
   session/activity signup, team quiz or bingo, shared camera. Buyer: HR/office manager with a
   per-head event budget. Recurs annually → natural re-order, and the upsell path to real
   business apps runs through someone who already bought once. (Live-vote/leaderboard variants
   drift M/L — price accordingly.)
3. **Kids' cup / tournament weekend** — schedule, results entry, standings, photo stream for a
   youth football/innebandy cup. Buyer: the club (they already charge team fees). Sweden is
   dense with these; recurs every year; the parents' phones are the distribution.
4. **Brand advent calendar (julkalender)** — 24 doors, lives exactly December 1–24, marketing
   budget, hard deadline, guaranteed teardown. The most literal single-use software there is,
   and it recurs annually by definition. Same shape works for sommartävlingar.
5. **Software as a gift** — commission an app *as a present*: a memory-collector for a 50/80-års
   birthday where family submits photos + stories before the day, revealed at the party,
   delivered as a book/PDF afterwards. Competes with experience-gift pricing (1–2k SEK), deeply
   personal, and introduces "ge bort en app" as a category nobody sells.
6. **Förening/BRF occasions** — årsmöte (agenda, motions, straw polls), städdag signup,
   loppis table map. Small budgets, but thousands of associations and the same three shapes
   over and over — spec-pattern gold once volume exists.

Parked (fails a filter, keep for reference): funeral/memorial pages (real and single-use by
nature, but marketing it is delicate — inbound only); bachelor-party challenge apps (fun, tiny
budgets, UGC-risky); moving-day/renovation/group-trip coordinators (single-*purpose* but no
buyer urgency, strong free-app substitutes); anything school-class-shaped (minors, GDPR).

## Product-shape insights worth keeping even if the list changes

- **The artifact endpoint.** The best single-use apps end by *producing something durable*: the
  camera app ends as a photo archive/book, the guestbook as a PDF, the memory-collector as a
  printed book. "The app dies, the artifact survives" answers the only hard customer objection
  to teardown — and makes teardown a deliverable (final export as the last delivery step)
  instead of an expiry.
- **Priced as an occasion, not a project.** Flat price incl. build + N-week hosting window +
  final artifact + deletion certificate. Extension = small monthly fee (that's the recurring
  tier sneaking in). "Same app next year" at a discount is a subscription wearing party clothes.
- **Event-day reliability is the whole product.** A business app failing on Tuesday gets a fix on
  Wednesday; a wedding app failing on Saturday failed *forever*. Implication: deliver days
  early, boring tech, offline-tolerant (app #1's offline shell), and freeze — no day-of deploys.
  The delivery pipeline's boot/acceptance gates matter *more* here, not less.
- **Every event app carries the footer.** Make "byggd av Mjukvaruhuset — beställ din egen" a
  standard, tasteful part of the deliverable. Distribution is the point; don't forget to collect
  it.

## Open questions (for when this graduates from brainstorm)

- ~~Does the order flow survive small tickets (50/50 deposit split)?~~ RESOLVED by
  strategy-2026-08-31: full payment upfront below ~3k kr, 50/50 only above — occasion apps at
  3–5k sit right at the boundary; pick per order. (Code still encodes 50/50 everywhere.)
- Hosting window mechanics: does `suspended → torn_down` + grace scheduler already express
  "auto-teardown at date X, final artifact first", or does delivery need a scheduled-death
  concept?
- Which shortlist item is dogfood-able next: app #1 (wedding camera) is committed; the advent
  calendar is the natural follow-up and is noted as the candidate for the open dogfood slot #3
  in PLAN.md (hard date, S-class, tests scheduled-death end-to-end in December).
- Brand: sell under mjukvaruhuset.se or a consumer-facing name for occasions
  ("engångsappen"?). Cheap to decide later; noted so it's a decision, not a drift.
