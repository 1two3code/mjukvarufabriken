import styles from './JobList.module.css'

import { useTranslation } from 'react-i18next'

import { JobOutcome } from '#/features/jobs/JobOutcome.tsx'

import { Table } from '#/components/table/Table.tsx'

import type { Job } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

type JobListProps = {
	/** Newest first, as the api lists them */
	jobs: Job[]
	selectedJobId?: string
	onSelect: (job: Job) => void
}

const formatTime = (value: string | undefined, language: string) =>
	value ? new Date(value).toLocaleString(language) : '–'

/**
 * Every job of the order — the build, its automatic retry, the redeliveries — with what each one
 * amounted to. Selecting a row shows that job's log, delivery steps, gates and deliverables.
 */
export function JobList({ jobs, selectedJobId, onSelect }: JobListProps) {
	const { t, i18n } = useTranslation()

	const columns: TableColumn<Job>[] = [
		{
			header: t('job.list.mode'),
			field: 'mode',
			cell: row => t(`job.mode.${row.mode ?? 'build'}`),
		},
		{
			header: t('job.list.status'),
			field: 'status',
			cell: row => t(`job.status.${row.status}`),
		},
		{
			header: t('job.list.started'),
			field: 'startedAt',
			cell: row => formatTime(row.startedAt ?? row.createdAt, i18n.language),
		},
		{
			header: t('job.list.finished'),
			field: 'finishedAt',
			cell: row => formatTime(row.finishedAt, i18n.language),
		},
		{
			header: t('job.list.outcome'),
			field: 'outcome',
			maxWidth: '28rem',
			cell: row => <JobOutcome job={row} withDeliverables />,
		},
	]

	return (
		<section className={styles.list}>
			<h2 className={styles.title}>{t('job.list.title')}</h2>
			<Table columns={columns} rows={jobs} selectedRowId={selectedJobId} onRowClick={onSelect} />
		</section>
	)
}
