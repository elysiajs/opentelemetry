import { Elysia } from 'elysia'
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import {
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base'
import { opentelemetry } from '../src'

const flushSpans = () => new Promise((r) => setTimeout(r, 150))

describe('Span privacy defaults (URL redaction, opt-in HTTP attributes)', () => {
	let exporter: InMemorySpanExporter
	let provider: NodeTracerProvider

	beforeEach(() => {
		trace.disable()
		exporter = new InMemorySpanExporter()
		provider = new NodeTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)]
		})
		provider.register()
	})

	afterEach(async () => {
		await provider.shutdown()
		trace.disable()
	})

	function rootSpan() {
		return exporter.getFinishedSpans().find(
			(s) => s.attributes['http.request.method'] !== undefined
		)
	}

	it('redacts sensitive query params in url.full and url.query by default', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'url-redact-default' }))
			.get('/r', () => 'ok')

		await app.handle(
			new Request(
				'http://localhost/r?q=safe&token=supersecret&password=x'
			)
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		const full = String(attrs['url.full'])
		const q = String(attrs['url.query'])

		expect(full).toContain('q=safe')
		expect(full).not.toContain('supersecret')
		expect(full).not.toContain('x')
		expect(full).toContain('token=[REDACTED]')
		expect(q).toContain('q=safe')
		expect(q).not.toContain('supersecret')
		expect(q).toContain('token=[REDACTED]')
		expect(q).toContain('password=[REDACTED]')
	})

	it('does not redact query values when spanUrlRedaction is false', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'url-raw',
					spanUrlRedaction: false
				})
			)
			.get('/r', () => 'ok')

		await app.handle(
			new Request('http://localhost/r?token=not-redacted')
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		expect(String(root!.attributes['url.full'])).toContain(
			'token=not-redacted'
		)
		expect(String(root!.attributes['url.query'])).toBe(
			'token=not-redacted'
		)
	})

	it('strips user:pass@ from url.full by default', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'url-strip-creds' }))
			.get('/r', () => 'ok')

		await app.handle(new Request('http://alice:bob@localhost/r'))
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const full = String(root!.attributes['url.full'])
		expect(full).not.toContain('alice')
		expect(full).not.toContain('bob')
		expect(full).toMatch(/localhost\/?/)
	})

	it('redacts custom sensitiveQueryParams alongside builtins', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'url-custom-keys',
					spanUrlRedaction: { sensitiveQueryParams: ['X-My-Secret'] }
				})
			)
			.get('/r', () => 'ok')

		await app.handle(
			new Request(
				'http://localhost/r?q=safe&x-my-secret=hidden&token=also-hidden'
			)
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const q = String(root!.attributes['url.query'])
		expect(q).toContain('q=safe')
		expect(q).toContain('x-my-secret=[REDACTED]')
		expect(q).toContain('token=[REDACTED]')
		expect(q).not.toContain('hidden')
		expect(q).not.toContain('also-hidden')
	})

	it('preserves credentials when stripCredentials is false', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'url-keep-creds',
					spanUrlRedaction: { stripCredentials: false }
				})
			)
			.get('/r', () => 'ok')

		await app.handle(
			new Request('http://alice:bob@localhost/r?token=secret')
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const full = String(root!.attributes['url.full'])
		expect(full).toContain('alice')
		expect(full).toContain('bob')
		expect(full).toContain('token=[REDACTED]')
	})

	it('always records user_agent.original and content-length by default', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'always-on-attrs' }))
			.post('/r', ({ body }) => body)

		await app.handle(
			new Request('http://localhost/r', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': '9',
					'user-agent': 'always-on-ua'
				},
				body: '{"a":123}'
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['user_agent.original']).toBe('always-on-ua')
		expect(attrs['http.request_content_length']).toBe(9)
	})

	it('records Content-Length: 0 correctly', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'content-length-zero' }))
			.post('/r', () => 'ok')

		await app.handle(
			new Request('http://localhost/r', {
				method: 'POST',
				headers: {
					'Content-Length': '0'
				}
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		expect(root!.attributes['http.request_content_length']).toBe(0)
	})

	it('does not record body attributes without recordBody opt-in', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'no-body-default' }))
			.post('/r', ({ body }) => body)

		await app.handle(
			new Request('http://localhost/r', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': '9'
				},
				body: '{"a":123}'
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.body.size']).toBeUndefined()
		expect(attrs['http.request.body']).toBeUndefined()
		expect(attrs['http.response.body.size']).toBeUndefined()
		expect(attrs['http.response.body']).toBeUndefined()
	})

	it('records both request and response body when recordBody is true', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'record-body-true',
					recordBody: true
				})
			)
			.post('/r', ({ body }) => body)

		await app.handle(
			new Request('http://localhost/r', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': '9',
					'user-agent': 'body-test-ua'
				},
				body: '{"a":123}'
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.body.size']).toBe(9)
		expect(attrs['http.request.body']).toBe('{"a":123}')
	})

	it('records only request body when recordBody: { request: true }', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'record-body-request-only',
					recordBody: { request: true }
				})
			)
			.post('/r', ({ body }) => body)

		await app.handle(
			new Request('http://localhost/r', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': '9'
				},
				body: '{"a":123}'
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.body.size']).toBe(9)
		expect(attrs['http.request.body']).toBe('{"a":123}')
		expect(attrs['http.response.body']).toBeUndefined()
		expect(attrs['http.response.body.size']).toBeUndefined()
	})

	it('records only response body when recordBody: { response: true }', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'record-body-response-only',
					recordBody: { response: true }
				})
			)
			.post('/r', ({ body }) => body)

		await app.handle(
			new Request('http://localhost/r', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': '9'
				},
				body: '{"a":123}'
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.body']).toBeUndefined()
		expect(attrs['http.request.body.size']).toBeUndefined()
	})
})
