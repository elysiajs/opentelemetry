import { Elysia, t } from 'elysia'
import { treaty } from '@elysiajs/eden'

import { getTracer, opentelemetry } from '../src'
import * as otel from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import {
	BatchSpanProcessor,
	ConsoleSpanExporter,
	Span
} from '@opentelemetry/sdk-trace-node'

import { yoga } from '@elysiajs/graphql-yoga'
import { useOpenTelemetry } from '@envelop/opentelemetry'

export const typeDefs = /* GraphQL */ `
	type Query {
		authors: [Author!]!
		author(id: ID, name: String): Author!
		books(page: Int, perPage: Int): [Book!]!
		book(name: String!): Book
	}

	type Mutation {
		addBook(name: String!, author: ID!): Book!
	}

	type Author {
		id: ID!
		name: String!
		books: [Book!]!
	}

	type Book {
		id: ID!
		name: String!
		author: Author!
	}
`

const author = {
	id: 'A',
	name: 'SaltyAom',
	books: []
}

const book = {
	id: 'A',
	name: 'SaltyAom',
	author
}

class NagisaError extends Error {
	constructor(message: string) {
		super(message)
	}
}

const app = new Elysia()
	.use(
		opentelemetry({
			spanProcessors: [
				new BatchSpanProcessor(
					new OTLPTraceExporter({
						// url: 'https://api.axiom.co/v1/traces',
						// headers: {
						//     Authorization: `Bearer ${Bun.env.AXIOM_TOKEN}`,
						//     'X-Axiom-Dataset': Bun.env.AXIOM_DATASET
						// }
					})
				),
				new BatchSpanProcessor(new ConsoleSpanExporter())
			]
		})
	)
	.error({
		NAGISA_ERROR: NagisaError
	})
	.onError([
		function handleCustomError({ code }) {
			if (code === 'NAGISA_ERROR') return 'An error occurred'
		},
		function handleUnknownError({ code }) {
			if (code === 'UNKNOWN') return 'An error occurred'
		}
	])
	.onBeforeHandle([
		async function isSignIn() {
			const trace = otel.trace.getTracer('Elysia')
			const span1 = trace.startSpan('a.sleep.0')
			await Bun.sleep(50)
			span1.end()

			const span2 = trace.startSpan('a.sleep.1')
			await Bun.sleep(25)
			span2.end()
		},
		async function roleCheck() {
			const span = getTracer().startSpan('b.sleep.0')
			await Bun.sleep(75)
			span.end()
		}
	])
	.post(
		'/id/:id',
		async ({ query }) => {
			return getTracer().startActiveSpan(
				'handle.sleep.0',
				async (span) => {
					await Bun.sleep(100)
					span.end()

					return 'Hello Elysia'
				}
			)
		},
		{
			async afterHandle({ response }) {
				await Bun.sleep(25)

				if (response === 'Hello Elysia')
					throw new NagisaError('Where teapot?')
			},
			body: t.Object({
				name: t.String()
			})
		}
	)
	.get('/context', async () => {
		return 'k'
	})
	.use(
		yoga({
			typeDefs,
			plugins: [
				useOpenTelemetry({
					resolvers: true, // Tracks resolvers calls, and tracks resolvers thrown errors
					variables: true, // Includes the operation variables values as part of the metadata collected
					result: true // Includes execution result object as part of the metadata collected
				})
			],
			resolvers: {
				Query: {
					author: (_, __, ___) => author,
					authors: () => [author],
					book: () => book,
					books: () => [book]
				},
				Mutation: {
					addBook: () => book
				}
			}
		})
	)
	.listen(3000)

// const api = treaty(app)

// await api.context
// 	.get()
// 	.then((x) => x.data)
// 	.then(console.log)

// const { data, headers, error, status } = await api.id({ id: 'hello' }).post(
// 	{
// 		name: 'saltyaom'
// 	},
// 	{
// 		query: {
// 			hello: 'world'
// 		}
// 	}
// )

// console.log(error?.value)
