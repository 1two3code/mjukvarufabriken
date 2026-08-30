import styles from './Input.module.css'

type InputProps = {
	className?: string
	disabled?: boolean
	error?: string
	label: string
	name?: string
	type?: 'text' | 'password'
	value: string
	onChange?: (value: string, name: string) => void
}

export function Input({
	className,
	disabled = false,
	error,
	label,
	name,
	type = 'text',
	value,
	onChange,
}: InputProps) {
	const fieldName = name ?? label.toLowerCase().replace(' ', '-')

	const classNames = [styles.input]
	if (className) classNames.push(className)
	if (disabled) classNames.push(styles.disabled)
	if (error) classNames.push(styles.error)

	return (
		<label className={classNames.join(' ')}>
			<span className={styles.label}>{label}</span>
			<input
				className={styles.inputElement}
				type={type}
				name={fieldName}
				value={value}
				disabled={disabled}
				onChange={event => onChange?.(event.target.value, fieldName)}
			/>
			{error && <span className={styles.errorText}>{error}</span>}
		</label>
	)
}
