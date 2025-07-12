import { Elysia } from 'elysia'
import { treaty } from '@elysiajs/eden'
import { opentelemetry } from '../src'
import { describe, expect, it } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { captureSpanData, req } from './test-setup'

describe('Elysia Integration', () => {
	it('should handle different HTTP methods with tracing', async () => {
		const spanData: any[] = []

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

		const client = treaty(testApp)

		const getResponse = await client.get.get()
		expect(getResponse.status).toBe(200)
		expect(getResponse.data?.method).toBe('GET')

		const postResponse = await client.post.post()
		expect(postResponse.status).toBe(200)
		expect(postResponse.data?.method).toBe('POST')

		const putResponse = await client.put.put()
		expect(putResponse.status).toBe(200)
		expect(putResponse.data?.method).toBe('PUT')

		const deleteResponse = await client.delete.delete()
		expect(deleteResponse.status).toBe(200)
		expect(deleteResponse.data?.method).toBe('DELETE')

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

	it('should handle POST requests with tracing', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'test-post-app'
				})
			)
			.post('/data', ({ body }) => ({ received: body }))

		const client = treaty(testApp)
		const response = await client.data.post({ test: 'data' })

		expect(response.status).toBe(200)
		expect(response.data?.received).toEqual({ test: 'data' })
	})

	it('should trace requests with headers', async () => {
		let spanData: any = null

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

		const client = treaty(testApp)
		const response = await client.headers.get({
			headers: {
				'user-agent': 'test-agent',
				'content-type': 'application/json'
			}
		})

		expect(response.status).toBe(200)
		expect(response.data?.userAgent).toBe('test-agent')
		expect(response.data?.contentType).toBe('application/json')

		// Verify span was created and attributes were set
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should handle query parameters with tracing', async () => {
		let spanData: any = null

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

		const client = treaty(testApp)
		const response = await client.search.get({
			query: {
				q: 'test-search',
				limit: '10'
			}
		})

		expect(response.status).toBe(200)
		expect(response.data?.query).toBe('test-search')
		expect(response.data?.limit).toBe('10')

		// Verify span was created and captured query parameters
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should work with middleware and tracing', async () => {
		let middlewareCalled = false
		let middlewareSpanData: any = null
		let handlerSpanData: any = null

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

		const client = treaty(testApp)
		const response = await client.middleware.get()

		expect(response.status).toBe(200)
		expect(response.data?.middleware).toBe('executed')
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
		let spanData: any = null

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

		const client = treaty(testApp)
		const response = await client.api.v1.users.get()

		expect(response.status).toBe(200)
		expect(response.data?.users).toEqual(['user1', 'user2'])

		// Verify span was created for nested route
		expect(spanData).not.toBeNull()
		expect(spanData!.traceId).toBeDefined()
		expect(spanData!.spanId).toBeDefined()
		expect(spanData!.isRecording).toBe(true)
	})

	it('should handle response with different status codes', async () => {
		const spanData: any[] = []

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

		const client = treaty(testApp)

		const okResponse = await client.ok.get()
		expect(okResponse.status).toBe(200)

		const createdResponse = await client.created.get()
		expect(createdResponse.status).toBe(201)

		const acceptedResponse = await client.accepted.get()
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

	it('should trace multiple consecutive requests', async () => {
		const testApp = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'multi-request-test'
				})
			)
			.get('/request/:id', ({ params }) => ({ id: params.id }))

		const client = treaty(testApp)

		// Make multiple requests
		for (let i = 1; i <= 3; i++) {
			const response = await client.request({ id: i.toString() }).get()
			expect(response.status).toBe(200)
			expect(response.data?.id).toBe(i.toString())
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

		// Eden doesn't have a direct way to call non-existent routes,
		// so we'll use the raw handle method for this test
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

		const client = treaty(testApp)

		try {
			await client.error.get()
		} catch (error) {
			// Error should be handled by OpenTelemetry tracing
			expect(error).toBeDefined()
		}
	})
})
