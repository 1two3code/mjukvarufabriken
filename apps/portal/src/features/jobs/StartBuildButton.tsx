import styles from './StartBuildButton.module.css'

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { isActiveJobStatus } from '@mf/models'

import { useToast } from '#/hooks/useToast.ts'
import { useGetOrderJobsQuery, useStartJobMutation } from '#/features/jobs/jobsApiSlice.ts'

import { Button } from '#/components/Button.tsx'

import type { SpecDraft } from '@mf/models'

type StartBuildButtonProps = {
	draft: SpecDraft
}

/** Shown on the spec page once the spec is frozen: starts the build or links to the running one */
export function StartBuildButton({ draft }: StartBuildButtonProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const frozen = draft.status === 'frozen'
	const { data: jobs } = useGetOrderJobsQuery(draft.orderId, { skip: !frozen })
	const [start, { isLoading }] = useStartJobMutation()

	if (!frozen) return null

	const latest = jobs?.[0]
	const jobPath = `/orders/${draft.orderId}/job`

	const handleStart = async () => {
		const result = await start(draft.orderId)
		if (!result.error) toast('success', t('job.start.toast.started'))
	}

	if (latest && isActiveJobStatus(latest.status)) {
		return (
			<div className={styles.wrapper}>
				<Link to={jobPath}>{t('job.start.action.viewRunning')}</Link>
			</div>
		)
	}

	return (
		<div className={styles.wrapper}>
			<Button disabled={isLoading} onClick={handleStart}>
				{t(latest ? 'job.start.action.startAgain' : 'job.start.action.start')}
			</Button>
			{latest && (
				<Link to={jobPath}>
					{t('job.start.lastResult', { status: t(`job.status.${latest.status}`) })}
				</Link>
			)}
		</div>
	)
}
