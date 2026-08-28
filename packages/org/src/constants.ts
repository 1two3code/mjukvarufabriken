/** Shared constants for the org-lifecycle module — the org, its conventions, and the delivery tag. */

/** The auto-created cross-account role every vended member account carries; what we assume to operate it. */
export const ROLE_NAME = 'OrganizationAccountAccessRole'

/** Root-email domain for vended accounts: `aws+<slug>@<domain>` (needs catch-all inbound — see TODO-EXTERNAL). */
export const EMAIL_DOMAIN = 'mjukvaruhuset.se'

/** Account name convention: `mf-customer-<slug>`. */
export const ACCOUNT_NAME_PREFIX = 'mf-customer-'

/**
 * Every resource the delivery pipeline creates is tagged with this — the single fence used to
 * discover what to suspend/tear down, so a drifted stored inventory can never widen the blast radius.
 */
export const SERVICE_TAG = { key: 'Service', value: 'mf-delivery' } as const

/**
 * Per-customer fence tag. A real (dryRun:false) suspend/teardown MUST be scoped to one customer by
 * ANDing this with {@link SERVICE_TAG}, so a destructive sweep can never span customers or the whole
 * platform. Discovery fails CLOSED: until the delivery path emits `Customer=<slug>` on every resource
 * it creates, a scoped teardown simply finds nothing rather than over-reaching.
 *
 * CROSS-STREAM FOLLOW-UP (do not edit delivery from here): the delivery/harness path must tag every
 * resource it provisions with `Customer=<slug>` in addition to `Service=mf-delivery`.
 */
export const CUSTOMER_TAG_KEY = 'Customer'
