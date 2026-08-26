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
| Lawyer review of kundavtal, PUB-avtal (GDPR), SLA, IP/liability clause | lawyer | 1–2 weeks | pilots |
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
| ACM certificate + `domain` config for `live` (today only `dev` has one): without it the api ALB is plain http and build jobs report over cleartext (`cdk synth` warns `mf:job-api-url-http`, the api logs a warning at start) | you | hours (DNS validation) | job reports over TLS in live |
| Decide on a second uid for worker sessions in the job image (workers run as `node`, same as the reporter process, so `ptrace`/`/proc/<pid>/mem` on the node process could read the live report token; the bootstrap token is already one-shot) — Agent SDK needs a writable HOME for that uid | you | hours | untrusted-code isolation |
| Activate the `Environment` cost-allocation tag (Billing → Cost allocation tags → user-defined → activate; takes up to 24 h) so the per-env AWS Budget sees spend instead of 0 | you | 1 day | M9 budget alerts |
