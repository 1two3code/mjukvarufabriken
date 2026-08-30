#!/usr/bin/env node
// Prints a fresh Ed25519 private key as a single-line JSON JWK — the value of the
// `mf/<env>/auth-jwt-private-key` secret (or AUTH_JWT_PRIVATE_KEY locally). Never commit it.
//
//   node scripts/gen-auth-key.mjs
//   aws secretsmanager put-secret-value --secret-id mf/dev/auth-jwt-private-key \
//     --secret-string "$(node scripts/gen-auth-key.mjs)"

import { generateKeyPairSync } from 'node:crypto'

const { privateKey } = generateKeyPairSync('ed25519')
process.stdout.write(JSON.stringify(privateKey.export({ format: 'jwk' })) + '\n')
