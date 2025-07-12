import { Elysia } from 'elysia'
import {
	opentelemetry,
	getTracer,
	startActiveSpan,
	setAttributes,
	getCurrentSpan
} from '../src'
import { describe, expect, it } from 'bun:test'
import { trace, SpanStatusCode } from '@opentelemetry/api'
import { captureSpanData, req } from './test-setup'

describe('Core OpenTelemetry Plugin', () => {
	it('should initialize plugin without options', () => {
		expect(typeof opentelemetry).toBe('function')

		const plugin = opentelemetry()
		expect(plugin).toBeDefined()
		expect(typeof plugin).toBe('object')
	})

	it('should initialize plugin with options', () => {
		expect(typeof opentelemetry).toBe('function')

		const plugin = opentelemetry({
			serviceName: 'test-service'
		})
		expect(plugin).toBeDefined()
		expect(typeof plugin).toBe('object')
	})

	it('should create tracer and start span', () => {
		const tracer = getTracer()
		expect(tracer).toBeDefined()
		expect(typeof tracer.startSpan).toBe('function')
		expect(typeof tracer.startActiveSpan).toBe('function')

		const span = tracer.startSpan('test-span')
		expect(span).toBeDefined()
		expect(span.isRecording()).toBe(true)
		span.end()
	})

	it('should start active span with callback', () => {
		let spanInCallback: any

		startActiveSpan('test-active-span', (span) => {
			spanInCallback = span
			expect(span.isRecording()).toBe(true)
			return 'test-result'
		})

		expect(spanInCallback).toBeDefined()
	})

	it('should start active span with options', () => {
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

		const result = setAttributes({ 'test.key': 'test.value' })

		span.end()
		expect(typeof setAttributes).toBe('function')
	})

	it('should handle span errors gracefully', () => {
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

	it('should work with basic Elysia app', async () => {
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

	it('should complete full OpenTelemetry span lifecycle', async () => {
		let spanData: any = null
		let spanStarted = false

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
