# Personuppgiftsbiträdesavtal (PUB-avtal)

> **DRAFT — EJ GRANSKAD.** Utkast för juristgranskning. Får inte användas mot kund innan granskningen
> i TODO-EXTERNAL.md är klar.

Version: utkast 0.1, [DATUM]. Bilaga till Kundavtalet (`kundavtal.md`) och, i förekommande fall,
villkoren för residentläget (`sla-resident.md`).

Mellan den kund som anges i beställningen ("Personuppgiftsansvarig", "Kunden") och
**[BOLAGSNAMN AB]**, org.nr [ORG.NR], [ADRESS] ("Personuppgiftsbiträdet", "Leverantören").

## 1. Bakgrund och syfte

_DRAFT — EJ GRANSKAD_

1.1 Leverantören bygger programvara åt Kunden enligt Kundavtalet. Vid detta kan Leverantören
komma att behandla personuppgifter för vilka Kunden är personuppgiftsansvarig, t.ex.
personuppgifter som förekommer i Kundens specifikation, i testdata, i kodförråd som residenten
arbetar i, eller i ärenden (issues) som Kunden lämnar till residenten.

1.2 Detta avtal reglerar den behandlingen i enlighet med artikel 28 i Europaparlamentets och
rådets förordning (EU) 2016/679 ("GDPR") och kompletterande svensk lag.

1.3 För personuppgifter om Kundens kontaktpersoner (kontoinformation, e-post, inloggning,
betalningsuppgifter, kontaktformulär) är Leverantören självständigt personuppgiftsansvarig; den
behandlingen regleras av integritetspolicyn i `villkor-webb.md` och omfattas inte av detta avtal.

## 2. Definitioner

_DRAFT — EJ GRANSKAD_

2.1 Begreppen "personuppgifter", "behandling", "registrerad", "personuppgiftsincident",
"personuppgiftsansvarig" och "personuppgiftsbiträde" har den betydelse som anges i GDPR
artikel 4.

2.2 "Underbiträde" avser ett annat personuppgiftsbiträde som Leverantören anlitar för att
utföra hela eller delar av behandlingen.

## 3. Behandlingens föremål, varaktighet, art och ändamål

_DRAFT — EJ GRANSKAD_

3.1 **Föremål:** de personuppgifter som Kunden lämnar till Tjänsten i specifikationsdialogen,
som testdata, i kodförråd, ärenden eller överlämnat material.

3.2 **Ändamål:** att bygga, testa, granska och leverera programvara enligt Kundavtalet samt, i
residentläget, att bygga ändringsförslag (pull requests) i Kundens kodförråd.

3.3 **Art:** insamling via portalen eller GitHub, lagring, överföring till språkmodell för
generering av kod och tester, körning i isolerad byggmiljö, lagring av leverabler, radering.

3.4 **Kategorier av registrerade:** Kundens anställda och uppdragstagare, Kundens kunder och
användare i den mån Kunden tar med dem i specifikation, testdata eller kodförråd.

3.5 **Kategorier av personuppgifter:** namn, kontaktuppgifter, användarnamn, roller,
befattningar samt de övriga uppgifter Kunden väljer att inkludera. Kunden ska inte lämna känsliga
personuppgifter (GDPR art. 9), uppgifter om lagöverträdelser (art. 10) eller personnummer utan
föregående skriftlig överenskommelse med Leverantören.

3.6 **Varaktighet:** under Kundavtalets giltighetstid och därefter enligt punkt 10.

## 4. Kundens ansvar

_DRAFT — EJ GRANSKAD_

4.1 Kunden ansvarar för att det finns rättslig grund för behandlingen, att de registrerade fått
information och att Kundens instruktioner till Leverantören är lagenliga.

4.2 Kunden ska minimera personuppgifter i specifikationer, testdata och ärenden. Syntetiska
testdata ska användas där det är möjligt.

4.3 Kundens dokumenterade instruktioner utgörs av Kundavtalet, detta avtal, den frusna
specifikationen och de uppgifter Kunden lämnar via Tjänstens funktioner. Ytterligare
instruktioner ska lämnas skriftligen.

## 5. Leverantörens skyldigheter (GDPR art. 28.3)

_DRAFT — EJ GRANSKAD_

5.1 Leverantören ska behandla personuppgifterna **endast på dokumenterade instruktioner** från
Kunden, inklusive vid överföring till tredjeland, såvida inte behandling krävs enligt
unionsrätten eller svensk rätt; i så fall ska Leverantören informera Kunden innan behandlingen,
om inte lagen förbjuder det.

5.2 Leverantören ska omedelbart informera Kunden om Leverantören anser att en instruktion
strider mot GDPR eller annan dataskyddslagstiftning.

5.3 Leverantören ska säkerställa att personer med behörighet att behandla personuppgifterna
har åtagit sig att iaktta konfidentialitet eller omfattas av lagstadgad tystnadsplikt.

5.4 Leverantören ska vidta de säkerhetsåtgärder som krävs enligt GDPR art. 32, se punkt 7.

5.5 Leverantören ska, med hänsyn till behandlingens art, bistå Kunden med lämpliga tekniska och
organisatoriska åtgärder så att Kunden kan fullgöra sin skyldighet att svara på begäran om
utövande av de registrerades rättigheter (GDPR kap. III). Begäran som kommer direkt till
Leverantören vidarebefordras till Kunden utan oskäligt dröjsmål.

5.6 Leverantören ska bistå Kunden med att fullgöra skyldigheterna enligt GDPR art. 32–36
(säkerhet, incidentanmälan, konsekvensbedömning, förhandssamråd), med beaktande av behandlingens
art och den information Leverantören har tillgång till.

5.7 Leverantören ska efter avslutad behandling radera eller återlämna personuppgifterna enligt
punkt 10.

5.8 Leverantören ska ge Kunden tillgång till all information som krävs för att visa att
skyldigheterna i denna punkt fullgjorts samt möjliggöra och bidra till granskningar enligt
punkt 9.

5.9 Bistånd enligt punkterna 5.5–5.6 som går utöver vad Tjänstens funktioner (portal,
granskningslogg, leverabler) tillhandahåller ersätts enligt Leverantörens vid var tid gällande
timtaxa, om inte bistånden orsakats av Leverantörens avtalsbrott.

## 6. Underbiträden

_DRAFT — EJ GRANSKAD_

6.1 Kunden lämnar härmed ett **allmänt förhandsgodkännande** till att Leverantören anlitar
underbiträden. Vid avtalets ingående anlitas följande underbiträden:

| Underbiträde | Tjänst | Behandling | Plats |
|---|---|---|---|
| Amazon Web Services EMEA SARL (AWS) | Molninfrastruktur: databas, lagring av leverabler och byggartefakter, byggmiljöer (containers), e-postutskick, hemlighetshantering | Lagring och körning av all data i Tjänsten | Region **eu-north-1 (Stockholm)**, EU. Supportåtkomst kan ske från tredjeland under AWS standardavtalsklausuler |
| Anthropic PBC / Anthropic Ireland Ltd | Språkmodell-API (Claude) | Specifikation, kod, tester och ärendetext skickas till modellen för generering av plan, kod, tester och granskning | USA (tredjeland); överföring enligt punkt 8. Enligt Anthropics API-villkor används data inte för modellträning |
| GitHub, Inc. (Microsoft) | Kodförråd, pull requests, ärenden | Källkod och dokumentation levereras till ett privat förråd; i residentläget läses ärenden och skapas pull requests | USA (tredjeland); överföring enligt punkt 8 |
| Stripe Payments Europe, Ltd. / Stripe, Inc. | Betaltjänst | Betalningsuppgifter för Kundens beställningar (Leverantören är här självständigt ansvarig, se punkt 1.3; anges för fullständighet) | Irland/USA |

6.2 Leverantören ska informera Kunden skriftligen (e-post till registrerad adress eller
meddelande i portalen) om planerade tillägg eller byten av underbiträden **minst trettio (30)
dagar** innan ändringen träder i kraft. Kunden får invända på sakliga grunder inom den tiden.
Kan Parterna inte enas har Kunden rätt att säga upp den berörda beställningen eller
residentläget; Leverantören återbetalar då förskott för arbete som inte påbörjats.

6.3 Leverantören ska ålägga varje underbiträde samma dataskyddsskyldigheter som följer av detta
avtal genom skriftligt avtal, och förblir fullt ansvarig gentemot Kunden för underbiträdets
fullgörande.

6.4 I residentläget körs Leverantörens programvara i **Kundens eget AWS-konto** och mot
**Kundens egen Anthropic-nyckel och Kundens eget GitHub-förråd**. Dessa leverantörer är då
Kundens egna biträden enligt Kundens avtal med dem, inte Leverantörens underbiträden. Till
Leverantören överförs endast dagliga mätdata (tokenförbrukning, antal uppgifter, kostnadsestimat),
som normalt inte innehåller personuppgifter.

## 7. Säkerhetsåtgärder (GDPR art. 32)

_DRAFT — EJ GRANSKAD_

Leverantören tillämpar minst följande tekniska och organisatoriska åtgärder:

7.1 All data lagras i AWS region eu-north-1. Data krypteras under överföring (TLS) och i vila
(AWS-hanterade nycklar för databas och lagring).

7.2 Hemligheter (API-nycklar, signeringsnycklar, tokens) lagras i AWS Secrets Manager och ges
aldrig till byggmiljöer som kör genererad kod; byggmiljöer får en tillfällig, uppdragsspecifik
behörighet som återkallas när uppdraget avslutas.

7.3 Byggmiljöer körs i isolerade containers med nätverksåtkomst begränsad till en vitlista
(paketregister, GitHub, språkmodell-API) och med hårda gränser för resursförbrukning och tid.

7.4 Åtkomst till Tjänsten sker genom personlig inloggning (engångslänk via e-post) och
kortlivade signerade sessionsbevis; Kundens uppgifter är avgränsade per
organisation. Administrativ åtkomst är begränsad till namngivna personer hos Leverantören.

7.5 Databasen säkerhetskopieras automatiskt (7 dagar i utvecklingsmiljö, 30 dagar i
produktion); lagring av leverabler är versionerad.

7.6 Loggning och larm för avvikande beteende (misslyckade jobb, onormal tokenförbrukning,
kostnadsavvikelser); tredjepartsberoenden övervakas för kända sårbarheter.

7.7 Leverantörens personal och eventuella underkonsulter omfattas av sekretessåtaganden.

7.8 Leverantören dokumenterar åtgärderna och deras utveckling i sin driftdokumentation och gör
den tillgänglig för Kunden på begäran.

## 8. Överföring till tredjeland

_DRAFT — EJ GRANSKAD_

8.1 Behandling hos Anthropic och GitHub innebär överföring av personuppgifter till USA.
Överföringen sker med stöd av (a) EU-kommissionens beslut om adekvat skyddsnivå för
EU–US Data Privacy Framework för leverantörer som är certifierade under det, och i övrigt (b)
EU-kommissionens standardavtalsklausuler (beslut (EU) 2021/914) som ingår i respektive
leverantörs dataskyddsvillkor, kompletterade med de åtgärder som anges i punkt 7.

8.2 Leverantören ska informera Kunden om en överföringsmekanism upphör att vara giltig och
vidta rimliga åtgärder för att säkerställa en alternativ laglig grund.

8.3 Kunden kan begränsa överföringen genom att minimera personuppgifter i det material som
lämnas till Tjänsten (punkt 4.2).

## 9. Granskning och revision

_DRAFT — EJ GRANSKAD_

9.1 Kunden har rätt att en (1) gång per kalenderår, samt vid misstanke om avtalsbrott eller
efter en personuppgiftsincident, genomföra granskning av Leverantörens efterlevnad av detta
avtal. Granskning ska aviseras minst trettio (30) dagar i förväg, ske under kontorstid, inte
störa Leverantörens verksamhet oskäligt och får utföras av oberoende revisor som omfattas av
sekretess.

9.2 Leverantören får i första hand uppfylla granskningsrätten genom att tillhandahålla
dokumentation, tredjepartsrapporter från underbiträden (t.ex. AWS SOC-rapporter) och den
granskningslogg Tjänsten för.

9.3 Kunden bär sina egna kostnader för granskningen; Leverantörens tid ersätts enligt gällande
timtaxa om granskningen inte påvisar väsentliga brister.

## 10. Radering och återlämning

_DRAFT — EJ GRANSKAD_

10.1 Vid Kundavtalets upphörande, eller på Kundens skriftliga begäran dessförinnan, ska
Leverantören radera eller återlämna personuppgifterna och radera befintliga kopior, såvida inte
lagring krävs enligt lag (t.ex. bokföringslagen).

10.2 Leverabler (kodförråd, arkivfiler, dokumentation) återlämnas genom Leveransen enligt
Kundavtalet. Leverantörens kopior av Specifikationen, leverablerna samt bygg- och gate-rapporter
behålls enligt Kundavtalet punkt 7.3 (support, kravfrist och tvistehantering) och raderas senast
tolv (12) månader efter acceptans, eller — om en tvist om beställningen pågår — när tvisten
avslutats. Kunden kan begära tidigare radering; Leverantören får då avböja support enligt
Kundavtalet punkt 6 och återställande enligt Kundavtalet punkt 10.2 för den beställningen.
Bokföringsunderlag sparas den tid bokföringslagen kräver. Säkerhetskopior av databasen raderas i
takt med den automatiska rotationen (max 30 dagar). _[Öppen punkt: raderingen sker i dag manuellt
på begäran; en automatisk raderingsrutin för leverabler i lagringstjänsten och databasen är inte
byggd ännu — bygg den innan avtalet används mot kund, eller behåll "manuellt" i texten.]_

10.3 Data som skickats till språkmodell-API lagras hos underbiträdet enligt dess
lagringspolicy (för närvarande som mest trettio (30) dagar för missbruksövervakning, om inte
annat överenskommits med underbiträdet). _[Öppen punkt: verifiera aktuell lagringstid i
Anthropics kommersiella villkor före granskning.]_

## 11. Personuppgiftsincidenter

_DRAFT — EJ GRANSKAD_

11.1 Leverantören ska underrätta Kunden **utan onödigt dröjsmål och senast inom 48 timmar**
efter att ha fått kännedom om en personuppgiftsincident som rör Kundens personuppgifter.
Underrättelsen ska, så långt informationen finns tillgänglig, innehålla incidentens art,
berörda kategorier och ungefärligt antal registrerade och uppgifter, sannolika konsekvenser,
vidtagna och föreslagna åtgärder samt kontaktpunkt. Information får lämnas i omgångar.

11.2 Leverantören ska dokumentera incidenter och bistå Kunden vid anmälan till
Integritetsskyddsmyndigheten och vid information till registrerade.

## 12. Ansvar

_DRAFT — EJ GRANSKAD_

12.1 Ansvarsbegränsningen i Kundavtalet punkt 10 gäller även för detta avtal, med tillägget att
begränsningen inte gäller för administrativa sanktionsavgifter som en tillsynsmyndighet ålägger
en Part på grund av den Partens egen överträdelse.

12.2 Vardera Parten ansvarar gentemot registrerade enligt GDPR art. 82.

## 13. Avtalstid och ändringar

_DRAFT — EJ GRANSKAD_

13.1 Detta avtal gäller så länge Leverantören behandlar personuppgifter för Kundens räkning.

13.2 Om GDPR eller tillsynsmyndighets praxis kräver ändringar av avtalet ska Parterna i god tro
förhandla om sådana ändringar; Leverantören får ensidigt uppdatera punkt 6.1 enligt förfarandet
i punkt 6.2 och punkt 7 i skärpande riktning.

13.3 Svensk lag och tvistlösning enligt Kundavtalet punkt 15.

---

## English summary (non-binding)

_DRAFT — NOT REVIEWED. This summary is for orientation only; the Swedish text governs._

- **Roles (§1):** the customer is controller, the supplier is processor, for personal data the
  customer puts into specs, test data, repositories or resident issues. For the customer's own
  account/contact/payment data the supplier is an independent controller (see the privacy policy
  in `villkor-webb.md`).
- **Processing details (§3):** purpose = build, test, review and deliver software (and, in
  resident mode, open pull requests); nature = storage, transfer to an LLM for code generation,
  execution in an isolated build environment; data subjects = customer staff and, if the customer
  includes them, its users; no special-category data or Swedish personal identity numbers without
  prior written agreement.
- **Customer duties (§4):** lawful basis, information to data subjects, data minimisation
  (synthetic test data where possible); instructions = the contract, this DPA, the frozen spec and
  what is entered through the service.
- **Processor duties (§5, art. 28(3)):** process only on documented instructions, flag unlawful
  instructions, confidentiality of staff, art. 32 security, assistance with data-subject requests
  and art. 32–36, deletion/return at the end, audit information. Assistance beyond the product's
  built-in functions is chargeable.
- **Sub-processors (§6):** general prior authorisation with a 30-day notice and objection right.
  Current list: **AWS (eu-north-1, Stockholm)** for all infrastructure; **Anthropic** (LLM API,
  US, no training on API data); **GitHub** (delivery repositories, issues/PRs; US);
  **Stripe** (payments — listed for completeness, supplier is controller there). In resident mode
  the software runs in the customer's own AWS account with the customer's own Anthropic key and
  GitHub repo, so those providers are the customer's processors; only daily usage metrics reach
  the supplier.
- **Security (§7):** EU-only storage, TLS and encryption at rest, secrets in Secrets Manager
  never exposed to build sandboxes, per-job short-lived credentials, network-allowlisted
  containers with hard token/time budgets, magic-link login with short-lived signed tokens, org-scoped data, automated backups (7/30 days), alarms, dependency scanning.
- **Third-country transfers (§8):** to the US for Anthropic and GitHub, under the EU–US Data
  Privacy Framework where certified and otherwise the 2021 SCCs in the vendors' data terms.
- **Audit (§9):** once a year (plus for cause) with 30 days' notice, primarily via documentation
  and sub-processor reports; supplier time is chargeable unless material deficiencies are found.
- **Deletion (§10):** delete or return at contract end; supplier copies of specs, deliverables
  and gate reports are kept per the customer agreement §7.3 and deleted within 12 months of
  acceptance (longer while a dispute is open; earlier on request, which ends support/restore for
  that order; deletion is manual today — open point); DB backups roll off within 30 days; LLM-side retention per the
  vendor's policy (open point to verify).
- **Breaches (§11):** notice to the customer without undue delay and within 48 hours of
  awareness, with the art. 33 content, possibly in stages.
- **Liability and term (§12–13):** the main contract's liability cap applies, except for
  regulatory fines caused by a party's own violation; the DPA lasts as long as processing does;
  Swedish law.
