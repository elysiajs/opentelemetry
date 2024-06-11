import { Elysia } from 'elysia'
import { treaty } from '@elysiajs/eden'

import { opentelemetry } from '../src'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor, Span } from '@opentelemetry/sdk-trace-node'

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
                        url: 'https://api.axiom.co/v1/traces',
                        headers: {
                            Authorization: `Bearer ${Bun.env.AXIOM_TOKEN}`,
                            'X-Axiom-Dataset': Bun.env.AXIOM_DATASET
                        }
                    })
                )
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
        async function isSignIn({ trace, headers }) {
            const span1 = trace.startSpan('a.sleep.0')
            await Bun.sleep(50)
            span1.end()

            const span2 = trace.startSpan('a.sleep.1')
            await Bun.sleep(25)
            span2.end()
        },
        async function roleCheck({ trace }) {
            const span = trace.startSpan('b.sleep.0')
            await Bun.sleep(75)
            span.end()
        }
    ])
    .get(
        '/',
        async ({ trace, query }) => {
            return trace.startActiveSpan('handle.sleep.0', async (span) => {
                await Bun.sleep(100)
                span.end()

                return 'Hello Elysia'
            })
        },
        {
            async afterHandle({ response }) {
                await Bun.sleep(25)

                if (response === 'Hello Elysia')
                    throw new NagisaError('Where teapot?')
            }
        }
    )
    .listen(3000)

const api = treaty(app)

const { data, headers, error, status } = await api.index.get({
    query: {
        hello: 'world'
    }
})

console.log(error?.value)
