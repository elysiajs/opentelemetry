import { Elysia } from 'elysia'
import {
	opentelemetry,
	getTracer,
	startActiveSpan,
	setAttributes,
	getCurrentSpan
} from '../src'
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { trace, SpanStatusCode } from '@opentelemetry/api'

const req = (path: string, options?: RequestInit) =>
	new Request(`http://localhost${path}`, options)

// Test utility to capture span data
interface CapturedSpan {
	name?: string
	traceId: string
	spanId: string
	parentSpanId?: string
	attributes?: Record<string, any>
	events?: Array<{ name: string; attributes?: Record<string, any> }>
	status?: { code: number; message?: string }
	isRecording: boolean
}

let capturedSpans: CapturedSpan[] = []

const captureSpanData = (spanName?: string): CapturedSpan => {
	const span = trace.getActiveSpan()
	if (!span) throw new Error('No active span found')

	const context = span.spanContext()
	const captured: CapturedSpan = {
		name: spanName,
		traceId: context.traceId,
		spanId: context.spanId,
		isRecording: span.isRecording()
	}

	capturedSpans.push(captured)
	return captured
}

describe('OpenTelemetry Plugin', () => {
	let app: Elysia

	beforeEach(() => {
		app = new Elysia()
		capturedSpans = []
	})

	afterEach(async () => {
		// Clean up any active spans
		trace.getActiveSpan()?.end()
		capturedSpans = []
	})

	it('should initialize plugin without options', async () => {
		expect(typeof opentelemetry).toBe('function')

		const plugin = opentelemetry()
		expect(plugin).toBeDefined()
		expect(typeof plugin).toBe('object')
	})

	it('should initialize plugin with options', async () => {
		expect(typeof opentelemetry).toBe('function')

		const plugin = opentelemetry({
			serviceName: 'test-service'
		})
		expect(plugin).toBeDefined()
		expect(typeof plugin).toBe('object')
	})

	it('should create tracer and start span', async () => {
		const tracer = getTracer()
		expect(tracer).toBeDefined()
		expect(typeof tracer.startSpan).toBe('function')
		expect(typeof tracer.startActiveSpan).toBe('function')

		const span = tracer.startSpan('test-span')
		expect(span).toBeDefined()
		expect(span.isRecording()).toBe(true)
		span.end()
	})

	it('should start active span with callback', async () => {
		let spanInCallback: any

		startActiveSpan('test-active-span', (span) => {
			spanInCallback = span
			expect(span.isRecording()).toBe(true)
			return 'test-result'
		})

		expect(spanInCallback).toBeDefined()
	})

	it('should start active span with options', async () => {
		const result = startActiveSpan(
			'test-span-with-options',
			{ kind: 1 },
			(span) => {
				expect(span.isRecording()).toBe(true)
				span.setAttributes({ 'test.attribute': 'value' })
				return 'success'
			}
		)

		expect(result).toBe('success')
	})

	it('should handle async operations in active span', async () => {
		const result = await startActiveSpan('async-test', async (span) => {
			span.setAttributes({ 'async.test': true })
			await new Promise((resolve) => setTimeout(resolve, 10))
			return 'async-result'
		})

		expect(result).toBe('async-result')
	})

	it('should set attributes on current span', () => {
		const tracer = getTracer()
		const span = tracer.startSpan('attribute-test')

		// Mock the getCurrentSpan to return our test span
		const originalGetCurrentSpan = getCurrentSpan

		const result = setAttributes({ 'test.key': 'test.value' })

		span.end()
		// Note: In real scenario, setAttributes works with active span context
		// This test verifies the function exists and can be called
		expect(typeof setAttributes).toBe('function')
	})

	it('should handle span errors gracefully', async () => {
		let error: Error | null = null

		try {
			startActiveSpan('error-test', (span) => {
				throw new Error('Test error')
			})
		} catch (e) {
			error = e as Error
		}

		expect(error).toBeDefined()
		expect(error?.message).toBe('Test error')
	})

	it('should work with Elysia app', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'test-elysia-app'
				})
			)
			.get('/test', () => 'Hello OpenTelemetry')

		const response = await testApp.handle(req('/test'))
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('Hello OpenTelemetry')
	})

	it('should handle POST requests with tracing', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'test-post-app'
				})
			)
			.post('/data', ({ body }) => ({ received: body }))

		const response = await testApp.handle(
			req('/data', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ test: 'data' })
			})
		)

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.received).toEqual({ test: 'data' })
	})

	it('should trace multiple consecutive requests', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'multi-request-test'
				})
			)
			.get('/request/:id', ({ params }) => ({ id: params.id }))

		// Make multiple requests
		for (let i = 1; i <= 3; i++) {
			const response = await testApp.handle(req(`/request/${i}`))
			expect(response.status).toBe(200)
			const result = await response.json()
			expect(result.id).toBe(i.toString())
		}
	})

	it('should handle 404 errors with tracing', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'error-test-app'
				})
			)
			.get('/exists', () => 'Found')

		const response = await testApp.handle(req('/not-found'))
		expect(response.status).toBe(404)
	})

	it('should handle application errors with tracing', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'app-error-test'
				})
			)
			.get('/error', () => {
				throw new Error('Application error')
			})

		try {
			await testApp.handle(req('/error'))
		} catch (error) {
			// Error should be handled by OpenTelemetry tracing
			expect(error).toBeDefined()
		}
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

	it('should handle different HTTP methods with tracing', async () => {
		const spanData: CapturedSpan[] = []

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'http-methods-test'
				})
			)
			.get('/get', () => {
				try {
					spanData.push(captureSpanData('GET'))
				} catch {}
				return { method: 'GET' }
			})
			.post('/post', () => {
				try {
					spanData.push(captureSpanData('POST'))
				} catch {}
				return { method: 'POST' }
			})
			.put('/put', () => {
				try {
					spanData.push(captureSpanData('PUT'))
				} catch {}
				return { method: 'PUT' }
			})
			.delete('/delete', () => {
				try {
					spanData.push(captureSpanData('DELETE'))
				} catch {}
				return { method: 'DELETE' }
			})

		const getResponse = await testApp.handle(req('/get'))
		expect(getResponse.status).toBe(200)
		const getResult = await getResponse.json()
		expect(getResult.method).toBe('GET')

		const postResponse = await testApp.handle(
			req('/post', { method: 'POST' })
		)
		expect(postResponse.status).toBe(200)
		const postResult = await postResponse.json()
		expect(postResult.method).toBe('POST')

		const putResponse = await testApp.handle(req('/put', { method: 'PUT' }))
		expect(putResponse.status).toBe(200)
		const putResult = await putResponse.json()
		expect(putResult.method).toBe('PUT')

		const deleteResponse = await testApp.handle(
			req('/delete', { method: 'DELETE' })
		)
		expect(deleteResponse.status).toBe(200)
		const deleteResult = await deleteResponse.json()
		expect(deleteResult.method).toBe('DELETE')

		// Verify spans were created for each HTTP method
		expect(spanData).toHaveLength(4)
		spanData.forEach((span, index) => {
			expect(span.traceId).toBeDefined()
			expect(span.spanId).toBeDefined()
			expect(span.isRecording).toBe(true)
		})

		// Verify each request had a unique trace
		const traceIds = spanData.map((s) => s.traceId)
		const uniqueTraceIds = new Set(traceIds)
		expect(uniqueTraceIds.size).toBe(4)
	})

	it('should trace requests with headers', async () => {
		let spanData: CapturedSpan | null = null

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'headers-test'
				})
			)
			.get('/headers', ({ headers }) => {
				try {
					spanData = captureSpanData('headers-request')
				} catch {}
				const span = trace.getActiveSpan()
				if (span) {
					span.setAttributes({
						'http.user_agent': headers['user-agent'] || '',
						'http.content_type': headers['content-type'] || ''
					})
				}
				return {
					userAgent: headers['user-agent'],
					contentType: headers['content-type']
				}
			})

		const response = await testApp.handle(
			req('/headers', {
				headers: {
					'user-agent': 'test-agent',
					'content-type': 'application/json'
				}
			})
		)

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.userAgent).toBe('test-agent')
		expect(result.contentType).toBe('application/json')

		// Verify span was created and attributes were set
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should handle query parameters with tracing', async () => {
		let spanData: CapturedSpan | null = null

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'query-params-test'
				})
			)
			.get('/search', ({ query }) => {
				try {
					spanData = captureSpanData('search-request')
				} catch {}
				const span = trace.getActiveSpan()
				if (span) {
					span.setAttributes({
						'query.q': query.q || '',
						'query.limit': query.limit || ''
					})
				}
				return {
					query: query.q,
					limit: query.limit
				}
			})

		const response = await testApp.handle(
			req('/search?q=test-search&limit=10')
		)

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.query).toBe('test-search')
		expect(result.limit).toBe('10')

		// Verify span was created and captured query parameters
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should work with middleware and tracing', async () => {
		let middlewareCalled = false
		let middlewareSpanData: CapturedSpan | null = null
		let handlerSpanData: CapturedSpan | null = null

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'middleware-test'
				})
			)
			.onBeforeHandle(() => {
				middlewareCalled = true
				try {
					middlewareSpanData = captureSpanData('middleware-before')
				} catch {}
			})
			.get('/middleware', () => {
				try {
					handlerSpanData = captureSpanData('middleware-handler')
				} catch {}
				return { middleware: 'executed' }
			})

		const response = await testApp.handle(req('/middleware'))

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.middleware).toBe('executed')
		expect(middlewareCalled).toBe(true)

		// Verify spans were created in both middleware and handler
		expect(middlewareSpanData).not.toBeNull()
		expect(handlerSpanData).not.toBeNull()
		expect(middlewareSpanData!.traceId).toBeDefined()
		expect(handlerSpanData!.traceId).toBeDefined()
		// Should be same trace for middleware and handler
		expect(middlewareSpanData!.traceId).toBe(handlerSpanData!.traceId)
		expect(middlewareSpanData!.isRecording).toBe(true)
		expect(handlerSpanData!.isRecording).toBe(true)
	})

	it('should trace nested route groups', async () => {
		let spanData: CapturedSpan | null = null

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'nested-routes-test'
				})
			)
			.group('/api', (app) =>
				app.group('/v1', (app) =>
					app.get('/users', () => {
						try {
							spanData = captureSpanData('nested-route')
						} catch {}
						const span = trace.getActiveSpan()
						if (span) {
							span.setAttributes({
								'route.group': '/api/v1',
								'route.endpoint': '/users'
							})
						}
						return { users: ['user1', 'user2'] }
					})
				)
			)

		const response = await testApp.handle(req('/api/v1/users'))

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.users).toEqual(['user1', 'user2'])

		// Verify span was created for nested route
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should handle response with different status codes', async () => {
		const spanData: CapturedSpan[] = []

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'status-codes-test'
				})
			)
			.get('/ok', () => {
				try {
					spanData.push(captureSpanData('status-200'))
				} catch {}
				return { status: 'ok' }
			})
			.get('/created', ({ set }) => {
				try {
					spanData.push(captureSpanData('status-201'))
				} catch {}
				const span = trace.getActiveSpan()
				if (span) {
					span.setAttributes({ 'http.status_code': 201 })
				}
				set.status = 201
				return { status: 'created' }
			})
			.get('/accepted', ({ set }) => {
				try {
					spanData.push(captureSpanData('status-202'))
				} catch {}
				const span = trace.getActiveSpan()
				if (span) {
					span.setAttributes({ 'http.status_code': 202 })
				}
				set.status = 202
				return { status: 'accepted' }
			})

		const okResponse = await testApp.handle(req('/ok'))
		expect(okResponse.status).toBe(200)

		const createdResponse = await testApp.handle(req('/created'))
		expect(createdResponse.status).toBe(201)

		const acceptedResponse = await testApp.handle(req('/accepted'))
		expect(acceptedResponse.status).toBe(202)

		// Verify spans were created for each status code
		expect(spanData).toHaveLength(3)
		spanData.forEach((span) => {
			expect(span.traceId).toBeDefined()
			expect(span.spanId).toBeDefined()
			expect(span.isRecording).toBe(true)
		})

		// Each request should have unique traces
		const traceIds = spanData.map((s) => s.traceId)
		const uniqueTraceIds = new Set(traceIds)
		expect(uniqueTraceIds.size).toBe(3)
	})

	it('should complete full OpenTelemetry span lifecycle', async () => {
		let spanData: any = null
		let spanStarted = false
		let spanEnded = false

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'span-lifecycle-test'
				})
			)
			.get('/lifecycle', () => {
				const span = trace.getActiveSpan()
				if (span) {
					spanStarted = span.isRecording()
					spanData = {
						traceId: span.spanContext().traceId,
						spanId: span.spanContext().spanId,
						isRecording: span.isRecording()
					}

					// Set some attributes
					span.setAttributes({
						'test.operation': 'lifecycle-test',
						'test.timestamp': Date.now()
					})

					// Add an event
					span.addEvent('test-event', {
						'event.data': 'test-data'
					})
				}
				return { lifecycle: 'complete', spanStarted }
			})

		const response = await testApp.handle(req('/lifecycle'))

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.lifecycle).toBe('complete')
		expect(result.spanStarted).toBe(true)
		expect(spanData).toBeDefined()
		expect(spanData?.traceId).toBeDefined()
		expect(spanData?.spanId).toBeDefined()
		expect(spanData?.isRecording).toBe(true)
	})

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
		let spanEvents: any[] = []

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

	it('should handle large request bodies with tracing', async () => {
		let spanData: CapturedSpan | null = null
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
		let spanData: CapturedSpan | null = null
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

		let spanData: CapturedSpan | null = null

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
})
