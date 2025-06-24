import { Elysia } from 'elysia'
import { opentelemetry, getTracer, startActiveSpan } from '../src'
import { describe, expect, it } from 'bun:test'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { captureSpanData, req } from './test-setup'

describe('Advanced OpenTelemetry Features', () => {
	it('should propagate trace context across nested spans', async () => {
		let rootTraceId: string | undefined
		let childTraceId: string | undefined
		let parentSpanId: string | undefined
		let childSpanId: string | undefined

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'nested-spans-test' }))
			.get('/nested', () => {
				const rootSpan = trace.getActiveSpan()
				if (rootSpan) {
					rootTraceId = rootSpan.spanContext().traceId
					parentSpanId = rootSpan.spanContext().spanId
				}

				// Create a child span
				return startActiveSpan('child-operation', (childSpan) => {
					childTraceId = childSpan.spanContext().traceId
					childSpanId = childSpan.spanContext().spanId
					childSpan.setAttributes({ 'operation.type': 'child' })
					return { nested: 'success' }
				})
			})

		const response = await testApp.handle(req('/nested'))

		expect(response.status).toBe(200)
		expect(rootTraceId).toBeDefined()
		expect(childTraceId).toBeDefined()
		expect(rootTraceId).toBe(childTraceId!) // Same trace
		expect(parentSpanId).toBeDefined()
		expect(childSpanId).toBeDefined()
		expect(parentSpanId).not.toBe(childSpanId) // Different spans
	})

	it('should handle span status and error recording', async () => {
		let spanStatus: any = null

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'span-status-test' }))
			.get('/error-span', () => {
				const span = trace.getActiveSpan()
				if (span) {
					// Record an error
					const error = new Error('Simulated error')
					span.recordException(error)
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: 'Operation failed'
					})

					// Add a custom event
					span.addEvent('custom.event', {
						'error.type': 'simulation',
						'error.message': error.message
					})

					spanStatus = span.spanContext()
				}
				return { status: 'error-recorded' }
			})

		const response = await testApp.handle(req('/error-span'))

		expect(response.status).toBe(200)
		expect(spanStatus).toBeDefined()
		const result = await response.json()
		expect(result.status).toBe('error-recorded')
	})

	it('should handle concurrent requests with separate traces', async () => {
		const traceIds = new Set<string>()
		const spanIds = new Set<string>()

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'concurrent-test' }))
			.get('/concurrent/:id', ({ params }) => {
				const span = trace.getActiveSpan()
				if (span) {
					const context = span.spanContext()
					traceIds.add(context.traceId)
					spanIds.add(context.spanId)
				}
				return { id: params.id }
			})

		// Make multiple concurrent requests
		const promises = Array.from({ length: 5 }, (_, i) =>
			testApp.handle(req(`/concurrent/${i}`))
		)

		const responses = await Promise.all(promises)

		// All should be successful
		responses.forEach((response, i) => {
			expect(response.status).toBe(200)
		})

		// Each request should have unique trace and span IDs
		expect(traceIds.size).toBe(5)
		expect(spanIds.size).toBe(5)
	})

	it('should handle trace context headers properly', async () => {
		let receivedTraceId: string | undefined
		let receivedSpanId: string | undefined

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'trace-headers-test' }))
			.get('/trace-headers', () => {
				const span = trace.getActiveSpan()
				if (span) {
					const context = span.spanContext()
					receivedTraceId = context.traceId
					receivedSpanId = context.spanId
				}
				return { received: 'trace-context' }
			})

		// Send request with trace headers
		const response = await testApp.handle(
			req('/trace-headers', {
				headers: {
					traceparent:
						'00-12345678901234567890123456789012-1234567890123456-01'
				}
			})
		)

		expect(response.status).toBe(200)
		expect(receivedTraceId).toBeDefined()
		expect(receivedSpanId).toBeDefined()
	})

	it('should work with custom instrumentations', async () => {
		let customSpanCreated = false

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'custom-instrumentation-test' }))
			.get('/custom-instrumentation', () => {
				// Create a custom span within the request
				const tracer = getTracer()
				const customSpan = tracer.startSpan('custom-operation')

				customSpan.setAttributes({
					'custom.attribute': 'test-value',
					'operation.name': 'custom-operation'
				})

				customSpan.addEvent('operation.start')
				customSpanCreated = true
				customSpan.end()

				return { custom: 'instrumentation-complete' }
			})

		const response = await testApp.handle(req('/custom-instrumentation'))

		expect(response.status).toBe(200)
		expect(customSpanCreated).toBe(true)
		const result = await response.json()
		expect(result.custom).toBe('instrumentation-complete')
	})

	it('should support custom span attributes in routes', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'custom-attributes-test'
				})
			)
			.get('/custom', () => {
				// In a real scenario, you would get the current span and set attributes
				const currentSpan = trace.getActiveSpan()
				if (currentSpan) {
					currentSpan.setAttributes({
						'custom.attribute': 'custom-value',
						'request.type': 'api'
					})
				}
				return { message: 'Custom attributes set' }
			})

		const response = await testApp.handle(req('/custom'))
		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.message).toBe('Custom attributes set')
	})

	it('should handle large request bodies with tracing', async () => {
		let spanData: any = null
		const largeData = {
			users: Array.from({ length: 1000 }, (_, i) => ({
				id: i,
				name: `User ${i}`,
				email: `user${i}@example.com`
			}))
		}

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'large-body-test' }))
			.post('/large-data', ({ body }) => {
				try {
					spanData = captureSpanData('large-body-request')
				} catch {}
				const span = trace.getActiveSpan()
				if (span) {
					span.setAttributes({
						'request.body.size': JSON.stringify(body).length,
						'request.users.count': (body as any).users?.length || 0
					})
				}
				return {
					received: Array.isArray((body as any).users),
					count: (body as any).users?.length || 0
				}
			})

		const response = await testApp.handle(
			req('/large-data', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(largeData)
			})
		)

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.received).toBe(true)
		expect(result.count).toBe(1000)

		// Verify span handled large request properly
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should handle WebSocket-style long-running operations', async () => {
		let operationCompleted = false
		let spanData: any = null
		let eventsAdded = 0

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'long-operation-test' }))
			.get('/long-operation', async () => {
				try {
					spanData = captureSpanData('long-operation')
				} catch {}
				const span = trace.getActiveSpan()
				if (span) {
					span.addEvent('operation.start')
					eventsAdded++
					span.setAttributes({ 'operation.type': 'long-running' })
				}

				// Simulate long-running operation
				await new Promise((resolve) => setTimeout(resolve, 100))

				if (span) {
					span.addEvent('operation.complete')
					eventsAdded++
				}

				operationCompleted = true
				return { operation: 'completed' }
			})

		const response = await testApp.handle(req('/long-operation'))

		expect(response.status).toBe(200)
		expect(operationCompleted).toBe(true)
		const result = await response.json()
		expect(result.operation).toBe('completed')

		// Verify span tracked the long operation
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
		expect(eventsAdded).toBe(2) // start and complete events
	})

	it('should handle plugin configuration edge cases', async () => {
		// Test with minimal configuration
		const minimalPlugin = opentelemetry({})
		expect(minimalPlugin).toBeDefined()

		// Test with comprehensive configuration
		const comprehensivePlugin = opentelemetry({
			serviceName: 'comprehensive-test'
		})
		expect(comprehensivePlugin).toBeDefined()

		let spanData: any = null

		const testApp = new Elysia()
			.use(comprehensivePlugin)
			.get('/config-test', () => {
				try {
					spanData = captureSpanData('config-test')
				} catch {}
				return { config: 'tested' }
			})

		const response = await testApp.handle(req('/config-test'))
		expect(response.status).toBe(200)

		// Verify span was created even with edge case configuration
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should handle memory cleanup and span isolation', async () => {
		const spanCounts = new Map<string, number>()

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'memory-test' }))
			.get('/memory/:session', ({ params }) => {
				const span = trace.getActiveSpan()
				if (span) {
					const traceId = span.spanContext().traceId
					spanCounts.set(traceId, (spanCounts.get(traceId) || 0) + 1)
				}
				return { session: params.session }
			})

		// Make requests with different sessions
		for (let i = 0; i < 10; i++) {
			const response = await testApp.handle(req(`/memory/session-${i}`))
			expect(response.status).toBe(200)
		}

		// Each request should have created a unique trace
		expect(spanCounts.size).toBe(10)
		// Each trace should have exactly one span
		spanCounts.forEach((count) => {
			expect(count).toBe(1)
		})
	})

	it('should handle errors in span creation gracefully', async () => {
		let errorHandled = false

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'error-handling-test' }))
			.get('/span-error', () => {
				try {
					// Try to create a span that might fail
					const span = trace.getActiveSpan()
					if (span) {
						// Simulate potential error scenario
						span.setAttributes({ 'test.error': 'handled' })
					}
					errorHandled = true
				} catch (error) {
					errorHandled = false
				}
				return { error: 'handled' }
			})

		const response = await testApp.handle(req('/span-error'))
		expect(response.status).toBe(200)
		expect(errorHandled).toBe(true)
	})
})
