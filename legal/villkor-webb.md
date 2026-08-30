# Användarvillkor och integritetspolicy — mjukvaruhuset.se och kundportalen

> **DRAFT — EJ GRANSKAD.** Utkast för juristgranskning. Får inte publiceras innan granskningen i
> TODO-EXTERNAL.md är klar.

Version: utkast 0.1, [DATUM]

Tjänsterna tillhandahålls av **[BOLAGSNAMN AB]**, org.nr [ORG.NR], [ADRESS], e-post
hej@mjukvaruhuset.se ("vi", "oss").

# Del A — Användarvillkor

## 1. Omfattning

_DRAFT — EJ GRANSKAD_

1.1 Dessa villkor gäller för besök på den publika webbplatsen **mjukvaruhuset.se**
("Webbplatsen") och för användning av kundportalen på **portal.mjukvaruhuset.se** ("Portalen").

1.2 Beställningar som läggs i Portalen regleras av Kundavtalet (`kundavtal.md`), residentläget
av `sla-resident.md`. Vid motstridighet har de avtalen företräde framför dessa villkor.

1.3 Genom att använda Webbplatsen eller skapa ett konto i Portalen accepterar du villkoren. Den
som skapar ett konto för en organisations räkning intygar att hen har behörighet att binda
organisationen.

## 2. Konto och inloggning

_DRAFT — EJ GRANSKAD_

2.1 Konto skapas genom att ange en e-postadress och följa engångslänken vi skickar; inloggning
sker utan lösenord. Vid första inloggningen skapas en egen organisation för kontot. Organisationen
namnges som standard efter e-postadressens domän (t.ex. `acme.se`) eller, om adressen tillhör en
allmän e-postleverantör (t.ex. gmail.com, outlook.com), efter den del av adressen som står före
`@`. Namnet kan ändras på begäran. Ingen ansluts automatiskt till en annan organisation på grund
av e-postdomän; ytterligare användare läggs till i en organisation av oss på organisationens
begäran. Du kan också logga in med GitHub ("Sign in with GitHub"): vi hämtar då ditt GitHub-id,
ditt GitHub-användarnamn och din verifierade primära e-postadress hos GitHub (behörighet
`user:email`, ingen åtkomst till dina kodförråd) och kopplar dem till kontot med samma
e-postadress, eller skapar ett nytt konto. GitHubs åtkomsttoken används bara under själva
inloggningen och sparas inte. Saknar GitHub-kontot en verifierad e-postadress avvisas
inloggningen. Ett konto kan ha en GitHub-koppling åt gången; loggar du in med ett annat
GitHub-konto med samma e-postadress ersätts kopplingen.

2.2 Du ansvarar för att din e-postadress är skyddad. Engångslänkar är giltiga i 15 minuter och
får inte vidarebefordras. Meddela oss omedelbart vid misstanke om obehörig åtkomst.

2.3 Vi får stänga av konton som används i strid med villkoren, för intrångsförsök, för att
belasta tjänsten onormalt eller för att lägga in olagligt innehåll.

## 3. Innehåll du lämnar

_DRAFT — EJ GRANSKAD_

3.1 Du behåller rättigheterna till det innehåll du lägger in i Portalen (specifikationer,
meddelanden, material). Du ger oss rätt att behandla innehållet i den mån som krävs för att
tillhandahålla tjänsten, enligt Kundavtalet och Personuppgiftsbiträdesavtalet.

3.2 Du ansvarar för att innehållet inte kränker tredje mans rätt eller strider mot lag, och för
att inte lägga in hemligheter (lösenord, nycklar) i specifikationer eller kontaktformulär.

## 4. Immateriella rättigheter till Webbplatsen och Portalen

_DRAFT — EJ GRANSKAD_

4.1 Webbplatsen, Portalen, deras utformning, texter, varumärken och underliggande programvara
tillhör oss eller våra licensgivare. Du får inte kopiera, dekompilera eller använda dem för att
bygga en konkurrerande tjänst, utöver vad lag tillåter.

## 5. Tillgänglighet och ansvar

_DRAFT — EJ GRANSKAD_

5.1 Webbplatsen och Portalen tillhandahålls i befintligt skick utan garanti om oavbruten
tillgänglighet. Vi får när som helst ändra, begränsa eller stänga funktioner.

5.2 Information på Webbplatsen (t.ex. prislista, beskrivningar av byggprocessen) är allmän
information och utgör inte ett bindande anbud; bindande villkor uppstår först genom en
beställning enligt Kundavtalet.

5.3 Vårt ansvar för användning av Webbplatsen och Portalen som inte omfattas av ett Kundavtal
är begränsat till vad som följer av tvingande lag. Vi ansvarar inte för innehåll på externa
webbplatser vi länkar till.

## 6. Ändringar, lag och tvist

_DRAFT — EJ GRANSKAD_

6.1 Vi får ändra villkoren; ändringar publiceras på Webbplatsen och gäller för användning efter
publiceringen. Väsentliga ändringar meddelas kontoinnehavare via e-post eller i Portalen.

6.2 Svensk lag gäller. Tvist prövas av svensk allmän domstol. Konsumenter kan därutöver vända
sig till Allmänna reklamationsnämnden (ARN); tjänsten riktar sig dock till företag.

# Del B — Integritetspolicy

## 7. Personuppgiftsansvarig och kontakt

_DRAFT — EJ GRANSKAD_

7.1 [BOLAGSNAMN AB] är personuppgiftsansvarig för den behandling som beskrivs i denna policy.
Kontakt: hej@mjukvaruhuset.se, [ADRESS]. Vi har inget dataskyddsombud (krävs inte för vår
verksamhet); frågor ställs till adressen ovan.

7.2 För personuppgifter som en kund lägger in i specifikationer, testdata eller kodförråd är
kunden ansvarig och vi biträde; se `pub-avtal.md`.

## 8. Vilka uppgifter vi behandlar, varför och med vilken rättslig grund

_DRAFT — EJ GRANSKAD_

| Situation | Uppgifter | Ändamål | Rättslig grund | Lagringstid |
|---|---|---|---|---|
| 8.1 Besök på Webbplatsen | IP-adress, tidpunkt, begärd sida, webbläsartyp (i tekniska loggar hos vår innehållsleverans- och webbserver) | Leverera sidan, säkerhet, felsökning | Berättigat intresse (drift och säkerhet) | Loggar raderas inom 30 dagar _[öppen punkt: sätt motsvarande retention på CloudFront-/ALB-loggar i infra]_ |
| 8.2 Kontaktformulär | Namn, e-post, ev. företag, meddelande, avsändar-IP (för begränsning av antal försändelser) | Besvara din förfrågan | Berättigat intresse (besvara förfrågan) / åtgärder inför avtal | E-post hos oss tills ärendet är avslutat, längst 12 månader; IP-räknaren endast i arbetsminnet i högst 10 minuter |
| 8.3 Konto i Portalen | E-postadress, namn (om lämnat), organisation, roll (användare, eller administratör för vår egen personal), tidpunkt för inloggning; engångslänkar och uppdateringsbevis (refresh tokens); vid inloggning med GitHub även GitHub-id och GitHub-användarnamn (även på beställningar som skapas av det kontot) | Autentisering, behörigheter, avtalsfullgörande | Fullgörande av avtal / åtgärder inför avtal | Kontots livstid + 12 månader; engångslänkar 15 minuter; uppdateringsbevis 30 dagar |
| 8.4 Beställningar och byggen | Specifikationer, ordrar, byggloggar, gate-rapporter, leverabler, tokenförbrukning | Fullgöra Kundavtalet, support, bokföring | Fullgörande av avtal; rättslig förpliktelse (bokföringslagen) | Enligt Kundavtalet/PUB-avtalet; bokföringsunderlag 7 år |
| 8.5 Betalningar | Belopp, tidpunkt, betalstatus, Stripes kund- och betalningsreferens, faktura-/kvittolänk. Kortuppgifter lämnas direkt till Stripe och når aldrig oss | Ta betalt, fakturera | Fullgörande av avtal; rättslig förpliktelse (bokföring) | 7 år (bokföring) |
| 8.6 E-post till dig | E-postadress, innehåll (engångslänkar, leverans- och byggmeddelanden) | Autentisering och avtalsmeddelanden | Fullgörande av avtal | Loggar hos e-posttjänsten enligt 8.1 |

Vi fattar inga automatiserade beslut med rättslig verkan om dig och gör ingen profilering. Vi
säljer inte personuppgifter.

## 9. Mottagare och överföring till tredjeland

_DRAFT — EJ GRANSKAD_

9.1 Vi använder följande leverantörer som personuppgiftsbiträden: **Amazon Web Services**
(all drift, region Stockholm eu-north-1; e-post via Amazon SES), **Stripe** (betalningar),
**GitHub** (leverans av kod till kundens kodförråd samt, om du väljer det, inloggning med GitHub — GitHub är då självständigt ansvarig för sin egen behandling av ditt GitHub-konto), **Anthropic** (språkmodell som behandlar
specifikationer och kod vid byggen). Se `pub-avtal.md` punkt 6 för detaljer.

9.2 Stripe, GitHub och Anthropic kan behandla uppgifter i USA. Överföringen sker med stöd av
EU–US Data Privacy Framework (där leverantören är certifierad) och EU-kommissionens
standardavtalsklausuler.

9.3 Vi lämnar ut uppgifter till myndigheter när lag kräver det.

## 10. Cookies och lokal lagring — inga cookies utöver sessionen

_DRAFT — EJ GRANSKAD_

10.1 **Webbplatsen sätter inga cookies** och använder inga analys-, spårnings- eller
annonsverktyg från tredje part. Ditt val av ljust/mörkt tema sparas endast i webbläsarens
lokala lagring (`localStorage`) på din enhet och skickas inte till oss.

10.2 **Portalen** lagrar, efter att du loggat in, ett sessionsbevis (giltigt 1 timme) och ett
uppdateringsbevis (giltigt 30 dagar) i webbläsarens lokala lagring, samt ditt temaval. De är
nödvändiga för att hålla dig inloggad och kräver därför inget samtycke enligt lagen om
elektronisk kommunikation. De raderas när du loggar ut. Inga andra cookies eller liknande
tekniker används.

10.3 Vår innehållsleverantör (AWS CloudFront) och betaltjänsten Stripe kan sätta tekniskt
nödvändiga cookies på sina egna domäner när du betalar; de omfattas av deras respektive
policyer.

10.4 Om vi i framtiden inför cookies som inte är nödvändiga kommer vi att be om samtycke innan
de sätts.

## 11. Dina rättigheter

_DRAFT — EJ GRANSKAD_

11.1 Du har rätt att begära tillgång till, rättelse av och radering av dina personuppgifter,
begränsning av behandlingen, dataportabilitet samt att invända mot behandling som grundas på
berättigat intresse. Kontakta hej@mjukvaruhuset.se; vi svarar inom en månad.

11.2 Du har rätt att lämna klagomål till Integritetsskyddsmyndigheten (IMY), www.imy.se.

11.3 Radering av konto kan begäras när som helst; uppgifter som vi måste behålla enligt lag
(t.ex. bokföringsunderlag) sparas den tid lagen kräver.

## 12. Säkerhet

_DRAFT — EJ GRANSKAD_

12.1 Trafik krypteras (TLS), data lagras krypterat i AWS region Stockholm, hemligheter hanteras
i en dedikerad hemlighetstjänst, inloggning sker utan lösenord (engångslänk via e-post eller
inloggning med GitHub via OAuth med skydd mot förfalskade återanrop) med kortlivade signerade
bevis, och åtkomst till kunddata är avgränsad per organisation. Se vidare
`pub-avtal.md` punkt 7.

## 13. Ändringar av policyn

_DRAFT — EJ GRANSKAD_

13.1 Uppdaterad policy publiceras på Webbplatsen med versionsdatum. Väsentliga ändringar meddelas
kontoinnehavare.

---

## English summary (non-binding)

_DRAFT — NOT REVIEWED. This summary is for orientation only; the Swedish text governs._

**Terms of use (Part A)**

- Apply to the public site mjukvaruhuset.se and the customer portal; orders are governed by the
  customer agreement and resident addendum, which take precedence.
- Accounts are created by e-mail magic link (15-minute validity) or by GitHub sign-in (GitHub
  id, username and verified primary e-mail are read with the `user:email` scope, the GitHub token
  is never stored, one GitHub link per account); each first sign-in gets its own org, named after the e-mail domain or,
  for public mail providers, the local part of the address; nobody joins another org by domain —
  additional users are added by us on the org's request. Users protect their e-mail access; we
  may suspend accounts for abuse.
- Users keep the rights to content they enter and grant us the processing rights needed to
  provide the service; no secrets in specs or the contact form.
- Site, portal and software are our IP; no copying or building a competing service from them.
- Provided as-is, no availability guarantee; website information (incl. the price list) is not a
  binding offer; liability outside a customer agreement is limited to mandatory law.
- We may change the terms with notice; Swedish law and courts; the service targets businesses.

**Privacy policy (Part B)**

- Controller: [company], contact hej@mjukvaruhuset.se; no DPO. For personal data in customer
  specs/code we are processor under the DPA.
- What we process and why: technical logs on site visits (legitimate interest, 30 days); contact
  form name/e-mail/company/message (legitimate interest / pre-contract, max 12 months) plus the
  sender IP in memory for at most 10 minutes for rate limiting; portal account data (e-mail,
  name, org, role), magic links (15 min) and refresh tokens (30 days) (contract); orders, specs, build logs, gate reports,
  deliverables and token usage (contract; bookkeeping 7 years); payment records via Stripe —
  card data never reaches us (contract/bookkeeping, 7 years); transactional e-mails (contract).
  No automated decision-making, no profiling, no selling of data.
- Recipients: AWS (all hosting, Stockholm region; e-mail via SES), Stripe, GitHub, Anthropic;
  US transfers under the EU–US DPF and SCCs; disclosure to authorities when required by law.
- **Cookies: none beyond the session.** The public site sets no cookies and uses no analytics or
  tracking; only the theme choice is kept in the browser's localStorage. The portal keeps a
  1-hour access token, a 30-day refresh token and the theme in localStorage — strictly necessary,
  no consent required, cleared on logout. CloudFront and Stripe may set technically necessary
  cookies on their own domains. Any non-essential cookies in the future will require consent.
- Rights: access, rectification, erasure, restriction, portability, objection; reply within one
  month; complaints to the Swedish Authority for Privacy Protection (IMY); account deletion on
  request subject to legal retention.
- Security: TLS, encryption at rest in eu-north-1, secrets manager, passwordless login (magic link or GitHub OAuth) with
  short-lived signed tokens, org-scoped data.
