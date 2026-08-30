import styles from './Button.module.css'

import type { AppColors } from '#/app/types.ts'

type Size = 'tiny' | 'small' | 'default'

type ButtonProps = {
	className?: string
	color?: AppColors
	disabled?: boolean
	size?: Size
	title?: string
	type?: 'button' | 'submit' | 'reset'
	children?: React.ReactNode
	onClick?: (event: React.MouseEvent<HTMLElement>) => void
}

export function Button({
	className,
	color = 'primary',
	disabled = false,
	size = 'default',
	title,
	type = 'button',
	children,
	onClick,
}: ButtonProps) {
	const classNames = [styles.button, styles[size], styles[color]]
	if (className) classNames.push(className)

	return (
		<button
			type={type}
			title={title}
			className={classNames.join(' ')}
			onClick={onClick}
			disabled={disabled}
		>
			{children}
		</button>
	)
}
