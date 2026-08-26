# legal/ — avtalsutkast (DRAFT — EJ GRANSKAD)

Utkast på svenska för juristgranskning (raden "Lawyer review" i TODO-EXTERNAL.md). Inget här är
juridiskt granskat och inget får skickas till kund innan granskningen är klar. Varje dokument
bär markeringen **DRAFT — EJ GRANSKAD** under varje huvudrubrik och avslutas med en engelsk
sammanfattning.

| Fil | Vad | Används när |
|---|---|---|
| [kundavtal.md](kundavtal.md) | Avtal om byggnation till fast pris (frusen spec, 50/50, acceptans = gates + 10 arbetsdagars granskning, IP vid slutbetalning, ansvarstak = avtalsvärdet, AI-genererad kod, tredjepartslicenser) | varje beställning i portalen |
| [pub-avtal.md](pub-avtal.md) | Personuppgiftsbiträdesavtal enligt GDPR art. 28 (underbiträden AWS eu-north-1, Anthropic, GitHub, Stripe) | bilaga till kundavtalet |
| [sla-resident.md](sla-resident.md) | Villkor för residentläget (token-tak, paus, granskningslogg, månadsavgift, ingen upptids-SLA i v1) | tilläggsavtal när kunden aktiverar residenten |
| [villkor-webb.md](villkor-webb.md) | Användarvillkor för webbplats + portal och integritetspolicy inkl. cookies (inga utöver sessionen) | länkas från mjukvaruhuset.se och portalen |

Faktauppgifter som avtalen bygger på (PLAN.md, beslutade 2026-08-26): storleksklasser S/M/L =
15 000 / 45 000 / 120 000 SEK ex moms, 50 % vid beställning och 50 % vid leverans, residentläge =
tokens × 1,5 + månadsavgift, residenten kör på kundens egen Anthropic-nyckel i kundens eget
AWS-konto. Tekniska fakta (gates, tokenbudget, portalens sessionslagring) är hämtade från koden
i `packages/harness`, `packages/resident`, `apps/portal` och `apps/api` per 2026-08-27.

Placeholders att fylla i före granskning: `[BOLAGSNAMN AB]`, `[ORG.NR]`, `[ADRESS]`,
`[MÅNADSAVGIFT]`, `[DATUM]`.
