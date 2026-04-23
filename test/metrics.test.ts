import { Elysia } from 'elysia'
import { opentelemetry } from '../src'
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { metrics, trace } from '@opentelemetry/api'
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { req } from './test-setup'

class TestMetricReader extends MetricReader {
	protected async onShutdown() {}
	protected async onForceFlush() {}
}

const setupMetrics = () => {
	const reader = new TestMetricReader()
	const meterProvider = new MeterProvider({ readers: [reader] })
	metrics.setGlobalMeterProvider(meterProvider)
	return { reader, meterProvider }
}

const getHistogramDataPoints = async (reader: TestMetricReader) => {
	const { resourceMetrics } = await reader.collect()
	for (const scopeMetrics of resourceMetrics.scopeMetrics) {
		for (const metric of scopeMetrics.metrics) {
			if (metric.descriptor.name === 'http.server.request.duration') {
				return metric.dataPoints
			}
		}
	}
	return []
}

const settle = () => new Promise((r) => setTimeout(r, 100))

describe('HTTP Server Request Duration Metric', () => {
	let reader: TestMetricReader
	let meterProvider: MeterProvider

	beforeEach(() => {
		trace.disable()
		metrics.disable()
		;({ reader, meterProvider } = setupMetrics())
	})

	afterEach(async () => {
		await meterProvider.shutdown()
		trace.disable()
		metrics.disable()
	})

	it('should record duration with correct attributes for a successful request', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'test-metrics' }))
			.get('/users', async () => {
				await new Promise((resolve) => setTimeout(resolve, 50))
				return 'ok'
			})

		await app.handle(req('/users'))
		await settle()

		const dataPoints = await getHistogramDataPoints(reader)
		expect(dataPoints.length).toBe(1)

		const dp = dataPoints[0]
		expect(dp.attributes['http.request.method']).toBe('GET')
		expect(dp.attributes['http.response.status_code']).toBe(200)
		expect(dp.attributes['http.route']).toBe('/users')
		expect(dp.attributes['url.scheme']).toBe('http')
		expect(dp.attributes['error.type']).toBeUndefined()

		const durationS = dp.value.sum as number
		expect(durationS).toBeGreaterThanOrEqual(0.04)
		expect(durationS).toBeLessThan(1)
	})

	it('should record duration with error.type for 500 errors', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'test-metrics' }))
			.get('/fail', () => {
				throw new Error('internal failure')
			})

		await app.handle(req('/fail'))
		await settle()

		const dataPoints = await getHistogramDataPoints(reader)
		expect(dataPoints.length).toBe(1)

		const dp = dataPoints[0]
		expect(dp.attributes['http.request.method']).toBe('GET')
		expect(dp.attributes['http.route']).toBe('/fail')
		expect(dp.attributes['error.type']).toBe('500')
		expect(dp.attributes['http.response.status_code']).toBeGreaterThanOrEqual(500)
	})

	it('should record duration for aborted requests', async () => {
		const controller = new AbortController()

		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'test-metrics' }))
			.get('/slow', async () => {
				await new Promise((resolve) => setTimeout(resolve, 200))
				return 'done'
			})

		const promise = app.handle(
			req('/slow', { signal: controller.signal })
		)
		controller.abort()
		await promise.catch(() => {})
		await settle()

		const dataPoints = await getHistogramDataPoints(reader)
		expect(dataPoints.length).toBe(1)

		const dp = dataPoints[0]
		expect(dp.attributes['http.request.method']).toBe('GET')
		expect(dp.value.sum).toBeGreaterThan(0)
	})

	it('should not record metrics when checkIfShouldTrace returns false', async () => {
		const app = new Elysia()
			.use(
				opentelemetry({
					serviceName: 'test-metrics',
					checkIfShouldTrace: () => false
				})
			)
			.get('/health', () => 'ok')

		await app.handle(req('/health'))
		await settle()

		const dataPoints = await getHistogramDataPoints(reader)
		expect(dataPoints.length).toBe(0)
	})

	it('should record metrics for multiple routes independently', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'test-metrics' }))
			.get('/a', () => 'a')
			.get('/b', () => 'b')

		await app.handle(req('/a'))
		await app.handle(req('/b'))
		await settle()

		const dataPoints = await getHistogramDataPoints(reader)
		expect(dataPoints.length).toBe(2)

		const routes = dataPoints.map(
			(dp) => dp.attributes['http.route']
		)
		expect(routes).toContain('/a')
		expect(routes).toContain('/b')
	})
})
