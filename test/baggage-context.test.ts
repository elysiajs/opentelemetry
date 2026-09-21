import { Elysia } from 'elysia'
import { describe, expect, it } from 'bun:test'
import { propagation, trace, type Context } from '@opentelemetry/api'
import {
	NodeTracerProvider,
	type ReadableSpan,
	type Span,
	type SpanProcessor
} from '@opentelemetry/sdk-trace-node'
import { opentelemetry } from '../src'
import { req } from './test-setup'

class BaggageReadingSpanProcessor implements SpanProcessor {
	rootSpanId?: string
	handleParentSpanId?: string
	userId?: string

	onStart(span: Span, parentContext: Context) {
		if (span.name === 'Root') {
			this.rootSpanId = span.spanContext().spanId
			return
		}
		if (span.name !== 'Handle') return

		this.handleParentSpanId = trace
			.getSpan(parentContext)
			?.spanContext().spanId
		this.userId = propagation
			.getBaggage(parentContext)
			?.getAllEntries()
			.find(([key]) => key === 'user_id')?.[1].value
	}

	onEnd(_span: ReadableSpan) {}
	forceFlush() {
		return Promise.resolve()
	}
	shutdown() {
		return Promise.resolve()
	}
}

describe('lifecycle span context', () => {
	it('exposes request baggage to span processors', async () => {
		trace.disable()
		const processor = new BaggageReadingSpanProcessor()
		const provider = new NodeTracerProvider({
			spanProcessors: [processor]
		})
		provider.register()

		try {
			const app = new Elysia()
				.use(opentelemetry({ serviceName: 'baggage-context-test' }))
				.get('/', () => 'ok')

			const response = await app.handle(
				req('/', { headers: { baggage: 'user_id=user-123' } })
			)

			expect(response.status).toBe(200)
			expect(await response.text()).toBe('ok')
			expect(processor.handleParentSpanId).toBe(processor.rootSpanId)
			expect(processor.userId).toBe('user-123')
		} finally {
			await provider.shutdown()
			trace.disable()
		}
	})
})
