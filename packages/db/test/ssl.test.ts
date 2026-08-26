import { readFileSync } from 'node:fs'

import { isRdsHost, rdsCaBundlePath, sslMode, sslOptions } from '#/index.ts'

const rds = 'postgres://mf:pw@mf-dev.c9akciq32.eu-north-1.rds.amazonaws.com:5432/mf'
const proxy = 'postgres://mf:pw@mf-proxy.proxy-c9akciq32.eu-north-1.rds.amazonaws.com:5432/mf'
const local = 'postgres://mf:pw@localhost:5432/mf'
const other = 'postgres://mf:pw@db.example.com:5432/mf'

describe('sslMode', () => {
	it('Verifies the certificate and host name for RDS endpoints', () => {
		expect(sslMode(rds, {})).toBe('verify-full')
		expect(sslMode(proxy, {})).toBe('verify-full')
		expect(isRdsHost('mf.c9.eu-north-1.rds.amazonaws.com')).toBe(true)
		expect(isRdsHost('rds.amazonaws.com')).toBe(true)
		expect(isRdsHost('rds.amazonaws.com.evil.example')).toBe(false)
		expect(isRdsHost('notrds.amazonaws.com')).toBe(false)
	})

	it('Encrypts without verification for other remote hosts, plaintext for local ones', () => {
		expect(sslMode(other, {})).toBe('require')
		expect(sslMode(local, {})).toBe(false)
		expect(sslMode('postgres://mf:pw@postgres:5432/mf', {})).toBe(false)
		expect(sslMode('postgres://mf:pw@127.0.0.1:5432/mf', {})).toBe(false)
	})

	it('Falls back to require when the connection string cannot be parsed', () => {
		expect(sslMode('not a url', {})).toBe('require')
	})

	it('Lets DATABASE_SSL override the host-based default in both directions', () => {
		expect(sslMode(rds, { DATABASE_SSL: 'require' })).toBe('require')
		expect(sslMode(rds, { DATABASE_SSL: 'disable' })).toBe(false)
		expect(sslMode(local, { DATABASE_SSL: 'verify-full' })).toBe('verify-full')
		expect(sslMode(other, { DATABASE_SSL: ' verify-full ' })).toBe('verify-full')
		// An unknown value is ignored, not treated as disable
		expect(sslMode(rds, { DATABASE_SSL: 'yes' })).toBe('verify-full')
	})
})

describe('sslOptions', () => {
	it('Trusts only the shipped RDS bundle for verify-full, on this connection', () => {
		const options = sslOptions('verify-full', {})

		expect(options).toMatchObject({ rejectUnauthorized: true })
		const ca = (options as { ca: string }).ca
		expect(ca.match(/-----BEGIN CERTIFICATE-----/g)?.length).toBeGreaterThan(50)
		expect(ca).toBe(readFileSync(rdsCaBundlePath({}), 'utf8'))
		expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined()
	})

	it('Encrypts without verification for require and disables TLS for false', () => {
		expect(sslOptions('require', {})).toEqual({ rejectUnauthorized: false })
		expect(sslOptions(false, {})).toBe(false)
	})

	it('Reads another bundle from DATABASE_SSL_CA', () => {
		expect(rdsCaBundlePath({ DATABASE_SSL_CA: '/somewhere/other.pem' })).toBe('/somewhere/other.pem')
		expect(() => sslOptions('verify-full', { DATABASE_SSL_CA: '/somewhere/nope.pem' })).toThrow(
			/ENOENT/
		)
	})
})
