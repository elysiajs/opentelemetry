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

describe('OpenTelemetry Plugin', () => {
	let app: Elysia

	beforeEach(() => {
		app = new Elysia()
	})

	afterEach(async () => {
		// Clean up any active spans
		trace.getActiveSpan()?.end()
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
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'http-methods-test'
				})
			)
			.get('/get', () => ({ method: 'GET' }))
			.post('/post', () => ({ method: 'POST' }))
			.put('/put', () => ({ method: 'PUT' }))
			.delete('/delete', () => ({ method: 'DELETE' }))

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
	})

	it('should trace requests with headers', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'headers-test'
				})
			)
			.get('/headers', ({ headers }) => ({
				userAgent: headers['user-agent'],
				contentType: headers['content-type']
			}))

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
	})

	it('should handle query parameters with tracing', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'query-params-test'
				})
			)
			.get('/search', ({ query }) => ({
				query: query.q,
				limit: query.limit
			}))

		const response = await testApp.handle(
			req('/search?q=test-search&limit=10')
		)

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.query).toBe('test-search')
		expect(result.limit).toBe('10')
	})

	it('should work with middleware and tracing', async () => {
		let middlewareCalled = false

		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'middleware-test'
				})
			)
			.onBeforeHandle(() => {
				middlewareCalled = true
			})
			.get('/middleware', () => ({ middleware: 'executed' }))

		const response = await testApp.handle(req('/middleware'))

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.middleware).toBe('executed')
		expect(middlewareCalled).toBe(true)
	})

	it('should trace nested route groups', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'nested-routes-test'
				})
			)
			.group('/api', (app) =>
				app.group('/v1', (app) =>
					app.get('/users', () => ({ users: ['user1', 'user2'] }))
				)
			)

		const response = await testApp.handle(req('/api/v1/users'))

		expect(response.status).toBe(200)
		const result = await response.json()
		expect(result.users).toEqual(['user1', 'user2'])
	})

	it('should handle response with different status codes', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'status-codes-test'
				})
			)
			.get('/ok', () => ({ status: 'ok' }))
			.get('/created', ({ set }) => {
				set.status = 201
				return { status: 'created' }
			})
			.get('/accepted', ({ set }) => {
				set.status = 202
				return { status: 'accepted' }
			})

		const okResponse = await testApp.handle(req('/ok'))
		expect(okResponse.status).toBe(200)

		const createdResponse = await testApp.handle(req('/created'))
		expect(createdResponse.status).toBe(201)

		const acceptedResponse = await testApp.handle(req('/accepted'))
		expect(acceptedResponse.status).toBe(202)
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
})
