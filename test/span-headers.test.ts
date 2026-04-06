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

describe('Span header attributes (opt-in allow-list)', () => {
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

	it('does not record request headers on the span by default', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'no-headers-default' }))
			.get('/r', () => 'ok')

		await app.handle(
			new Request('http://localhost/r', {
				headers: {
					authorization: 'secret',
					'x-scanner-probe': 'junk',
					cookie: 'session=secret',
					'user-agent': 'default-test-ua'
				}
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.header.authorization']).toBeUndefined()
		expect(attrs['http.request.header.x-scanner-probe']).toBeUndefined()
		expect(attrs['http.request.header.cookie']).toBeUndefined()
		expect(attrs['http.request.header.user-agent']).toBeUndefined()
		expect(attrs['user_agent.original']).toBe('default-test-ua')
	})

	it('records only allow-listed request headers', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'headers-allowlist',
					spanRequestHeaders: ['X-Allowed', 'content-type']
				})
			)
			.get('/r', () => 'ok')

		await app.handle(
			new Request('http://localhost/r', {
				headers: {
					'x-allowed': 'yes',
					'content-type': 'text/plain',
					authorization: 'bearer nope',
					'x-other': 'omit'
				}
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.header.x-allowed']).toBe('yes')
		expect(attrs['http.request.header.content-type']).toBe('text/plain')
		expect(attrs['http.request.header.authorization']).toBeUndefined()
		expect(attrs['http.request.header.x-other']).toBeUndefined()
	})

	it('records http.request.header.user-agent when allow-listed', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'user-agent-allowlist',
					spanRequestHeaders: ['user-agent']
				})
			)
			.get('/r', () => 'ok')

		await app.handle(
			new Request('http://localhost/r', {
				headers: { 'user-agent': 'regression-test-ua' }
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.header.user-agent']).toBe(
			'regression-test-ua'
		)
		expect(attrs['user_agent.original']).toBe('regression-test-ua')
	})

	it('records raw Cookie header when allow-listed (http.request.cookie only with context.cookie)', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'cookie-allowlist',
					spanRequestHeaders: ['cookie']
				})
			)
			.get('/r', () => 'ok')

		await app.handle(
			new Request('http://localhost/r', {
				headers: { cookie: 'a=1; b=2' }
			})
		)
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.header.cookie']).toBe('a=1; b=2')
		expect(attrs['http.request.cookie']).toBeUndefined()
	})

	it('does not record cookie attributes when allow-listed but no Cookie header and no context.cookie', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'cookie-absent',
					spanRequestHeaders: ['cookie']
				})
			)
			.get('/r', () => 'ok')

		await app.handle(new Request('http://localhost/r'))
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.request.header.cookie']).toBeUndefined()
		expect(attrs['http.request.cookie']).toBeUndefined()
	})

	it('records only allow-listed response headers', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'resp-headers-allowlist',
					spanResponseHeaders: ['x-out']
				})
			)
			.onRequest(({ set }) => {
				set.headers['X-Out'] = 'seen'
				set.headers['X-Hidden'] = 'secret'
			})
			.get('/r', () => 'ok')

		await app.handle(new Request('http://localhost/r'))
		await flushSpans()

		const root = rootSpan()
		expect(root).toBeDefined()
		const attrs = root!.attributes
		expect(attrs['http.response.header.x-out']).toBe('seen')
		expect(attrs['http.response.header.x-hidden']).toBeUndefined()
	})
})
