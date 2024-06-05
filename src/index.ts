import { Elysia, type TraceEvent, TraceProcess } from 'elysia'
import {
    trace,
    createContextKey,
    context as otelContext,
    SpanStatusCode,
    type ContextManager,
    type Context,
    type SpanOptions,
    type Span
} from '@opentelemetry/api'

import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

type OpenTeleMetryOptions = NonNullable<
    ConstructorParameters<typeof NodeSDK>[0]
>

/**
 * Initialize OpenTelemetry SDK
 *
 * For best practice, you should be using preload OpenTelemetry SDK if possible
 * however, this is a simple way to initialize OpenTelemetry SDK
 */
interface ElysiaOpenTelemetryOptions extends OpenTeleMetryOptions {
    contextManager?: ContextManager
}

const createContext = (parent: Span) => ({
    getValue() {
        return parent
    },
    setValue() {
        return otelContext.active()
    },
    deleteValue() {
        return otelContext.active()
    }
})

const isNotEmpty = (obj?: Object) => {
    if (!obj) return false

    for (const x in obj) return true

    return false
}

export const opentelemetry = ({
    serviceName = 'Elysia',
    instrumentations,
    contextManager,
    ...options
}: ElysiaOpenTelemetryOptions = {}) => {
    let tracer = trace.getTracer(serviceName)

    const isInitialized = !(
        '_getTracer' in tracer &&
        // @ts-expect-error
        tracer._getTracer()?.constructor?.name === 'NoopTracer'
    )

    if (!isInitialized) {
        if (!instrumentations)
            instrumentations = [getNodeAutoInstrumentations()]

        const sdk = new NodeSDK({
            ...options,
            serviceName,
            instrumentations
        })

        sdk.start()

        tracer = trace.getTracer(serviceName)
    } else {
        // @ts-ignore
        // const exporter = tracer?._tracerProvider?._config?.traceExporter
        // if (
        //     exporter &&
        //     options.traceExporter &&
        //     exporter.constructor.name !== options.traceExporter
        // )
        //     // @ts-ignore
        //     tracer._tracerProvider._config.traceExporter = options.traceExporter
    }

    if (contextManager)
        try {
            contextManager.enable()
            otelContext.setGlobalContextManager(contextManager)
        } catch {
            // noop
        }

    return new Elysia({
        name: '@elysia/opentelemetry'
    })
        .decorate('trace', {
            startSpan(name: string, options?: SpanOptions, context?: Context) {
                return tracer.startSpan(name, options, context)
            },
            startActiveSpan: tracer.startActiveSpan
        })
        .trace(
            { as: 'global' },
            ({
                id,
                onRequest,
                onParse,
                onTransform,
                onBeforeHandle,
                onHandle,
                onAfterHandle,
                onError,
                onAfterResponse,
                onMapResponse,
                context,
                set,
                context: {
                    path,
                    request: { method }
                }
            }) => {
                tracer.startActiveSpan('request', async (rootSpan) => {
                    let parent = rootSpan

                    function inspect(name: TraceEvent) {
                        return function ({
                            onEvent,
                            total,
                            onStop
                        }: TraceProcess<'begin', true>) {
                            if (total === 0) return

                            tracer.startActiveSpan(
                                name,
                                {},
                                createContext(rootSpan),
                                (event) => {
                                    onEvent(({ name, onStop }) => {
                                        tracer.startActiveSpan(
                                            name,
                                            {},
                                            createContext(event),
                                            (span) => {
                                                parent = span
                                                onStop(({ error }) => {
                                                    if (error) {
                                                        span.setAttributes({
                                                            'error.name':
                                                                error
                                                                    .constructor
                                                                    ?.name ??
                                                                error.name,
                                                            'error.stack':
                                                                error.stack
                                                        })
                                                    }

                                                    if (error)
                                                        span.setStatus({
                                                            code: SpanStatusCode.ERROR,
                                                            message:
                                                                error.message
                                                        })
                                                    else
                                                        span.setStatus({
                                                            code: SpanStatusCode.OK
                                                        })

                                                    span.end()
                                                })
                                            }
                                        )
                                    })

                                    onStop(({ error }) => {
                                        event.end()
                                    })
                                }
                            )
                        }
                    }

                    // @ts-ignore
                    context.trace = {
                        startSpan(
                            name: string,
                            options?: SpanOptions,
                            context?: Context
                        ) {
                            return tracer.startSpan(
                                name,
                                {},
                                createContext(parent)
                            )
                        },
                        startActiveSpan: tracer.startActiveSpan
                    }

                    const attributes: Record<string, string | number> = {
                        'request.id': id,
                        'request.path': path,
                        'request.method': method
                    }

                    onRequest(inspect('request'))
                    onParse(inspect('parse'))
                    onTransform(inspect('transform'))
                    onBeforeHandle(inspect('beforeHandle'))

                    onHandle(({ onStop }) => {
                        const span = tracer.startSpan(
                            'handle',
                            {},
                            createContext(rootSpan)
                        )

                        parent = span
                        onStop(({ error }) => {
                            if (error)
                                span.setStatus({
                                    code: SpanStatusCode.ERROR,
                                    message: error.message
                                })
                            else
                                span.setStatus({
                                    code: SpanStatusCode.OK
                                })

                            span.end()
                        })
                    })

                    onAfterHandle(inspect('afterHandle'))
                    onError(inspect('error'))
                    onMapResponse(inspect('mapResponse'))

                    onAfterResponse((event) => {
                        inspect('afterResponse')(event)

                        const { query, params, cookie, body, request } = context

                        if (query)
                            attributes['request.query'] = JSON.stringify(query)

                        if (params)
                            attributes['request.params'] =
                                JSON.stringify(params)

                        let headers = request.headers?.toJSON() ?? undefined

                        if (!headers) {
                            headers = {}

                            for (const [key, value] of Object.entries(
                                request.headers
                            )) {
                                // ? Some value maybe array
                                headers[key] =
                                    typeof value === 'object'
                                        ? JSON.stringify(value)
                                        : value
                            }
                        }

                        attributes['request.headers'] = JSON.stringify(headers)

                        if (cookie)
                            for (const [key, value] of Object.entries(cookie))
                                if (key)
                                    attributes[`cookie.${key}`] =
                                        typeof value.value === 'object'
                                            ? JSON.stringify(value.value)
                                            : value.value

                        if (body !== undefined && body !== null)
                            attributes.body =
                                typeof body === 'object'
                                    ? JSON.stringify(body)
                                    : body.toString()

                        rootSpan.setAttributes(attributes)

                        event.onStop(() => {
                            rootSpan.end()
                        })
                    })
                })
            }
        )
}
