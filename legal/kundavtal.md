# Kundavtal — byggnation av programvara till fast pris

> **DRAFT — EJ GRANSKAD.** Utkast för juristgranskning. Får inte användas mot kund innan granskningen
> i TODO-EXTERNAL.md är klar.

Version: utkast 0.1, [DATUM]

Mellan **[BOLAGSNAMN AB]**, org.nr [ORG.NR], [ADRESS] ("Leverantören", "vi"), och den kund som
anges i beställningen i kundportalen ("Kunden"). Leverantören och Kunden benämns gemensamt
"Parterna".

## 1. Bakgrund och avtalets omfattning

_DRAFT — EJ GRANSKAD_

1.1 Leverantören tillhandahåller en tjänst där en programvaruapplikation byggs av ett
automatiserat system baserat på stora språkmodeller (AI-agenter) utifrån en kravspecifikation
som Parterna gemensamt tar fram i Leverantörens kundportal ("Tjänsten").

1.2 Detta avtal gäller för varje beställning som Kunden lägger i kundportalen och som
Leverantören bekräftar. Avtalet består av (a) dessa villkor, (b) den frusna specifikationen
enligt punkt 2, (c) prisuppgiften i beställningen samt (d) Personuppgiftsbiträdesavtalet
(`pub-avtal.md`) i den mån personuppgifter behandlas. Vid motstridighet gäller handlingarna i
den ordning de räknas upp, med undantag för att Personuppgiftsbiträdesavtalet har företräde i
frågor om personuppgiftsbehandling.

1.3 Villkoren för residentläget (`sla-resident.md`) gäller endast om Kunden aktiverat det läget
och är då ett tillägg till detta avtal.

## 2. Specifikationen — omfattningen är den frusna specifikationen

_DRAFT — EJ GRANSKAD_

2.1 Kunden beskriver sitt behov i portalens specifikationsdialog. Dialogen resulterar i en
strukturerad specifikation med mål, användare, funktioner, avgränsningar (icke-mål),
acceptanskriterier och tekniska begränsningar ("Specifikationen").

2.2 När Kunden bekräftar Specifikationen i portalen låses den ("Frusen specifikation").
Tidpunkten för frysning, storleksklass och pris registreras i portalen och kan inte ändras utan
att en ny beställning läggs.

2.3 **Den Frusna specifikationen utgör avtalets hela omfattning.** Funktioner, egenskaper eller
kvaliteter som inte framgår av den Frusna specifikationen ingår inte, även om de kan anses
underförstådda i branschen. Vad som anges som icke-mål ingår uttryckligen inte.

2.4 Ändringar efter frysning hanteras som en ny beställning (ny specifikation, nytt pris) eller,
om Parterna kommer överens om det skriftligen, genom att den pågående beställningen avbryts
enligt punkt 11 och en ny läggs.

2.5 Kunden ansvarar för att Specifikationen är riktig, fullständig och inte kräver att
Leverantören gör intrång i tredje mans rätt eller bryter mot lag.

## 3. Pris och betalning — 50/50

_DRAFT — EJ GRANSKAD_

3.1 Priset är fast och bestäms av Specifikationens storleksklass (S, M eller L) enligt den
prislista som visas i portalen när Specifikationen fryses. Priset anges i svenska kronor
exklusive mervärdesskatt. Mervärdesskatt tillkommer enligt gällande lag.

3.2 Betalning sker i två lika delar:

   a) **Förskott, 50 %** av priset, betalas i samband med att Specifikationen fryses. Byggnationen
   påbörjas inte förrän förskottet är mottaget.

   b) **Slutbetalning, 50 %** av priset, förfaller till betalning när leveransen accepterats
   enligt punkt 5.6 och ska erläggas inom tio (10) dagar från acceptansen. Leverantören
   tillgängliggör betalningen i portalen vid Leveransen; Kunden får betala tidigare, men en
   tidigare betalning påverkar inte Granskningsperioden eller Kundens rättigheter enligt
   punkt 5.4–5.7.

3.3 Betalning sker genom den betaltjänst som portalen anvisar (för närvarande Stripe). Kvitto
och faktura tillhandahålls via betaltjänsten. Vid försenad betalning utgår dröjsmålsränta enligt
räntelagen (1975:635) samt ersättning för betalningspåminnelse och inkassokostnader enligt lag.

3.4 Priset inkluderar den beräkningskostnad (AI-modellanvändning, byggmiljö) som krävs för att
bygga applikationen inom den tokenbudget som Leverantören avsätter för storleksklassen. Kunden
debiteras inte separat för beräkningskostnad under detta avtal.

3.5 Priset inkluderar inte drift av den levererade applikationen efter Leverans, domäner,
tredjepartstjänster (t.ex. molnkonto, betaltjänst, e-posttjänst) eller support utöver vad som
anges i punkt 6.

## 4. Byggprocessen

_DRAFT — EJ GRANSKAD_

4.1 Leverantören bygger applikationen automatiserat: Specifikationen planeras i deluppgifter
som utförs av AI-agenter i isolerade byggmiljöer, sammanfogas och prövas mot de kontroller som
anges i punkt 5.2 ("Gates").

4.2 Byggnationen sker i en avgränsad miljö med begränsad nätverksåtkomst och en hård gräns för
resursförbrukning (tokenbudget och maximal byggtid). Om gränsen nås utan att Gates passerats
avbryts bygget och Leverantören gör **minst ett förnyat försök** på Leverantörens bekostnad.
Leverantören får därvid justera planeringen och byggmiljön men inte Specifikationen. Kan bygget
inte slutföras inom budgeten efter förnyat försök får Leverantören avbryta beställningen enligt
punkt 11.2. Ett avbrytande på den grunden utgör inte avtalsbrott från Leverantörens sida.

4.3 Kunden kan följa byggets förlopp i portalen. Förloppsinformationen är informativ och utgör
inte Leverans.

4.4 Leverantören väljer teknisk lösning, ramverk, bibliotek och struktur inom Specifikationens
tekniska begränsningar. Leverantören får använda den mall och de konventioner som Leverantören
vid var tid använder.

## 5. Leverans och acceptans — Gates plus granskningsperiod

_DRAFT — EJ GRANSKAD_

5.1 **Leverans** sker när Leverantören tillgängliggör för Kunden i portalen: (a) applikationens
källkod i ett privat kodförråd hos GitHub där Kunden ges administratörsbehörighet, eller — om
Kunden saknar GitHub-konto — som arkivfil, (b) överlämningsdokumentation (handover) och
testrapport, samt (c) i förekommande fall en adress till en förhandsvisning (preview) av den
körande applikationen. Förhandsvisningen är tillfällig och ingår inte i Leveransen som sådan.

5.2 Leverans sker endast om samtliga följande **Gates** passerats:

   a) *verify*: applikationens kodkontroll (lint), automatiska tester och bygge går igenom;

   b) *acceptance-tests*: ett automatiskt test per acceptanskriterium i den Frusna
   specifikationen har genererats och går igenom;

   c) *review*: en automatisk kodgranskning har genomförts utan blockerande anmärkningar;

   d) *acceptance-check*: varje acceptanskriterium har kopplats till bevis i form av kod eller
   test, och inget kriterium är ouppfyllt eller obedömt.

Gate-rapporterna ingår i testrapporten och utgör Leverantörens bevis om uppfyllelse.

5.3 **Granskningsperiod.** Kunden har tio (10) arbetsdagar från Leveransen att granska
leveransen ("Granskningsperioden"). Med arbetsdag avses helgfri måndag–fredag i Sverige.

5.4 Under Granskningsperioden får Kunden skriftligen (via portalen eller e-post till
Leverantören) anmäla **Avvikelse**, dvs. att ett acceptanskriterium i den Frusna
specifikationen inte är uppfyllt. Anmälan ska ange kriteriet och hur avvikelsen visar sig.
Synpunkter som avser funktioner utanför den Frusna specifikationen, val av teknik, kodstil eller
utseende som inte är specificerat utgör inte Avvikelse.

5.5 Leverantören ska åtgärda anmälda Avvikelser utan extra kostnad och tillgängliggöra en ny
leverans. Efter en ny leverans löper en ny Granskningsperiod om fem (5) arbetsdagar, dock endast
för de anmälda Avvikelserna.

5.6 Leveransen anses **accepterad** när det tidigaste av följande inträffar: (a) Kunden
skriftligen godkänner leveransen, (b) Granskningsperioden löper ut utan att Avvikelse anmälts,
eller (c) Kunden tar applikationen i produktiv drift. Slutbetalning i sig utgör inte acceptans.

5.7 Om Leverantören inom rimlig tid, dock högst två (2) ytterligare leveranser, inte kan åtgärda
en Avvikelse som avser ett acceptanskriterium, har Kunden rätt att antingen acceptera leveransen
med ett prisavdrag som Parterna kommer överens om, eller häva beställningen enligt punkt 11.3.

## 6. Support efter leverans

_DRAFT — EJ GRANSKAD_

6.1 Under trettio (30) dagar från acceptans rättar Leverantören utan kostnad fel som innebär att
ett acceptanskriterium i den Frusna specifikationen inte längre uppfylls, förutsatt att felet
inte orsakats av Kundens eller tredje mans ändringar, av ändrade tredjepartstjänster eller av
drift i annan miljö än den som handover-dokumentationen beskriver.

6.2 Övrig support, vidareutveckling och drift ingår inte i detta avtal. Vidareutveckling kan
beställas som ny beställning eller via residentläget (`sla-resident.md`).

## 7. Immateriella rättigheter — övergång vid slutbetalning

_DRAFT — EJ GRANSKAD_

7.1 Vid full slutbetalning enligt punkt 3.2 b) övergår samtliga Leverantörens rättigheter till
det **Kundspecifika resultatet** — den källkod, dokumentation och konfiguration som skapats
specifikt för Kundens beställning — till Kunden, i den utsträckning sådana rättigheter kan
överlåtas enligt gällande rätt. Fram till dess har Kunden en icke-exklusiv, återkallelig
licens att granska och testa leveransen.

7.2 Överlåtelsen omfattar inte:

   a) **Leverantörens plattform**: byggsystemet, orkestreringen, AI-agenternas instruktioner,
   Gates, kundportalen och Leverantörens interna verktyg;

   b) **Leverantörens mall och generiska komponenter**: den projektmall, de konventioner och de
   återanvändbara komponenter som Leverantören använder i flera leveranser. För dessa får Kunden
   en evig, icke-exklusiv, royaltyfri licens att använda, ändra och vidaredistribuera dem som del
   av det Kundspecifika resultatet;

   c) programvara från tredje part enligt punkt 9.

7.3 Kunden ger Leverantören rätt att behålla en kopia av Specifikationen, det Kundspecifika
resultatet och bygg- och gate-rapporter till dess att tolv (12) månader förflutit från acceptans
(vilket täcker supporten enligt punkt 6 och kravfristen enligt punkt 10.4), eller längre om en
tvist om beställningen pågår, för bokföring, tvistehantering och för att fullgöra punkt 6.
Därefter raderas kopian; bokföringsunderlag (beställning, pris, betalningar) sparas den tid
bokföringslagen kräver. Leverantören får använda avidentifierade och aggregerade mätdata om
bygget (t.ex. tokenförbrukning, byggtid, antal gate-körningar) för att förbättra Tjänsten.

7.4 Leverantören får inte utan Kundens skriftliga godkännande använda Kunden som referens
eller publicera det Kundspecifika resultatet.

7.5 Leverantören garanterar inte att det Kundspecifika resultatet är unikt. Eftersom koden
genereras av språkmodeller kan likartade lösningar förekomma i andra kunders leveranser utan att
det innebär att någon parts rätt kränks.

## 8. AI-genererad kod — upplysning

_DRAFT — EJ GRANSKAD_

8.1 Kunden är införstådd med och accepterar att det Kundspecifika resultatet **i allt
väsentligt genereras av stora språkmodeller** (för närvarande modeller från Anthropic PBC) och
inte skrivs av människor rad för rad. Leverantörens kvalitetskontroll utgörs av de automatiska
Gates som anges i punkt 5.2 samt de manuella kontroller Leverantören väljer att göra.

8.2 Kunden är införstådd med att:

   a) rättsläget kring upphovsrätt till AI-genererat material är under utveckling och att
   Leverantören därför överlåter sina rättigheter enligt punkt 7 utan garanti om att resultatet
   åtnjuter upphovsrättsligt skydd;

   b) AI-genererad kod kan innehålla fel, säkerhetsbrister eller ineffektiviteter som inte
   fångas av Gates; Kunden ansvarar för sin egen granskning innan produktionssättning av
   säkerhetskritiska eller regulatoriskt känsliga system;

   c) språkmodellen kan reproducera kodmönster som förekommer i dess träningsdata. Leverantören
   vidtar rimliga åtgärder (inklusive licenskontroll av beroenden) men lämnar ingen garanti mot
   att tredje man gör gällande rättigheter; Leverantörens ansvar härför regleras av punkt 10.

8.3 Specifikationen och den kod som genereras skickas till språkmodellsleverantören för
behandling. Leverantören använder API-avtal som enligt leverantörens villkor innebär att
Kundens data inte används för att träna modeller. Se vidare Personuppgiftsbiträdesavtalet.

## 9. Programvara från tredje part — vidareförmedling av licenser

_DRAFT — EJ GRANSKAD_

9.1 Det Kundspecifika resultatet innehåller och är beroende av öppen källkod och annan
programvara från tredje part (t.ex. npm-paket, ramverk, molntjänsters SDK:er). Sådan programvara
tillhandahålls Kunden **uteslutande under respektive upphovsmans licensvillkor**, som
vidareförmedlas till Kunden oförändrade. Leverantören lämnar inga egna utfästelser om sådan
programvara.

9.2 Leverantören eftersträvar att beroenden med licenser som kräver att Kundens egen kod öppnas
(starkt copyleft, t.ex. GPL/AGPL) inte införs utan att det framgår av Specifikationen. Kunden kan
ta fram en förteckning över beroenden och deras licenser ur det levererade kodförrådet
(`package.json` och låsfil); Leverantören lämnar ingen garanti för att förteckningen är
fullständig. _[Öppen punkt: en automatisk licenskontroll i Gates och en licensförteckning i
överlämningsdokumentationen är inte byggda ännu — skärp klausulen när de finns.]_

9.3 Kunden ansvarar för att följa tredjepartslicensernas villkor vid sin fortsatta användning
och distribution, samt för avtal med de tredjepartstjänster (molnleverantör, betaltjänst m.fl.)
som applikationen använder i drift.

## 10. Ansvarsbegränsning — tak motsvarande avtalsvärdet

_DRAFT — EJ GRANSKAD_

10.1 Leverantörens sammanlagda ansvar under detta avtal, oavsett grund, är begränsat till ett
belopp motsvarande **det pris (exklusive mervärdesskatt) som Kunden betalat eller ska betala för
den beställning som skadan hänför sig till** ("Avtalsvärdet").

10.2 Leverantören ansvarar inte för indirekt skada eller följdskada, såsom utebliven vinst,
utebliven besparing, förlust av data (utöver återställande av det Kundspecifika resultatet ur
Leverantörens kopia), produktionsbortfall, skada till följd av tredje mans krav, eller skada som
beror på Kundens användning av leveransen i strid med överlämningsdokumentationen.

10.3 Begränsningarna gäller inte vid uppsåt eller grov vårdslöshet, och inte i den mån tvingande
lag hindrar begränsningen.

10.4 Krav ska framställas skriftligen utan oskäligt dröjsmål och senast sex (6) månader efter
acceptans, annars är rätten till ersättning förlorad.

10.5 Kunden ansvarar för och ska hålla Leverantören skadeslös för krav från tredje man som
grundas på innehållet i Specifikationen eller på material som Kunden tillhandahållit.

## 11. Avbeställning och hävning

_DRAFT — EJ GRANSKAD_

11.1 Kundens avbeställning:

   a) **Innan förskottet betalats** får Kunden avbryta beställningen utan kostnad, själv i
   portalen.

   b) **Efter att förskottet betalats men innan bygget påbörjats** (t.ex. om byggstarten
   misslyckas eller dröjer) får Kunden avbryta genom skriftligt meddelande till Leverantören.
   Förskottet återbetalas då i sin helhet.

   c) **Efter att bygget påbörjats** får Kunden avbryta genom skriftligt meddelande till
   Leverantören. Leverantören stoppar då bygget. Förskottet återbetalas inte, eftersom det
   täcker den beräkningskostnad som förbrukats, och ingen slutbetalning utgår. Delresultat
   levereras inte.

   Bygget anses påbörjat när Leverantören startat byggmiljön för beställningen, vilket visas
   i portalen. Avbeställning enligt b) och c) utförs av Leverantören i portalen; en beställning
   som avbrutits kan inte återupptas.

11.2 Leverantören får avbryta en beställning om bygget inte kan slutföras inom den avsatta
budgeten efter förnyat försök enligt punkt 4.2, om bygget inte kan påbörjas inom tio (10)
arbetsdagar från det att förskottet mottagits, om Specifikationen visar sig strida mot lag eller
tredje mans rätt, eller om Kunden bryter mot avtalet. Avbryter Leverantören utan att Kunden är
i avtalsbrott återbetalas förskottet i sin helhet, vilket är Kundens enda påföljd.

11.3 Vid hävning enligt punkt 5.7 återbetalas förskottet och Kundens licens enligt punkt 7.1
upphör.

## 12. Sekretess

_DRAFT — EJ GRANSKAD_

12.1 Vardera Parten ska hålla den andra Partens konfidentiella information hemlig och endast
använda den för avtalets ändamål. Specifikationen och det Kundspecifika resultatet är Kundens
konfidentiella information; Leverantörens plattform, priser utöver publicerad prislista och
gate-rapporternas interna detaljer är Leverantörens.

12.2 Sekretessen hindrar inte att information lämnas till underbiträden enligt
Personuppgiftsbiträdesavtalet eller de tjänsteleverantörer som krävs för att fullgöra avtalet,
förutsatt att de omfattas av motsvarande sekretess.

12.3 Sekretessen gäller under avtalstiden och tre (3) år därefter.

## 13. Personuppgifter

_DRAFT — EJ GRANSKAD_

13.1 För Leverantörens behandling av personuppgifter om Kundens kontaktpersoner är Leverantören
personuppgiftsansvarig; se integritetspolicyn i `villkor-webb.md`.

13.2 I den mån Specifikationen, testdata eller det Kundspecifika resultatet innehåller
personuppgifter för vilka Kunden är ansvarig, behandlar Leverantören dessa som
personuppgiftsbiträde enligt `pub-avtal.md`. Kunden ska undvika att lägga in personuppgifter i
Specifikationen som inte krävs för bygget.

## 14. Övrigt

_DRAFT — EJ GRANSKAD_

14.1 Ingen av Parterna får överlåta avtalet utan den andres skriftliga samtycke, med undantag
för att Leverantören får överlåta det till ett bolag inom samma koncern eller i samband med
verksamhetsöverlåtelse.

14.2 Part är befriad från påföljd för underlåtenhet att fullgöra förpliktelse som beror på
omständighet utanför Partens kontroll, inklusive avbrott eller väsentliga villkorsändringar hos
språkmodells- eller molnleverantör som Parten inte skäligen kunnat förutse.

14.3 Ändringar av dessa villkor gäller för beställningar som läggs efter ändringen. Den version
som gällde när Specifikationen frystes gäller för beställningen.

14.4 Meddelanden lämnas via portalen eller till de e-postadresser Parterna registrerat.

## 15. Tillämplig lag och tvist

_DRAFT — EJ GRANSKAD_

15.1 Svensk lag ska tillämpas på avtalet, utan tillämpning av dess lagvalsregler.

15.2 Tvist ska i första hand lösas genom förhandling. Löses inte tvisten inom trettio (30) dagar
ska den avgöras av svensk allmän domstol med Stockholms tingsrätt som första instans.

---

## English summary (non-binding)

_DRAFT — NOT REVIEWED. This summary is for orientation only; the Swedish text governs._

- **Parties and scope (§1–2):** a fixed-price software build ordered in the customer portal.
  The scope is exactly the **frozen specification** (goal, users, features, non-goals, acceptance
  criteria, stack constraints). Anything not in it, and everything listed as a non-goal, is out of
  scope; changes after freezing are a new order.
- **Price and payment (§3):** fixed price by size class (S/M/L) ex VAT. **50 % deposit** when the
  spec is frozen (build starts only after receipt), **50 % balance** due at acceptance, payable
  within 10 days of acceptance (the portal offers the payment at delivery; paying early does not
  shorten the review window). Compute cost (LLM tokens, build environment) is included; hosting,
  domains and third-party services are not.
- **Build process (§4):** automated build by LLM agents in an isolated environment with a hard
  token/time budget; if the budget is hit the supplier makes at least one retry at its own cost
  before it may cancel under §11.2; the supplier chooses the technical solution within the spec's
  constraints.
- **Delivery and acceptance (§5):** delivery = source in a private GitHub repo (customer as admin)
  or a zip, handover docs and test report, optionally a temporary preview URL. Delivery only
  happens once all four gates pass: *verify* (lint/test/build), *acceptance-tests* (one generated
  test per acceptance criterion), *review* (automated code review), *acceptance-check* (every
  criterion mapped to evidence). The customer then has a **review window of 10 working days** to
  report deviations from the acceptance criteria; fixes get a 5-working-day re-review. Acceptance
  occurs on written approval, expiry of the window, or productive use — never by payment alone.
  If a deviation cannot be fixed in two further deliveries the customer may accept with a price
  reduction or terminate with refund of the deposit.
- **Support (§6):** 30 days of free fixes for regressions against acceptance criteria; nothing
  else is included.
- **IP (§7):** all supplier rights in the customer-specific result **transfer on final payment**.
  Excluded: the supplier's platform (orchestrator, agents, gates, portal) and the generic template
  and components, which are licensed perpetually and royalty-free instead. The supplier keeps a
  copy for support, claims and disputes until 12 months after acceptance (longer while a dispute
  is open), then deletes it; bookkeeping records are kept as the law requires; anonymised build
  metrics may be used. No uniqueness guarantee.
- **AI-generated code disclosure (§8):** the code is essentially generated by large language
  models (currently Anthropic's), quality-controlled by the gates. The customer accepts that
  copyright protection of AI output is unsettled, that AI code may contain undetected defects or
  vulnerabilities, and that model output may resemble training data; supplier uses API terms that
  exclude training on customer data.
- **Third-party software (§9):** open-source and other third-party components are passed through
  under their own licences with no supplier warranty; the supplier aims to keep strong-copyleft
  dependencies out unless the spec allows them (open point: an automated licence gate and a
  licence list in the handover are not built yet).
- **Liability (§10):** total liability capped at the **contract value** (the order's price ex
  VAT); no indirect or consequential damages; exceptions for intent/gross negligence and mandatory
  law; claims within 6 months of acceptance. The customer indemnifies for claims based on the
  content of the spec.
- **Cancellation (§11):** free in the portal before the deposit; after the deposit but before
  the build has started (e.g. a failed build start) the customer cancels by written notice and
  the deposit is refunded in full; after build start the customer cancels by written notice, the
  build is stopped, the deposit is forfeited and no balance is due. Supplier may cancel (budget
  exhausted after the §4.2 retry, build cannot start within 10 working days of the deposit,
  illegal spec, customer breach) — refund of the deposit is the sole remedy if the customer is not
  in breach.
- **Confidentiality, data protection, misc., law (§12–15):** mutual confidentiality for 3 years;
  the supplier is controller for contact data and processor under the DPA for personal data in
  specs/results; Swedish law, Stockholm District Court after 30 days of negotiation.
