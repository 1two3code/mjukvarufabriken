import styles from './PublicLayout.module.css'

import { Outlet } from 'react-router-dom'

export function PublicLayout() {
	return (
		<>
			<div className={styles.headerArea} />
			<div className={styles.container}>
				<div className={styles.content}>
					<Outlet />
				</div>
				<p className={styles.version}>Version {import.meta.env.VITE_APP_VERSION}</p>
			</div>
		</>
	)
}
