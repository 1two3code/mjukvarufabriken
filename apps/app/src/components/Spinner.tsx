import styles from './Spinner.module.css'

type SpinnerProps = {
	center?: boolean
	className?: string
}

export function Spinner({ center, className }: SpinnerProps) {
	const classNames = [styles.spinner]
	if (center) classNames.push(styles.center)
	if (className) classNames.push(className)

	return <div className={classNames.join(' ')} />
}
