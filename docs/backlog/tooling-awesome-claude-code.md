# Tooling review — awesome-claude-code

Hasse, 2026-09-01: reviewed [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
(~180 entries across 25 sections) and filtered it against *our* open problems rather than by category.
Status: review, filtered and written down. Nothing here is scheduled; tier 1 is proposed work.

**Caution before adopting anything below.** Everything except the Anthropic-authored entries is
community code that would run with our credentials or, worse, inside a customer's AWS account via
the resident. Descriptions are the list's own claims — none of this code has been read. Vet, pin a
version, and prefer copying an idea over taking a dependency. `SkillSpector` (tier 2) exists exactly
for this and should be pointed at anything we do adopt.

## Tier 1 — ship into the factory soon

Ranked by how directly they touch something already built.

1. **[claude-code-security-review](https://github.com/anthropics/claude-code-security-review)**
   (Anthropic) — GitHub Action reviewing PR diffs for vulnerabilities. Every customer build ends as
   a PR (`packages/harness/src/job/delivery/github.ts`) and we ship exactly two gates today
   (`job/gates/licence.ts`, `job/gates/review.ts`). This is a third, from Anthropic, and it is
   *sellable*: "every build passes an automated security review" is a real line item on a 3–5k
   ticket. **Graduates to:** gate.
2. **[ccusage](https://github.com/ccusage/ccusage)** — reads Claude Code JSONL, reports per-session/
   day/model cost, `--json` for scripting. LEARNINGS.md's one OPEN efficiency item is *"wave-3
   savings are still estimates — the next dogfood run must re-measure against the 2026-08-26
   baseline"*. `job/usage.ts` derives cost from SDK usage; ccusage is an independent second reading
   of the same data, i.e. cheap validation of the number we bill from — before Ögonblick runs.
   **Graduates to:** ops/measurement (a step in the post-run protocol).
3. **[cc-harness](https://github.com/lookfree/cc-harness)** (unrelated to ours, same name) — renders
   the subagent/workflow topology as a graph with per-node latency and token cost, traceable from a
   cost bucket back to the message that produced it. We know per-*job* cost; we don't know which
   task, gate or repair session burned it. At a ~$50 token budget against a 3–5k price that
   attribution *is* the margin dashboard. Read it even if all we do is port the idea into
   `usage.ts` + the admin token view.
4. **[Ctxlint](https://github.com/ctxlint/Ctxlint)** / **[Upkeep](https://github.com/wei18/Upkeep)** /
   **[BlockWatch](https://github.com/mennanov/blockwatch)** — docs/spec drift detection with
   evidence. This is the job done by hand on 2026-08-31, when PLAN.md, the single-use brief and
   strategy-2026-08-31 drifted apart after two sessions crossed PRs and a human had to notice.
   Ctxlint also catches stale refs and dead commands in agent context files — and
   `templates/web/CLAUDE.md` is instantiated into every customer repo, so drift there ships.
   **Graduates to:** CI (`.github/workflows/ci.yml`).

## Tier 2 — the resident agent's security story (M8)

- **[GouvernAI](https://github.com/Myr-Aya/GouvernAI-claude-code-plugin)** — runtime guardrails with
  auto-approve/gate/block logic and a full audit trail: the same shape as docs/RESIDENT.md's
  cap/pause/audit. Read to steal the taxonomy or to confirm ours is complete — a customer's security
  review will ask.
- **[SkillSpector](https://github.com/NVIDIA/SkillSpector)** (NVIDIA) — scanner for malicious or
  vulnerable agent skills. Use before adopting anything from this list, and again if a customer is
  ever allowed to supply skills to their resident.
- **[SkilLock](https://github.com/skills-lock/skil-lock)** — pins skill behaviour and blocks
  unapproved drift in CI. Same ratchet philosophy as LEARNINGS.md's graduation model, aimed at our
  own prompt drift.
- **[Brood Box](https://github.com/stacklok/brood-box)** (hardware-isolated microVMs) and
  **[Code on Incus](https://github.com/mensfeld/code-on-incus)** — sandbox comparables. We isolate
  with Fargate + egress proxy + `exec.ts`'s `sandboxEnv`; the 2026-08-30 git-env-inheritance
  incident was precisely a sandbox-boundary bug. Reading someone else's threat model is the cheapest
  way to find the next one.
- **[Agent Guard](https://github.com/JeongJaeSoon/agent-guard)** — secret-leak guardrails at hook/CI
  level; complements `delivery/appSecrets.ts` + `envManifest.ts` from the opposite direction
  (keeping secrets *in*, not generating them).

## Tier 3 — makes the generated apps visibly better

Where the differentiator actually is: buyers judge an S-class PWA on how it looks and whether it
works on the day.

- **[Dev Browser](https://github.com/SawyerHood/dev-browser)** (Playwright + pixel-level computer-use
  in a QuickJS sandbox) / **[chrome-cdp-ex](https://github.com/EndeavorYen/chrome-cdp-ex)** —
  `delivery/bootArtifact.ts` proves the container boots and `wiredSmoke.ts` proves the wiring;
  neither looks at the rendered page. A visual acceptance gate ("the camera view renders, the
  gallery shows the uploaded photo") is the natural next graduation target, and the single-use brief
  says event-day reliability is the whole product. **Graduates to:** gate.
- **[UI Craft](https://github.com/educlopez/ui-craft)** / **[StyleSeed](https://github.com/bitjaru/styleseed)**
  — design judgment as a loadable skill (scoreable critique, rule systems). Worker prompts encode
  our conventions, not taste. Cheapest available lift to perceived quality. **Graduates to:**
  prompt/template.
- **[showreel](https://github.com/HeyRenan/showreel)** — CSS selectors → annotated screenshots, GIFs
  and before/after composites. Auto-generate delivery screenshots and demo-gallery collateral from
  the finished app; feeds the 500 kr voucher tier and the "byggd av Mjukvaruhuset" distribution loop
  in single-use-software.md.

## Tier 4 — ops and sales leverage

- **[claude-replay](https://github.com/es617/claude-replay)** — turns session transcripts into
  embeddable HTML replays. We already write compact per-worker JSONL (`job/transcript.ts`), used
  only for failure bundles. Same data, customer-facing: a "watch your app get built" page in the
  portal. For a voucher demo the *process* is the product — probably the highest-leverage sales idea
  on the list.
- **[ai-agent-notifier](https://github.com/DevinoSolutions/ai-agent-notifier)** (desktop + ntfy push)
  or **[Claude Threads](https://github.com/anneschuth/claude-threads)** (streams a session into a
  Slack/Mattermost thread with reaction-based approvals) — we babysit 44-minute Fargate jobs and
  10-minute waiters expire silently. Job events are already in Postgres, so a small ntfy publisher
  may beat adopting either wholesale; Claude Threads is the interesting one if we ever want a
  customer-visible progress thread.
- **[llm-router](https://github.com/ypollak2/llm-router)** — routes to the cheapest capable model
  with fallback. We have an editable `model_prices` table and per-job budgets; planner, worker and
  gate sessions are plausibly different price points. An idea, not a dependency — routing away from
  Claude trades output quality for margin, and quality is what we sell.

## Tier 5 — read, don't install

- **[gstack](https://github.com/garrytan/gstack)** (Garry Tan) — "open-source software factory for
  the full product lifecycle". The closest public analogue to what we are building; competitive
  read.
- **Ralph Wiggum family** — the [official Anthropic plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum),
  [ralph-orchestrator](https://github.com/mikeyobrien/ralph-orchestrator),
  [ralph-claude-code](https://github.com/frankbria/ralph-claude-code) (circuit breakers, 75+ tests).
  Autonomous iteration loops with failure handling — compare against `job/budget.ts` and our turn
  caps.
- **[Steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more)**
  (Anthropic) + **[claude-code-infrastructure-showcase](https://github.com/diet103/claude-code-infrastructure-showcase)**
  (hooks that select skills by context). These expose the one real structural gap: we have
  `.claude/agents` and `.claude/rules` but **no skills and no hooks anywhere** — not in the factory,
  not in `templates/web`. LEARNINGS.md says prompts are the weakest graduation target and gates the
  strongest; hooks are the deterministic tier for local sessions, and we don't use them.
- **[Superpowers](https://github.com/obra/superpowers)** — broad SDLC skill bundle. Mine for
  worker-prompt conventions rather than adopt wholesale.

## Skipped (and why)

Status lines, menu-bar session monitors (nearly all macOS-native; we're on WSL2), alternative
clients, Obsidian second-brain plugins, creative-media skills, voice I/O. Two marginal exceptions
worth remembering: [avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) if the sv/en
site copy starts reading as generated, and [SuperSEO Skills](https://github.com/inhouseseo/superseo-skills)
when mjukvaruhuset.se needs inbound.

## Open questions

- Do we adopt the security-review Action as a *delivery* gate (runs on the customer PR, result shown
  to the customer) or a *factory* CI gate (runs on our own PRs)? Both is fine; the customer-facing
  one is the one with pricing value.
- Hooks: worth a spike to move one existing prompt convention into a deterministic hook and see
  whether it holds better — the LEARNINGS.md promotion path with a new rung.
- Anything adopted into `templates/web` ships to every customer forever. Which of tier 3 is
  template-level and which stays factory-level?
