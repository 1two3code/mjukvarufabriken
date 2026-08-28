# Stripe + Klarna — go from the fake provider to real test-mode payments

The payment layer already exists (wave 2, m6-orders): `PaymentProvider` interface + `createStripeProvider`
(reads `STRIPE_SECRET_KEY`) + `createFakeProvider` (dev default), routes `createCheckout` /
`stripe/postWebhook` / `stripe/fakeCheckout`, deposit→build→balance state machine. It has only ever run
against the **fake** provider. Checkout uses Stripe's *automatic* payment methods (no hard-coded
`payment_method_types`), so **Klarna is enabled in the Stripe Dashboard, not in code.**

## What Hasse provides (test mode is enough to build + verify)
1. **A Stripe account.** Test mode keys are enough for everything here.
2. **Secret key** `sk_test_…` → put in `mf/dev/stripe-secret-key` (`aws secretsmanager put-secret-value`).
   (The publishable key isn't needed server-side — Checkout is a redirect.)
3. **A webhook endpoint** in the Stripe Dashboard → `https://api.dev.mjukvaruhuset.se/bff/stripe/webhook`,
   subscribed to at least `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`. Copy its **signing secret**
   `whsec_…` → `mf/dev/stripe-webhook-secret`.
4. **Enable payment methods** in the Dashboard: **Cards** + **Klarna** (Klarna needs the account
   eligible for SEK/Sweden; test mode has Klarna test). That's what makes Klarna appear at Checkout.
5. For LIVE later: finish Stripe onboarding (org.nr + bank — already in TODO-EXTERNAL), then live keys.

## Implementation (mostly verification + Klarna's async nuance)
1. **Handle Klarna's delayed-notification flow.** Cards settle synchronously
   (`checkout.session.completed`), but **Klarna can be async** — the session completes then pays later
   via `checkout.session.async_payment_succeeded` / `_failed`. Audit `stripe/postWebhook` +
   `paymentService.handleEvent`: mark the payment paid on `async_payment_succeeded` too (not only
   `completed`), and don't start the build until money is actually captured. Add `expired` handling so
   an abandoned Klarna session doesn't leave the order stuck. Tests with signed fixture events for each.
2. **Verify the real provider end-to-end in test mode** (needs the keys above): checkout (deposit) →
   Klarna/card test payment → webhook → order `deposit_paid` → job auto-starts; then balance on delivery.
   Use the Stripe CLI (`stripe listen --forward-to …/bff/stripe/webhook`) or the Dashboard.
3. **Optional determinism**: consider setting `payment_method_types: ['card','klarna']` (or
   `automatic_payment_methods: { enabled: true }`) explicitly so the offered methods don't depend only
   on Dashboard state — decide with Hasse.
4. **Invoices**: `invoice_creation` is on; confirm the hosted invoice / receipt URL flows onto the
   order and shows in the portal (m6 already stores `hostedInvoiceUrl`/`receiptUrl` — verify live).
5. Portal: the deposit/balance buttons open Checkout — verify against real test keys; Klarna appears
   as an option in the SEK Checkout.

## Verify
`npm run lint`, `npm test` (signed webhook fixtures, async-payment cases). Live test-mode run is manual
with Hasse's keys + the Stripe CLI. PLAN.md M6 payment boxes → "test-mode verified" once done.
