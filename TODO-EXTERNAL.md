# Things that need other people's approval — off the critical path

Start these NOW; none of them block building the software.

| Item | Who | Typical wait | Blocks |
|---|---|---|---|
| Register AB at Bolagsverket (verksamt.se), 25k SEK share capital | you | 1–3 weeks | invoicing in company name |
| F-skatt + momsregistrering (Skatteverket) | you | 1–3 weeks | invoicing |
| Company bank account | you | 1–4 weeks | Stripe payouts |
| Stripe live-mode verification (needs org.nr + bank) | you | 1–5 days after above | real payments |
| Fortnox (or similar) for bokföring + Stripe sync | you | 1 day | accounting |
| Ansvarsförsäkring (IT-konsult) e.g. Länsförsäkringar/If/Gjensidige | you | days | pilots with real customers |
| Lawyer review of kundavtal, PUB-avtal (GDPR), SLA, IP/liability clause — drafts in `legal/` since 2026-08-27 (`kundavtal.md`, `pub-avtal.md`, `sla-resident.md`, `villkor-webb.md`, each marked DRAFT — EJ GRANSKAD with an English summary); fill in `[BOLAGSNAMN AB]`/`[ORG.NR]`/`[ADRESS]`/`[MÅNADSAVGIFT]` and answer the bracketed open points (resident fee model, Anthropic retention, licence gate, log retention) before sending | lawyer | 1–2 weeks | pilots |
| Anthropic: raise rate/spend limits on API org | Anthropic | days | volume |
| AWS: service quota increases (Fargate vCPU, App Runner) | AWS | 1–3 days | parallel jobs |
| AWS SES production access (leave sandbox) | AWS | ~1 day | customer email |
| Domain mjukvaruhuset.se — check availability, buy | registrar | hours | site live |
| GitHub OAuth App for "Sign in with GitHub" (client id + secret, callback `https://portal.<env>.mjukvaruhuset.se/auth/github/callback`) under the `mjukvaruhuset` org | you | minutes (needs the org first) | M6 GitHub sign-in |
| BankID integration (via a broker e.g. Criipto/Signicat) | broker | weeks | later, not v1 |
| Trademark check on "Mjukvaruhuset" (PRV) | you | days | brand risk |
| Hard network egress fence for build jobs: Fargate sidecars share the task ENI, so the tinyproxy allowlist is app-level (HTTPS_PROXY). A proxy in its own task/SG + VPC endpoints for Secrets Manager/S3 gives a real fence (~10 USD/month) — decide before pilots | you | hours | untrusted-code isolation |
| Anthropic: Claude Agent SDK usage terms / org rate limits for parallel workers (2–4 sessions per job) | Anthropic | days | parallel jobs |
| Mailbox hej@mjukvaruhuset.se (shown on the public site as contact address; contact-form mail goes to AUTH_ADMIN_EMAILS via SES) | you | hours | site contact address answering |
| Confirm the `mf-alerts-<env>` SNS e-mail subscription (AWS sends "Subscription Confirmation" to each `adminEmails` address after the first `ops-<env>` deploy; nothing is delivered until clicked) | you | minutes | M9 alerts reaching anyone |
| GitHub org `mjukvaruhuset` + a token with `repo` + `admin:org` scope → `mf/<env>/github-token` secret (M5 creates `mjukvaruhuset/<app>-<job>` repos and invites the customer as admin; until then jobs still build + gate and fail closed at the `repo` delivery step, or run with `DELIVERY_DRY_RUN=1`) | you | minutes | M5 live delivery |
| App Runner GitHub connection: App Runner console → GitHub connections → create for the `mjukvaruhuset` org, complete the handshake, put the ARN in `infra/lib/config.ts` `appRunner.connectionArn` per env (M5 deploys the customer api from the pushed repo; without it delivery reports `deployUrl: null` + a notify). NOTE: one connection is org-wide — a job holding the task-role credentials can create a preview from any repo the connection sees (every customer repo); the IAM fence (`Service=mf-delivery` tag conditions) limits which services it can touch, not which repos. Decide before the first live pilot: a GitHub App with per-repo installs / a connection per customer org | you | minutes | M5 preview URL |
| Preview identity provider: the delivered api refuses to boot without `AUTH_ISSUER` + `AUTH_JWKS_URL`; the job reads `PREVIEW_AUTH_ISSUER` (our api URL, which publishes `/.well-known/jwks.json`) — set `auth.issuer` per env in `infra/lib/config.ts` (needs the api custom domain); without it the deploy step is skipped with `deployUrl: null` | you | minutes | M5 preview URL |
| GitHub App for the `mjukvaruhuset` org so build jobs mint short-lived per-job installation tokens instead of holding the org token (docs/M3-REVIEW / M9 wanted this; v1 grants the job task role read on `github-token`) | you | hour | job sandbox hardening |
| ACM certificate + `domain` config for `live` (today only `dev` has one): without it the api ALB is plain http and build jobs report over cleartext (`cdk synth` warns `mf:job-api-url-http`, the api logs a warning at start) | you | hours (DNS validation) | job reports over TLS in live |
| Decide on a second uid for worker sessions in the job image (workers run as `node`, same as the reporter process, so `ptrace`/`/proc/<pid>/mem` on the node process could read the live report token; the bootstrap token is already one-shot) — Agent SDK needs a writable HOME for that uid | you | hours | untrusted-code isolation |
| Activate the `Environment` cost-allocation tag (Billing → Cost allocation tags → user-defined → activate; takes up to 24 h) so the per-env AWS Budget sees spend instead of 0 | you | 1 day | M9 budget alerts |
| Stripe test-mode keys (Dashboard → Developers → API keys + a webhook endpoint `https://api.<env>.mjukvaruhuset.se/bff/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`): put `sk_test_…` in the `stripe-secret-key` secret and `whsec_…` in `stripe-webhook-secret` (or `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` locally). Until then the api runs the clearly-labelled fake provider (no money moves) | you | minutes | M6 Stripe Checkout in test mode |
| Resident pilot (M8): a customer account to `cdk deploy` `infra/resident` into (their Anthropic key, a fine-grained GitHub token limited to the one repo with contents + issues + pull-requests write), and per installation an entry in the api's `RESIDENT_INSTALLATIONS` secret (`id:token`) so its daily usage records are accepted; Stripe usage-based price for the resident (list × 1.5 + monthly fee) once m6 wires it | you | hours | M8 resident in a real account, resident billing |
