/**
 * @mf/org — the account-lifecycle module.
 *
 * Provisioning (docs/backlog/org-accounts.md): vend a per-customer AWS account, move it into the
 * Customers OU, assume its cross-account role, and graduate it back out.
 *
 * Deprovisioning (docs/backlog/teardown-deprovisioning.md): discover a customer's resources by the
 * `Service=mf-delivery` tag and suspend / resume / teardown them — dry-run by default, audited,
 * idempotent, tolerant of already-gone / half-deleted resources.
 *
 * Every AWS client is injected; nothing here news up a real client, so tests never touch AWS.
 */

export * from '#/constants.ts'
export * from '#/schemas.ts'
export * from '#/signal.ts'
export * from '#/types.ts'

export * from '#/vend.ts'
export * from '#/assumeRole.ts'

export * from '#/audit.ts'
export * from '#/discover.ts'
export * from '#/actuator.ts'
export * from '#/deprovision.ts'
