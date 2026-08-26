# Villkor för residentläget (tilläggsavtal)

> **DRAFT — EJ GRANSKAD.** Utkast för juristgranskning. Får inte användas mot kund innan granskningen
> i TODO-EXTERNAL.md är klar.

Version: utkast 0.1, [DATUM]. Tillägg till Kundavtalet (`kundavtal.md`); Personuppgiftsbiträdes-
avtalet (`pub-avtal.md`) gäller i tillämpliga delar.

Mellan **[BOLAGSNAMN AB]**, org.nr [ORG.NR] ("Leverantören") och den kund som aktiverar
residentläget ("Kunden").

## 1. Vad residentläget är

_DRAFT — EJ GRANSKAD_

1.1 Residentläget innebär att Leverantörens agentprogramvara ("Residenten") körs kontinuerligt
**i Kundens eget AWS-konto**, arbetar mot **ett (1) av Kunden angivet GitHub-kodförråd** och
använder **Kundens egen Anthropic-API-nyckel**. Varje ärende (issue) i förrådet som Kunden
märker med etiketten `resident`, eller varje uppgift Kunden skickar till Residentens
uppgiftsgränssnitt, byggs genom samma orkestrering och samma Gates som en beställning enligt
Kundavtalet och resulterar i ett **ändringsförslag (pull request)** i förrådet.

1.2 Residenten **sammanfogar aldrig** ändringar själv. Kunden granskar och beslutar om varje
pull request. Vad Kunden sammanfogar, driftsätter eller på annat sätt använder sker på Kundens
ansvar.

1.3 Leverantören tillhandahåller: (a) Residentens programvara och driftsmall (CDK-app) för
installation i Kundens konto, (b) uppdateringar av programvaran, (c) mottagning av mätdata och
fakturering enligt punkt 5, samt (d) support enligt punkt 8. Leverantören driftar inte
Residenten; det gör Kunden i sitt eget konto.

## 2. Installation och Kundens ansvar

_DRAFT — EJ GRANSKAD_

2.1 Kunden installerar Residenten med Leverantörens driftsmall i ett AWS-konto Kunden
kontrollerar, och tillhandahåller i sin hemlighetshantering: en Anthropic-API-nyckel, en
GitHub-token begränsad till det aktuella förrådet (innehåll, ärenden och pull requests), samt
den faktureringsnyckel Leverantören utfärdar.

2.2 Kunden ansvarar för:

   a) sitt avtal med och sina kostnader hos AWS, Anthropic och GitHub, inklusive
   modellanvändning som Residenten orsakar med Kundens nyckel;

   b) att GitHub-token och AWS-behörigheter inte ger Residenten mer åtkomst än mallen kräver;

   c) att sätta ett månatligt token-tak enligt punkt 3 som Kunden är beredd att bekosta;

   d) att granska varje pull request innan sammanfogning, inklusive säkerhetsgranskning av
   AI-genererad kod (Kundavtalet punkt 8);

   e) innehållet i de ärenden som lämnas till Residenten, inklusive att de inte innehåller
   personuppgifter eller hemligheter som inte behövs.

2.3 Kunden får inte använda Residenten för att bygga något som strider mot lag, tredje mans
rätt, eller AWS:s, Anthropics eller GitHubs villkor.

## 3. Token-tak

_DRAFT — EJ GRANSKAD_

3.1 Kunden anger ett **hårt månatligt tak** för modellanvändning, uttryckt i budgetvägda tokens
(`RESIDENT_MONTHLY_TOKENS`; cache-läsningar räknas till 10 %). Kunden kan även sätta ett tak per
uppgift.

3.2 Varje uppgift startar med en budget motsvarande det minsta av uppgiftstaket och vad som
återstår av månaden. Residenten avbryter uppgiften så snart budgeten överskrids. Överskridandet
av månadstaket är därmed begränsat till **högst en modellvändning**. När taket nåtts startas inga
nya uppgifter förrän en ny kalendermånad (UTC) börjar eller Kunden höjer taket.

3.3 Räknaren lagras i Kundens eget konto. Leverantören ansvarar inte för kostnader som beror på
att Kunden ändrat räknaren, taket eller mallens konfiguration, eller för avgifter som Anthropic
eller AWS debiterar utöver vad räknaren registrerar (t.ex. avrundning, prisändringar).

## 4. Pausknapp och kill switch

_DRAFT — EJ GRANSKAD_

4.1 Kunden kan när som helst **pausa** Residenten via dess kontrollgränssnitt (eller genom
konfiguration). Pausen är beständig (överlever omstart), avbryter den uppgift som pågår inom
cirka tio (10) sekunder och hindrar nya uppgifter från att starta tills Kunden återupptar.

4.2 Kunden kan därutöver stoppa Residenten helt genom att stoppa tjänsten i sitt AWS-konto,
återkalla GitHub-token eller Anthropic-nyckeln. Leverantören har ingen teknisk möjlighet att
styra en Resident i Kundens konto och ansvarar inte för att stoppa den.

4.3 Om granskningsloggen enligt punkt 6 inte kan skrivas pausar Residenten sig själv och
avbryter pågående uppgift (fail closed).

## 5. Ersättning — månadsavgift och användningsbaserad avgift

_DRAFT — EJ GRANSKAD_

5.1 Kunden betalar:

   a) en **månadsavgift** om [MÅNADSAVGIFT] SEK exklusive mervärdesskatt per installation
   (ett förråd), som debiteras i förskott per kalendermånad och inte återbetalas för del av
   månad; samt

   b) en **användningsbaserad avgift** motsvarande Anthropics vid var tid gällande listpris för
   den modellanvändning Residenten registrerar, **multiplicerat med 1,5**, debiterad i efterskott
   per kalendermånad.

5.2 Den användningsbaserade avgiften är Leverantörens ersättning för orkestrering, Gates och
programvara. Kundens faktiska kostnad hos Anthropic betalas av Kunden direkt till Anthropic och
ingår inte i Leverantörens avgift. _[Öppen punkt: bekräfta att avgiftsmodellen "kundens egen
nyckel + 1,5 × listpris till oss" är den avsedda; alternativet är att Leverantören står för
nyckeln och 1,5 × listpris täcker även modellkostnaden. PLAN.md anger kundens nyckel i v1.]_

5.3 Underlaget för användningsavgiften är de dagliga mätposter (tokens per modell, antal
uppgifter, kostnadsestimat) som Residenten rapporterar till Leverantören. Rapporteringen är
"sista skrivning gäller" per dag; utebliven rapportering under en period rapporteras i efterhand.
Kunden ska inte hindra rapporteringen; gör Kunden det får Leverantören fakturera enligt
Residentens lokala mätdata eller, om de inte lämnas ut, säga upp avtalet enligt punkt 9.

5.4 Fakturering och betalning sker via den betaltjänst Leverantören anvisar (Stripe), med
betalningsvillkor tio (10) dagar. Dröjsmålsränta enligt räntelagen.

5.5 Leverantören får ändra månadsavgiften och multiplikatorn med sextio (60) dagars skriftligt
varsel till nästkommande månadsskifte. Anthropics prisändringar slår igenom direkt eftersom
avgiften följer listpriset.

## 6. Granskningslogg och insyn

_DRAFT — EJ GRANSKAD_

6.1 Residenten skriver **varje åtgärd** som en post i en granskningslogg i Kundens eget konto
(en fil per dag) innan nästa åtgärd påbörjas: start, paus/återupptagning, nått tak, uppgift köad/
startad/planerad/avslutad/misslyckad/omköad, varje arbetsdeluppgift, kommandon som Gates kör,
varje Gate med resultat och tokenåtgång, löpande tokenräkning, ändrade filer, öppnad pull request
och rapporterad mätdata.

6.2 Loggen är Kundens egendom och lämnar inte Kundens konto. Kunden ansvarar för lagringstid
och åtkomstkontroll i sitt konto. Leverantören får, på Kundens begäran, ta del av loggen för
support eller för att verifiera underlag för fakturering.

6.3 Kommandon som AI-agenterna själva kör i byggmiljön loggas inte enskilt; det gör däremot
vilka filer som ändrats, vilka Gates som körts och hur mycket modellanvändning varje steg
orsakat.

## 7. Servicenivå — ingen upptidsgaranti i v1

_DRAFT — EJ GRANSKAD_

7.1 Residentläget tillhandahålls i sin nuvarande form som en **tidig version (v1)**.
**Leverantören lämnar ingen garanti om tillgänglighet, svarstid eller genomströmning** för
Residenten, för Leverantörens mottagning av mätdata eller för de tredjepartstjänster Residenten
är beroende av. Ingen kompensation utgår för avbrott.

7.2 Leverantören strävar efter att: (a) svara på supportärenden enligt punkt 8, (b) publicera
programvaruuppdateringar med ändringsförteckning, och (c) inte göra ändringar som kräver ny
installation utan trettio (30) dagars varsel, förutom säkerhetsrättningar.

7.3 Residenten hanterar **en uppgift åt gången**, äldst först. Ingen garanti lämnas för att en
enskild uppgift resulterar i en pull request; uppgifter som inte klarar Gates markeras som
misslyckade med angiven orsak, och den modellanvändning som förbrukats debiteras enligt punkt 5
även då.

7.4 Parterna avser att införa servicenivåer med mätbara åtaganden i en senare version, genom
skriftligt tillägg.

## 8. Support och uppdateringar

_DRAFT — EJ GRANSKAD_

8.1 Support ges via e-post på helgfria vardagar 09–17 svensk tid, med målsättningen att svara
inom en (1) arbetsdag. Supporten omfattar installation, konfiguration av tak och paus, tolkning
av granskningsloggen samt fel i Residentens programvara.

8.2 Kunden ska installera uppdateringar som Leverantören betecknar som säkerhetskritiska inom
trettio (30) dagar. Leverantören ansvarar inte för fel som beror på att Kunden kör en version
som är äldre än den senaste två (2) versionerna.

## 9. Avtalstid och uppsägning

_DRAFT — EJ GRANSKAD_

9.1 Avtalet löper per kalendermånad och förlängs automatiskt. Vardera Parten får säga upp det
skriftligen till utgången av innevarande kalendermånad. Redan betald månadsavgift återbetalas
inte; upplupen användningsavgift faktureras.

9.2 Leverantören får säga upp avtalet med omedelbar verkan om Kunden bryter mot punkt 2.3 eller
5.3, eller om betalning är försenad mer än trettio (30) dagar efter påminnelse.

9.3 Vid upphörande avinstallerar Kunden Residenten och återkallar de nycklar som utfärdats.
Leverantörens faktureringsnyckel spärras. Pull requests, kod och granskningslogg finns kvar i
Kundens förråd och konto och berörs inte.

## 10. Immateriella rättigheter, ansvar, personuppgifter

_DRAFT — EJ GRANSKAD_

10.1 Kod och dokumentation som Residenten skapar i Kundens förråd tillfaller Kunden på samma
villkor som det Kundspecifika resultatet i Kundavtalet punkt 7, med den skillnaden att övergången
sker löpande när ändringsförslaget skapas, förutsatt att Kunden inte är i betalningsdröjsmål.
Residentens programvara, driftsmall och agentinstruktioner förblir Leverantörens och får endast
användas för Kundens egen installation.

10.2 Kundavtalets punkter 8 (AI-genererad kod), 9 (tredjepartslicenser), 10 (ansvarsbegränsning)
och 12 (sekretess) gäller. **Ansvarstaket** för residentläget är de avgifter Kunden betalat
till Leverantören enligt detta tillägg under de tolv (12) månaderna före den händelse som
grundar kravet. Leverantören ansvarar aldrig för Kundens kostnader hos AWS, Anthropic eller
GitHub, utom när de bevisligen orsakats av ett fel i Residentens programvara som gör att
token-taket enligt punkt 3 inte upprätthålls, och då högst upp till ansvarstaket.

10.3 Eftersom Residenten körs i Kundens konto på Kundens nycklar är AWS, Anthropic och GitHub
Kundens egna biträden (`pub-avtal.md` punkt 6.4). Leverantören behandlar för Kundens räkning
endast mätdata och, vid support, de logguppgifter Kunden delar.

## 11. Övrigt

_DRAFT — EJ GRANSKAD_

11.1 I övrigt gäller Kundavtalets punkter 14 och 15 (övrigt, tillämplig lag, tvist).

---

## English summary (non-binding)

_DRAFT — NOT REVIEWED. This summary is for orientation only; the Swedish text governs._

- **What it is (§1):** the supplier's resident agent runs continuously **in the customer's own
  AWS account**, against **one GitHub repository**, on the **customer's own Anthropic key**.
  Issues labelled `resident` (or tasks posted to its API) are built through the same
  orchestration and gates as a factory order and become **pull requests**. The resident never
  merges; the customer reviews and merges. The customer operates it; the supplier ships the
  software/CDK template, updates, metering intake, billing and support.
- **Installation and customer duties (§2):** deploy the template, provide the Anthropic key, a
  repo-scoped GitHub token and the supplier's billing key; own the AWS/Anthropic/GitHub contracts
  and costs; least-privilege tokens; set a monthly token cap; review every PR (incl. security
  review of AI code); keep secrets and unnecessary personal data out of issues; lawful use only.
- **Token cap (§3):** hard monthly cap in budget-weighted tokens (cache reads at 10 %), plus an
  optional per-task cap; each task's budget = min(task cap, what is left of the month); the
  harness aborts on breach, so overshoot is at most one model turn; nothing starts once the cap is
  hit until a new UTC month or a higher cap. The supplier is not liable for costs caused by the
  customer altering the counter/config or for provider charges beyond what the counter records.
- **Pause / kill switch (§4):** persistent pause via the control API aborts the task in flight
  within ~10 s and blocks new tasks; the customer can also stop the service or revoke keys. The
  supplier cannot control a resident in the customer's account. Audit write failure pauses the
  resident (fail closed).
- **Fees (§5):** a **monthly fee** per installation (in advance, non-refundable) plus a
  **usage-based fee = Anthropic list price × 1.5** on the resident's recorded usage (in arrears).
  The customer additionally pays Anthropic directly for the key (open point: confirm this is the
  intended model vs. the supplier providing the key). Billing is based on the daily usage records
  the resident reports (last write wins per day); blocking the reporting allows billing from local
  data or termination. Stripe invoicing, 10-day terms; 60 days' notice for fee changes; Anthropic
  list-price changes pass through immediately.
- **Audit log (§6):** every action is logged in the customer's own bucket before the next action
  starts (start, pause/resume, cap reached, task lifecycle, workers, gate commands, each gate with
  tokens, running totals, files changed, PR opened, usage reported). The log is the customer's;
  the supplier sees it only on request. Commands the agents themselves run are not individually
  logged.
- **Service level (§7):** v1, **no uptime, latency or throughput SLA**, no service credits;
  best-effort support, changelogged updates, 30 days' notice for changes requiring reinstall
  (except security fixes); one task at a time; no guarantee that a task yields a PR, and usage is
  billable even when a task fails the gates. Measurable SLAs may come in a later version by
  written addendum.
- **Support and updates (§8):** email support on Swedish business days 09–17, target response
  one business day; security-critical updates must be installed within 30 days; no liability for
  versions older than the last two.
- **Term (§9):** month-to-month, terminable by either party to the end of the current month;
  immediate termination for misuse, blocked metering or 30+ days' late payment; on exit the
  customer uninstalls and revokes keys, code and logs stay in the customer's account.
- **IP, liability, data (§10):** output belongs to the customer as it is produced (unless in
  payment default); the resident software and templates stay the supplier's. Main-contract clauses
  on AI code, third-party licences, liability and confidentiality apply; the **liability cap is
  the fees paid under this addendum in the preceding 12 months**; no liability for the customer's
  cloud/LLM/GitHub costs except where a software defect breaks the token cap, and then only up to
  the cap. AWS, Anthropic and GitHub are the customer's own processors here; the supplier only
  processes usage metrics.
