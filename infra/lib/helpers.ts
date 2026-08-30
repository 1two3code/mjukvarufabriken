import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const createRelativePath = (fileUrl: string, target: string) => {
	const dir = path.dirname(fileURLToPath(fileUrl))
	return path.join(dir, target)
}
