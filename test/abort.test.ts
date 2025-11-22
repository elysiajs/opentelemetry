import { Elysia } from 'elysia'
import { opentelemetry, getCurrentSpan } from '../src'
import { describe, expect, it } from 'bun:test'

// Test constants
const SLOW_OPERATION_TIMEOUT = 1000
const ABORT_DELAY = 10
const CLEANUP_DELAY = 100

describe('Abort Request Handling', () => {
	it('should create unique trace IDs for requests after an aborted request', async () => {
		const traceIds: string[] = []

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'abort-test' }))
			.get('/', async () => {
				const span = getCurrentSpan()
				if (span) {
					traceIds.push(span.spanContext().traceId)
				}
				await new Promise((res) => setTimeout(res, SLOW_OPERATION_TIMEOUT))
				return { success: true }
			})

		// Create an aborted request
		const abortController = new AbortController()
		const abortPromise = testApp
			.handle(
				new Request('http://localhost/', {
					signal: abortController.signal
				})
			)
			.catch(() => {})

		// Abort after a short delay
		await new Promise((res) => setTimeout(res, ABORT_DELAY))
		abortController.abort()

		// Wait a bit for abort to process
		await abortPromise
		await new Promise((res) => setTimeout(res, CLEANUP_DELAY))

		// Make subsequent requests without traceparent header
		const response1 = await testApp.handle(new Request('http://localhost/'))
		const response2 = await testApp.handle(new Request('http://localhost/'))

		// Verify both requests completed
		expect(response1.status).toBe(200)
		expect(response2.status).toBe(200)

		// Verify we captured trace IDs (at least for the successful requests)
		expect(traceIds.length).toBeGreaterThanOrEqual(2)

		// Get the last two trace IDs (from the successful requests)
		const lastTwoTraceIds = traceIds.slice(-2)
		
		// Each request should have a unique trace ID
		expect(lastTwoTraceIds[0]).toBeDefined()
		expect(lastTwoTraceIds[1]).toBeDefined()
		expect(lastTwoTraceIds[0]).not.toBe(lastTwoTraceIds[1])
	})

	it('should not leak context from aborted request to subsequent requests', async () => {
		const traceIds: string[] = []
		let abortedTraceId: string | undefined

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'abort-context-leak-test' }))
			.get('/slow', async () => {
				const span = getCurrentSpan()
				if (span) {
					const traceId = span.spanContext().traceId
					traceIds.push(traceId)
					abortedTraceId = traceId
				}
				await new Promise((res) => setTimeout(res, SLOW_OPERATION_TIMEOUT))
				return { success: true }
			})
			.get('/fast', () => {
				const span = getCurrentSpan()
				if (span) {
					traceIds.push(span.spanContext().traceId)
				}
				return { success: true }
			})

		// Create an aborted request to /slow
		const abortController = new AbortController()
		const abortPromise = testApp
			.handle(
				new Request('http://localhost/slow', {
					signal: abortController.signal
				})
			)
			.catch(() => {})

		// Abort after a short delay
		await new Promise((res) => setTimeout(res, ABORT_DELAY))
		abortController.abort()

		// Wait for abort to process
		await abortPromise
		await new Promise((res) => setTimeout(res, CLEANUP_DELAY))

		// Make requests to /fast without traceparent header
		const response1 = await testApp.handle(
			new Request('http://localhost/fast')
		)
		const response2 = await testApp.handle(
			new Request('http://localhost/fast')
		)

		// Verify both requests completed
		expect(response1.status).toBe(200)
		expect(response2.status).toBe(200)

		// Get the trace IDs from the successful requests
		const successfulTraceIds = traceIds.slice(1) // Skip the aborted one

		// Verify each successful request has a unique trace ID
		expect(successfulTraceIds.length).toBe(2)
		expect(successfulTraceIds[0]).toBeDefined()
		expect(successfulTraceIds[1]).toBeDefined()
		expect(successfulTraceIds[0]).not.toBe(successfulTraceIds[1])

		// Verify none of the successful requests reused the aborted trace ID
		if (abortedTraceId) {
			expect(successfulTraceIds[0]).not.toBe(abortedTraceId)
			expect(successfulTraceIds[1]).not.toBe(abortedTraceId)
		}
	})
})
