import { Elysia } from 'elysia'
import { getCurrentSpan, opentelemetry } from '../src'

new Elysia()
	.use(opentelemetry())
	.get('/', async () => {
		console.log(getCurrentSpan()?.spanContext().traceId)
		await new Promise((res) => setTimeout(res, 1000))

		return 'ok'
	})
	.listen(3000, async (ctx) => {
		const abort = new AbortController()
		fetch(ctx.url, { signal: abort.signal }).catch(() => {})

		fetch(ctx.url).catch(() => {})

		await new Promise((res) => setTimeout(res, 10))
		abort.abort()

		/// future requests without `traceparent` reuse the same trace ID
		fetch(ctx.url).catch(() => {})
	})
