import { Elysia } from 'elysia'
import { describe, expect, it, spyOn, beforeEach } from 'bun:test'
import { opentelemetry, record } from '../src'
import { diag } from '@opentelemetry/api'
import { req } from './test-setup'

describe('Nested Spans', () => {
	const diagError = spyOn(diag, 'error')

	beforeEach(() => {
		diagError.mockClear()
	})

	it('should not call end() twice on nested record() spans', async () => {
		const app = new Elysia()
			.use(opentelemetry({ serviceName: 'double-end-test' }))
			.get('/', async () => {
				return record('parent', async () => {
					await record('child1', async () => {
						await new Promise((res) => setTimeout(res, 10))
					})
					await record('child2', async () => {
						await new Promise((res) => setTimeout(res, 10))
					})
					return 'ok'
				})
			})

		const response = await app.handle(req('/'))
		expect(response.status).toBe(200)
		expect(diagError.mock.calls).toEqual([])
	})
})
