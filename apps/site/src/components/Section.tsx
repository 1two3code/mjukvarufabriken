import styles from './Section.module.css'

type SectionProps = {
	className?: string
	/** Small uppercase label above the title */
	eyebrow?: string
	title?: string
	lead?: string
	/** Card-like surface instead of a plain block */
	variant?: 'plain' | 'card'
	children?: React.ReactNode
}

export function Section({
	className,
	eyebrow,
	title,
	lead,
	variant = 'plain',
	children,
}: SectionProps) {
	const classNames = [styles.section, styles[variant]]
	if (className) classNames.push(className)

	return (
		<section className={classNames.join(' ')}>
			{(eyebrow || title || lead) && (
				<header className={styles.header}>
					{eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
					{title && <h2>{title}</h2>}
					{lead && <p className={styles.lead}>{lead}</p>}
				</header>
			)}
			{children}
		</section>
	)
}

type GridProps = {
	className?: string
	columns?: 2 | 3
	children?: React.ReactNode
}

/** Responsive equal-width columns that collapse on small screens */
export function Grid({ className, columns = 3, children }: GridProps) {
	const classNames = [styles.grid, styles[`columns${columns}`]]
	if (className) classNames.push(className)
	return <div className={classNames.join(' ')}>{children}</div>
}

type CardProps = {
	className?: string
	title: string
	/** Optional marker in front of the title (a step number, a size letter) */
	marker?: string
	highlight?: boolean
	children?: React.ReactNode
}

export function Card({ className, title, marker, highlight = false, children }: CardProps) {
	const classNames = [styles.item]
	if (highlight) classNames.push(styles.highlight)
	if (className) classNames.push(className)

	return (
		<article className={classNames.join(' ')}>
			{marker && <span className={styles.marker}>{marker}</span>}
			<h3>{title}</h3>
			{children}
		</article>
	)
}
