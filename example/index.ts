import { Elysia, t } from 'elysia'
import { treaty } from '@elysiajs/eden'

import {
	getCurrentSpan,
	getTracer,
	opentelemetry,
	setAttributes,
	startSpan
} from '../src'
import * as otel from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import {
	BatchSpanProcessor,
	ConsoleSpanExporter
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

const plugin = () => (app: Elysia) =>
	app.get('/', () => {
		return 'a'
	})

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
				)
				// new BatchSpanProcessor(new ConsoleSpanExporter())
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
	.trace(({ onAfterResponse }) => {
		onAfterResponse(() => {
			console.log("A")
		})
	})
	.get('/stream', async function* () {
		for (let i = 0; i < 1000; i++) {
			yield i
			console.log(i)
			await Bun.sleep(3)
		}
	})
	.onBeforeHandle([
		async function isSignIn() {
			const span1 = startSpan('a.sleep.0')
			await Bun.sleep(50)
			span1.end()

			const span2 = startSpan('a.sleep.1')
			await Bun.sleep(25)
			span2.end()
		},
		async function roleCheck() {
			const span = startSpan('b.sleep.0')
			await Bun.sleep(75)
			span.end()
		}
	])
	.post(
		'/id/:id',
		async ({ query }) => {
			setAttributes({ hello: 'world' })

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
					return new NagisaError('Where teapot?')
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
				useOpenTelemetry(
					{
						resolvers: true, // Tracks resolvers calls, and tracks resolvers thrown errors
						variables: true, // Includes the operation variables values as part of the metadata collected
						result: true, // Includes execution result object as part of the metadata collected
						document: true // Includes the operation document as part of the metadata collected
					},
					otel.trace.getTracerProvider()
				)
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
	.use(plugin())
	.listen(3000)

// console.log(app.routes[0].compile().toString())

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
