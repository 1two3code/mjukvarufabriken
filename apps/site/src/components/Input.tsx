import styles from './Input.module.css'

type InputProps = {
	className?: string
	disabled?: boolean
	error?: string
	label: string
	name: string
	required?: boolean
	type?: 'text' | 'email'
	value: string
	/** Renders a multi-line field instead of a single-line one */
	multiline?: boolean
	onChange?: (value: string, name: string) => void
}

export function Input({
	className,
	disabled = false,
	error,
	label,
	name,
	required = false,
	type = 'text',
	value,
	multiline = false,
	onChange,
}: InputProps) {
	const classNames = [styles.input]
	if (className) classNames.push(className)
	if (disabled) classNames.push(styles.disabled)
	if (error) classNames.push(styles.error)

	const handleChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
		onChange?.(event.target.value, name)

	return (
		<label className={classNames.join(' ')}>
			<span className={styles.label}>
				{label}
				{required && <span aria-hidden="true"> *</span>}
			</span>
			{multiline ? (
				<textarea
					className={[styles.inputElement, styles.textarea].join(' ')}
					name={name}
					value={value}
					disabled={disabled}
					required={required}
					rows={6}
					onChange={handleChange}
				/>
			) : (
				<input
					className={styles.inputElement}
					type={type}
					name={name}
					value={value}
					disabled={disabled}
					required={required}
					onChange={handleChange}
				/>
			)}
			{error && <span className={styles.errorText}>{error}</span>}
		</label>
	)
}
