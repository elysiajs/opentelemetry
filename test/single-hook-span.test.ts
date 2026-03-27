import { Elysia } from 'elysia'
import { opentelemetry } from '../src'
import { describe, expect, it } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { req } from './test-setup'

describe('Single hook span optimization', () => {
	it('should not create a child span when a lifecycle phase has a single hook', async () => {
		const spanNames: string[] = []

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'single-hook-test' }))
			.onBeforeHandle(function singleHook() {
				const span = trace.getActiveSpan()
				if (span) {
					// In the single-hook path, the active span should be
					// the phase group span ("BeforeHandle"), not a child
					// span named after the hook function
					spanNames.push(
						// @ts-ignore — accessing internal name
						span.name ?? ''
					)
				}
			})
			.get('/test', () => 'ok')

		await testApp.handle(req('/test'))
		await new Promise((resolve) => setTimeout(resolve, 100))

		// The active span during a single hook should be "BeforeHandle",
		// not "singleHook" — because no child span was created
		expect(spanNames.length).toBeGreaterThan(0)
		expect(spanNames).not.toContain('singleHook')
	})

	it('should create child spans when a lifecycle phase has multiple hooks', async () => {
		const spanNames: string[] = []

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'multi-hook-test' }))
			.onBeforeHandle(function hookA() {
				const span = trace.getActiveSpan()
				if (span) {
					spanNames.push(
						// @ts-ignore
						span.name ?? ''
					)
				}
			})
			.onBeforeHandle(function hookB() {
				const span = trace.getActiveSpan()
				if (span) {
					spanNames.push(
						// @ts-ignore
						span.name ?? ''
					)
				}
			})
			.get('/test', () => 'ok')

		await testApp.handle(req('/test'))
		await new Promise((resolve) => setTimeout(resolve, 100))

		// With multiple hooks, child spans should be created with
		// the hook function names
		expect(spanNames).toContain('hookA')
		expect(spanNames).toContain('hookB')
	})

	it('should still trace requests correctly with a single hook', async () => {
		let traceId: string | undefined

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'single-hook-trace-test' }))
			.onBeforeHandle(function singleHook() {
				const span = trace.getActiveSpan()
				if (span) traceId = span.spanContext().traceId
			})
			.get('/test', () => 'ok')

		const response = await testApp.handle(req('/test'))
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(response.status).toBe(200)
		expect(traceId).toBeDefined()
	})

	it('should handle errors correctly with a single hook', async () => {
		let errorHandlerCalled = false

		const testApp = new Elysia()
			.use(opentelemetry({ serviceName: 'single-hook-error-test' }))
			.onBeforeHandle(function failingHook() {
				throw new Error('hook failed')
			})
			.onError(({ error }) => {
				errorHandlerCalled = true
				return {
					error:
						error instanceof Error
							? error.message
							: String(error)
				}
			})
			.get('/test', () => 'ok')

		const response = await testApp.handle(req('/test'))
		await new Promise((resolve) => setTimeout(resolve, 100))

		expect(response.status).toBe(500)
		expect(errorHandlerCalled).toBe(true)
	})
})
