import styles from './Button.module.css'

import { Link } from 'react-router-dom'

import type { AppColors } from '#/app/types.ts'

type Size = 'tiny' | 'small' | 'default'

type ButtonLinkProps = {
	className?: string
	color?: AppColors
	size?: Size
	/** External URL (rendered as a plain anchor) — mutually exclusive with `to` */
	href?: string
	/** In-app route (rendered as a router link) */
	to?: string
	children?: React.ReactNode
}

/** A link styled as a button — shares the Button stylesheet so sizes and colors match */
export function ButtonLink({
	className,
	color = 'primary',
	size = 'default',
	href,
	to,
	children,
}: ButtonLinkProps) {
	const classNames = [styles.button, styles[size], styles[color]]
	if (className) classNames.push(className)

	if (to) {
		return (
			<Link to={to} className={classNames.join(' ')}>
				{children}
			</Link>
		)
	}
	return (
		<a href={href} className={classNames.join(' ')}>
			{children}
		</a>
	)
}
