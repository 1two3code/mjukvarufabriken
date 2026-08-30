// The error handling plugin makes no external calls itself (it depends on `#internal/sentry`,
// which is mocked separately), so tests run the real implementation. The mock file exists so the
// plugin participates in the `__mocks__` auto-mocking convention.
export default await vi.importActual('../errorHandling.ts')
