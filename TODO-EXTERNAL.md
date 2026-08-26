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
| BankID integration (via a broker e.g. Criipto/Signicat) | broker | weeks | later, not v1 |
| Trademark check on "Mjukvaruhuset" (PRV) | you | days | brand risk |
