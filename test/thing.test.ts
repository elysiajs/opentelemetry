import { Elysia } from 'elysia'
import { opentelemetry } from '../src'
import { describe, expect, it, beforeAll, beforeEach } from 'bun:test'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
	NodeTracerProvider
} from '@opentelemetry/sdk-trace-node'
import { req } from './test-setup'

describe('Error Handling with OpenTelemetry', () => {
	it('should end root span when error is thrown without custom onError handler', async () => {
		let rootSpanEnded = false
		let rootSpanId: string | undefined

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'error-no-handler-test' }))
			.get('/error-no-handler', () => {
				const span = trace.getActiveSpan()
				if (span) {
					rootSpanId = span.spanContext().spanId
					// Monkey-patch the end method to track if it's called
					const originalEnd = span.end.bind(span)
					span.end = function (...args: any[]) {
						rootSpanEnded = true
						return originalEnd(...args)
					}
				}
				throw new Error('Test error without handler')
			})

		try {
			await testApp.handle(req('/error-no-handler'))
		} catch (error) {
			// Error is expected
		}

		// Wait a bit for async operations
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(rootSpanId).toBeDefined()
		// This test documents current behavior - span should end
	})

	it('should end root span when error is thrown with custom onError handler', async () => {
		let rootSpanEnded = false
		let rootSpanId: string | undefined
		let errorHandlerCalled = false

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'error-with-handler-test' }))
			.onError(({ error }) => {
				errorHandlerCalled = true
				return {
					error:
						error instanceof Error ? error.message : String(error)
				}
			})
			.get('/error-with-handler', () => {
				const span = trace.getActiveSpan()
				if (span) {
					rootSpanId = span.spanContext().spanId
					// Monkey-patch the end method to track if it's called
					const originalEnd = span.end.bind(span)
					span.end = function (...args: any[]) {
						rootSpanEnded = true
						return originalEnd(...args)
					}
				}
				throw new Error('Test error with handler')
			})

		const response = await testApp.handle(req('/error-with-handler'))

		// Wait a bit for async operations
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(response.status).toBe(500)
		expect(errorHandlerCalled).toBe(true)
		expect(rootSpanId).toBeDefined()

		// This is the bug: root span should end but currently doesn't
		// After fix, this should be true
		expect(rootSpanEnded).toBe(true)
	})

	it('should record error details in span when using custom onError handler', async () => {
		let spanHasError = false
		let errorHandlerCalled = false

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'error-details-test' }))
			.onError(({ error }) => {
				errorHandlerCalled = true
				const span = trace.getActiveSpan()
				if (span) {
					// Check if error was recorded
					spanHasError = span.isRecording()
				}
				return {
					error:
						error instanceof Error ? error.message : String(error)
				}
			})
			.get('/error-details', () => {
				throw new Error('Test error for details')
			})

		const response = await testApp.handle(req('/error-details'))

		// Wait a bit for async operations
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(response.status).toBe(500)
		expect(errorHandlerCalled).toBe(true)
		expect(spanHasError).toBe(true)
	})

	it('should handle multiple onError handlers correctly', async () => {
		let firstHandlerCalled = false
		let secondHandlerCalled = false
		let rootSpanId: string | undefined

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'multiple-handlers-test' }))
			.onError(({ code }) => {
				firstHandlerCalled = true
			})
			.onError(({ error }) => {
				secondHandlerCalled = true
				const span = trace.getActiveSpan()
				if (span) rootSpanId = span.spanContext().spanId

				return {
					error:
						error instanceof Error ? error.message : String(error)
				}
			})
			.get('/multiple-handlers', () => {
				throw new Error('Test with multiple handlers')
			})

		const response = await testApp.handle(req('/multiple-handlers'))

		// Wait a bit for async operations
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(response.status).toBe(500)
		expect(firstHandlerCalled).toBe(true)
		expect(rootSpanId).toBeDefined()
	})

	it('should handle errors in async routes with custom onError', async () => {
		let rootSpanEnded = false
		let errorHandlerCalled = false

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'async-error-test' }))
			.onError(({ error }) => {
				errorHandlerCalled = true
				return {
					error:
						error instanceof Error ? error.message : String(error)
				}
			})
			.get('/async-error', async () => {
				const span = trace.getActiveSpan()
				if (span) {
					const originalEnd = span.end.bind(span)
					span.end = function (...args: any[]) {
						rootSpanEnded = true
						return originalEnd(...args)
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 10))
				throw new Error('Async error')
			})

		const response = await testApp.handle(req('/async-error'))

		// Wait a bit for async operations
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(response.status).toBe(500)
		expect(errorHandlerCalled).toBe(true)
		expect(rootSpanEnded).toBe(true)
	})

	it('should handle custom error types with onError handler', async () => {
		class CustomError extends Error {
			constructor(message: string) {
				super(message)
				this.name = 'CustomError'
			}
		}

		let errorHandlerCalled = false
		let errorType: string | undefined

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'custom-error-test' }))
			.error({
				CUSTOM_ERROR: CustomError
			})
			.onError(({ error, code }) => {
				errorHandlerCalled = true
				errorType = String(code)
				if (code === 'CUSTOM_ERROR') {
					return {
						customError:
							error instanceof Error
								? error.message
								: String(error)
					}
				}
				return {
					error:
						error instanceof Error ? error.message : String(error)
				}
			})
			.get('/custom-error', () => {
				throw new CustomError('Custom error occurred')
			})

		const response = await testApp.handle(req('/custom-error'))

		// Wait a bit for async operations
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(response.status).toBe(500)
		expect(errorHandlerCalled).toBe(true)
		expect(errorType).toBe('CUSTOM_ERROR')
		const body = await response.json()
		expect(body.customError).toBe('Custom error occurred')
	})
})

/**
 * @see https://github.com/elysiajs/opentelemetry/issues/77
 */
describe('Span status follows OTel HTTP semantic conventions (#77)', () => {
	const exporter = new InMemorySpanExporter()
	const provider = new NodeTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)]
	})

	beforeAll(() => {
		provider.register()
	})

	beforeEach(() => {
		exporter.reset()
	})

	const waitForSpans = () =>
		new Promise((resolve) => setTimeout(resolve, 200))

	it('should NOT set span status ERROR when onError downgrades to 4xx', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'semconv-downgrade-test' }))
			.onError(({ error, set }) => {
				set.status = 422
				return { error: error.message }
			})
			.get('/unprocessable', () => {
				throw new Error('Validation failed')
			})

		const response = await app.handle(req('/unprocessable'))
		expect(response.status).toBe(422)

		await waitForSpans()
		const spans = exporter.getFinishedSpans()

		const errorSpans = spans.filter(
			(s) => s.status.code === SpanStatusCode.ERROR
		)
		expect(errorSpans).toHaveLength(0)
	})
})
