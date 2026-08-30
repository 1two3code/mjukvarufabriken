import { z } from 'zod'
import { role } from '@mf/access-control'

export const RoleSchema = z.enum(role)
