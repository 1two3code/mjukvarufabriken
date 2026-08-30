// The error handling plugin has no external dependencies, so tests run the real implementation.
// The mock file exists so the plugin participates in the `__mocks__` auto-mocking convention.
export default await vi.importActual('../errorHandling.ts')
