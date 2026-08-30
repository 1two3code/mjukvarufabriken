import styles from './HeaderLink.module.css'

import { NavLink } from 'react-router-dom'

type HeaderLinkProps = {
	label: string
	to: string
	end?: boolean
}

export function HeaderLink({ label, to, end = false }: HeaderLinkProps) {
	return (
		<NavLink
			to={to}
			end={end}
			className={({ isActive }) => [styles.link, isActive ? styles.active : ''].join(' ')}
		>
			{label}
		</NavLink>
	)
}
