# Stream: m7-site — public site (PLAN.md M7)

Areas: `apps/site` (all), `apps/api` ONLY a new `routes/bff/contact/postContact.ts` +
`services/contactService.ts` + tests. Do not touch portal, harness, db, infra.

## Context
`apps/site` (`@mf/site`, Vite :5175, sv+en via i18next) was instantiated from `templates/web` and
still shows the template's Item demo. Brand: **Mjukvaruhuset** (mjukvaruhuset.se). Portal lives
at portal.<env>.mjukvaruhuset.se (`VITE_PORTAL_URL` — add it to `apps/site/.env*` with dev/live
values; dev: https://portal.dev.mjukvaruhuset.se, live: https://portal.mjukvaruhuset.se).
Pricing (PLAN.md Decisions): S/M/L = 15 000 / 45 000 / 120 000 SEK ex moms, fixed price per
accepted spec, 50 % deposit before build, 50 % on delivery; resident-agent mode = tokens × 1.5 +
monthly fee. Auth is a magic link; BankID later.

## Deliverables
1. Pages (sv default, en toggle, `react-router-dom` v7): Landing (`/`), How it works
   (`/sa-funkar-det` / `/how-it-works`), Pricing (`/priser` / `/pricing`), Contact
   (`/kontakt` / `/contact`). Remove the Item demo from the site (keep it in the portal).
2. Landing: what it is (a customer writes a spec in the portal, the factory builds it with
   sandboxed AI agents under hard budgets and QA gates, delivers a GitHub repo + running URL,
   pays 50/50), the three sizes, a "Start in the portal" CTA to `VITE_PORTAL_URL`, and an honest
   "how it's built" section (Claude Agent SDK on AWS Fargate, every build reviewed by an
   independent agent, fails closed). No fake testimonials, no fake logos, no invented numbers.
3. How it works: the six steps (spec chat → frozen spec + fixed price → deposit → build with live
   progress → QA gates → delivery + balance). Pricing: table + what each size typically covers
   (S: one-page/simple tool, M: app with backend + auth, L: multi-role system), what is included
   (repo, deployment, handover doc, test report), what is not (hosting after handover, third-party
   fees), resident-agent add-on described briefly.
4. Contact form (name, email, message, optional company) → `POST /bff/contact` (Zod body,
   rate-limited per ip like magic links, no auth) → api sends an email to `AUTH_ADMIN_EMAILS`
   through the existing `email` plugin (log transport in dev) and returns 202. Tests for the
   route and the service.
5. Layout: header with language toggle + portal link, footer with company name, contact email
   (hej@mjukvaruhuset.se — placeholder, note in TODO-EXTERNAL that the mailbox must exist),
   and a placeholder org.nr line ("org.nr: under registrering"). Responsive, CSS modules, follow
   `.claude/rules/css-modules.instructions.md` and the portal's visual language (same fonts,
   spacing tokens); light + dark via `prefers-color-scheme`.
6. SEO basics: `<title>`/meta description per page and language, `lang` attribute follows the
   toggle, sitemap.xml + robots.txt in `public/`.
7. The PLAN.md M7 box "Built THROUGH the harness" stays unticked; add a note that the site was
   built by hand tonight and will be rebuilt as the M10 dogfood case.

## Verification
- `npm run lint`, `npm test`, `npm run build`, `npm run smoke` (headless smoke of the built
  SPA) all green. Tick M7 box 1 with the date and a short note.
