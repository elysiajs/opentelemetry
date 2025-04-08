import { Elysia, type TraceEvent, type TraceProcess, StatusMap } from 'elysia'
import {
	trace,
	context as otelContext,
	propagation,
	SpanStatusCode,
	type ContextManager,
	type Context,
	type SpanOptions,
	type Span,
	type Attributes,
	TraceAPI,
	ProxyTracer
} from '@opentelemetry/api'

import { NodeSDK } from '@opentelemetry/sdk-node'
import { registerInstrumentations } from '@opentelemetry/instrumentation'

// @ts-ignore bun only
const headerHasToJSON = typeof new Headers().toJSON === 'function'

const parseNumericString = (message: string): number | null => {
	if (message.length < 16) {
		if (message.length === 0) return null

		const length = Number(message)
		if (Number.isNaN(length)) return null

		return length
	}

	// if 16 digit but less then 9,007,199,254,740,991 then can be parsed
	if (message.length === 16) {
		const number = Number(message)

		if (
			number.toString() !== message ||
			message.trim().length === 0 ||
			Number.isNaN(number)
		)
			return null

		return number
	}

	return null
}

type OpenTeleMetryOptions = NonNullable<
	ConstructorParameters<typeof NodeSDK>[0]
>

/**
 * Initialize OpenTelemetry SDK
 *
 * For best practice, you should be using preload OpenTelemetry SDK if possible
 * however, this is a simple way to initialize OpenTelemetry SDK
 */
export interface ElysiaOpenTelemetryOptions extends OpenTeleMetryOptions {
	contextManager?: ContextManager
}

export type ActiveSpanArgs<
	F extends (span: Span) => unknown = (span: Span) => unknown
> =
	| [name: string, fn: F]
	| [name: string, options: SpanOptions, fn: F]
	| [name: string, options: SpanOptions, context: Context, fn: F]

const createActiveSpanHandler = (fn: (span: Span) => unknown) =>
	function (span: Span) {
		try {
			const result = fn(span)

			// @ts-ignore
			if (result instanceof Promise || typeof result?.then === 'function')
				// @ts-ignore
				return result.then((result) => {
					if (span.isRecording()) span.end()

					return result
				})

			if (span.isRecording()) span.end()

			return result
		} catch (error) {
			if (!span.isRecording()) throw error

			const err = error as Error

			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: err?.message
			})

			span.recordException(err)
			span.end()

			throw error
		}
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

export type Tracer = ReturnType<TraceAPI['getTracer']>
export type StartSpan = Tracer['startSpan']
export type StartActiveSpan = Tracer['startActiveSpan']

export const contextKeySpan = Symbol.for('OpenTelemetry Context Key SPAN')

export const getTracer = (): ReturnType<TraceAPI['getTracer']> => {
	const tracer = trace.getTracer('Elysia')

	return {
		...tracer,
		startSpan(name: string, options?: SpanOptions, context?: Context) {
			return tracer.startSpan(name, options, context)
		},
		startActiveSpan(...args: ActiveSpanArgs) {
			switch (args.length) {
				case 2:
					return tracer.startActiveSpan(
						args[0],
						createActiveSpanHandler(args[1])
					)

				case 3:
					return tracer.startActiveSpan(
						args[0],
						args[1],
						createActiveSpanHandler(args[2])
					)

				case 4:
					return tracer.startActiveSpan(
						args[0],
						args[1],
						args[2],
						createActiveSpanHandler(args[3])
					)
			}
		}
	}
}

export const startActiveSpan: StartActiveSpan = (...args: ActiveSpanArgs) => {
	const tracer = getTracer()

	switch (args.length) {
		case 2:
			return tracer.startActiveSpan(
				args[0],
				createActiveSpanHandler(args[1])
			)

		case 3:
			return tracer.startActiveSpan(
				args[0],
				args[1],
				createActiveSpanHandler(args[2])
			)

		case 4:
			return tracer.startActiveSpan(
				args[0],
				args[1],
				args[2],
				createActiveSpanHandler(args[3])
			)
	}
}

export const record = startActiveSpan

export const getCurrentSpan = (): Span | undefined => {
	const current: Span = otelContext
		.active()
		// @ts-ignore
		._currentContext?.get(contextKeySpan)

	return current
}

/**
 * Set attributes to the current span
 *
 * @returns boolean - whether the attributes are set or not
 */
export const setAttributes = (attributes: Attributes) => {
	return !!getCurrentSpan()?.setAttributes(attributes)
}

export const opentelemetry = ({
	serviceName = 'Elysia',
	instrumentations,
	contextManager,
	...options
}: ElysiaOpenTelemetryOptions = {}) => {
	let tracer = trace.getTracer(serviceName)

	if (tracer instanceof ProxyTracer) {
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

	// @ts-expect-error private property
	if (!otelContext._getContextManager?.() && contextManager)
		try {
			contextManager.enable()
			otelContext.setGlobalContextManager(contextManager)
		} catch {
			// Noop ContextManager
			// _contextManager = {
			// 	active() {
			// 		return otelContext.active()
			// 	},
			// 	with(value: Context, callback: Function, ...args: any[]) {
			// 		return callback()
			// 	},
			// 	bind(context: Context, target: any) {
			// 		return target as any
			// 	},
			// 	enable() {
			// 		return this
			// 	},
			// 	disable() {
			// 		return this
			// 	}
			// }
		}

	return new Elysia({
		name: '@elysia/opentelemetry'
	})
		.wrap((fn, request) => {
			const ctx = propagation.extract(otelContext.active(), request)

			return tracer.startActiveSpan(
				'request',
				{},
				propagation.extract(otelContext.active(), request),
				(rootSpan) => otelContext.bind(trace.setSpan(ctx, rootSpan), fn)
			)
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
				context: {
					path,
					request: { method }
				}
			}) => {
				const rootSpan = trace.getActiveSpan()!

				if (!rootSpan) return

				let parent = rootSpan

				function setParent(span: Span) {
					const newContext = trace.setSpan(otelContext.active(), span)

					const currentContext: Map<Symbol, unknown> =
						// @ts-expect-error private property
						otelContext.active()._currentContext

					currentContext?.set(
						contextKeySpan,
						newContext.getValue(contextKeySpan)
					)

					parent = span
				}

				function inspect(name: TraceEvent) {
					return function inspect({
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
											setParent(span)
											onStop(({ error }) => {
												if (error) {
													rootSpan.setStatus({
														code: SpanStatusCode.ERROR,
														message: error.message
													})

													span.setAttributes({
														'error.type':
															error.constructor
																?.name ??
															error.name,
														'error.stack':
															error.stack
													})

													span.setStatus({
														code: SpanStatusCode.ERROR,
														message: error.message
													})

													// Early exit from event
													// console.log("Panic")
													event.end()
												} else {
													rootSpan.setStatus({
														code: SpanStatusCode.OK
													})

													span.setStatus({
														code: SpanStatusCode.OK
													})
												}

												span.end()
											})
										}
									)
								})

								onStop(() => {
									if (event.isRecording()) event.end()
									// console.log(`[${name}]: end`)
								})
							}
						)
					}
				}

				// @ts-ignore
				context.trace = {
					startSpan(
						name: string
						// options?: SpanOptions,
						// context?: Context
					) {
						return tracer.startSpan(name, {}, createContext(parent))
					},
					startActiveSpan(...args: ActiveSpanArgs) {
						switch (args.length) {
							case 2:
								return tracer.startActiveSpan(
									args[0],
									{},
									createContext(parent),
									createActiveSpanHandler(args[1])
								)

							case 3:
								return tracer.startActiveSpan(
									args[0],
									args[1],
									createContext(parent),
									createActiveSpanHandler(args[2])
								)

							case 4:
								return tracer.startActiveSpan(
									args[0],
									args[1],
									args[2],
									createActiveSpanHandler(args[3])
								)
						}
					},
					setAttributes(attributes: Attributes) {
						rootSpan.setAttributes(attributes)
					}
				}

				// @ts-expect-error private property
				const url = context.url
				const attributes: Record<string, string | number> = {
					// ? Elysia Custom attribute
					'http.request.id': id,
					'http.request.method': method,
					'url.path': path,
					'url.full': url
				}

				// @ts-ignore private property
				if (context.qi !== -1)
					attributes['url.query'] = url.slice(
						// @ts-ignore private property
						context.qi + 1
					)

				const protocolSeparator = url.indexOf('://')
				if (protocolSeparator > 0)
					attributes['url.scheme'] = url.slice(0, protocolSeparator)

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

					setParent(span)
					onStop(({ error }) => {
						if (error) {
							rootSpan.setStatus({
								code: SpanStatusCode.ERROR,
								message: error.message
							})

							span.setStatus({
								code: SpanStatusCode.ERROR,
								message: error.message
							})

							span.recordException(error)
							rootSpan.recordException(error)
						} else {
							rootSpan.setStatus({
								code: SpanStatusCode.OK
							})

							span.setStatus({
								code: SpanStatusCode.OK
							})
						}

						span.end()
					})
				})

				onAfterHandle(inspect('afterHandle'))
				onError(inspect('error'))
				onMapResponse(inspect('mapResponse'))

				onAfterResponse((event) => {
					inspect('afterResponse')(event)

					const {
						query,
						params,
						cookie,
						body,
						request,
						headers: parsedHeaders,
						response
					} = context

					if (context.route) attributes['http.route'] = context.route

					switch (typeof response) {
						case 'object':
							if (response instanceof Response) {
								// Unable to access as async, skip
							} else if (response instanceof Uint8Array)
								attributes['http.response.body.size'] =
									response.length
							else if (response instanceof ArrayBuffer)
								attributes['http.response.body.size'] =
									response.byteLength
							else if (response instanceof Blob)
								attributes['http.response.body.size'] =
									response.size
							else {
								const value = JSON.stringify(response)

								attributes['http.response.body'] = value
								attributes['http.response.body.size'] =
									value.length
							}

							break

						default:
							if (response === undefined || response === null)
								attributes['http.response.body.size'] = 0
							else {
								const value = response.toString()

								attributes['http.response.body'] = value
								attributes['http.response.body.size'] =
									value.length
							}
					}

					{
						let status = context.set.status
						if (!status) status = 200
						else if (typeof status === 'string')
							status = StatusMap[status] ?? 200

						attributes['http.response.status_code'] = status
					}

					/**
					 * ? Caution: This is not a standard way to get content-length
					 *
					 * As state in OpenTelemetry specification:
					 * The size of the request payload body in bytes.
					 * This is the number of bytes transferred excluding headers and is often,
					 * but not always, present as the Content-Length header.
					 * For requests using transport encoding, this should be the compressed size.
					 **/
					{
						let contentLength =
							request.headers.get('content-length')

						if (contentLength) {
							const number = parseNumericString(contentLength)

							if (number)
								attributes['http.request_content_length'] =
									number
						}
					}

					{
						const userAgent = request.headers.get('User-Agent')

						if (userAgent)
							attributes['user_agent.original'] = userAgent
					}

					const server = context.server
					if (server) {
						attributes['server.port'] = server.port
						attributes['server.address'] = server.url.hostname
						attributes['server.address'] = server.url.hostname
					}

					let headers

					{
						let hasHeaders
						let _headers:
							| [string, string | string[] | undefined][]
							| IterableIterator<[string, string]>

						if (context.headers) {
							hasHeaders = true
							headers = context.headers
							_headers = Object.entries(context.headers)
						} else if ((hasHeaders = headerHasToJSON)) {
							// @ts-ignore bun only
							headers = request.headers.toJSON()
							_headers = Object.entries(headers)
						} else {
							headers = {}
							_headers = request.headers.entries()
						}

						for (let [key, value] of _headers) {
							key = key.toLowerCase()

							if (hasHeaders) {
								if (key === 'user-agent') continue

								if (typeof value === 'object')
									// Handle Set-Cookie array
									attributes[`http.request.header.${key}`] =
										JSON.stringify(value)
								else if (value !== undefined)
									attributes[`http.request.header.${key}`] =
										value

								continue
							}

							if (typeof value === 'object')
								// Handle Set-Cookie array
								headers[key] = attributes[
									`http.request.header.${key}`
								] = JSON.stringify(value)
							else if (value !== undefined) {
								if (key === 'user-agent') {
									headers[key] = value

									continue
								}

								headers[key] = attributes[
									`http.request.header.${key}`
								] = value
							}
						}
					}

					{
						let headers
						if (context.set.headers instanceof Headers) {
							if (headerHasToJSON)
								headers = Object.entries(
									// @ts-ignore bun only
									context.set.headers.toJSON()
								)
							else headers = context.set.headers.entries()
						} else headers = Object.entries(context.set.headers)

						for (let [key, value] of headers) {
							key = key.toLowerCase()

							if (typeof value === 'object')
								attributes[`http.response.header.${key}`] =
									JSON.stringify(value)
							else
								attributes[`http.response.header.${key}`] =
									value as string
						}
					}

					// @ts-expect-error available on Elysia IP plugin
					if (context.ip)
						// @ts-expect-error
						attributes['client.address'] = context.ip
					else {
						const ip = server?.requestIP(request)

						if (ip) attributes['client.address'] = ip.address
					}

					// ? Elysia Custom attribute
					if (cookie) {
						const _cookie = <Record<string, string>>{}

						for (const [key, value] of Object.entries(cookie))
							_cookie[key] = JSON.stringify(value)

						attributes['http.request.cookie'] =
							JSON.stringify(_cookie)
					}

					if (body !== undefined && body !== null) {
						const value =
							typeof body === 'object'
								? JSON.stringify(body)
								: body.toString()

						attributes['http.request.body'] = value

						if (typeof body === 'object') {
							if (body instanceof Uint8Array)
								attributes['http.request.body.size'] =
									body.length
							else if (body instanceof ArrayBuffer)
								attributes['http.request.body.size'] =
									body.byteLength
							else if (body instanceof Blob)
								attributes['http.request.body.size'] = body.size

							attributes['http.request.body.size'] = value.length
						} else
							attributes['http.request.body.size'] = value.length
					}

					rootSpan.setAttributes(attributes)

					event.onStop(() => {
						setParent(rootSpan)

						rootSpan.updateName(
							// @ts-ignore private property
							`${method} ${context.route || context.path}`
						)
						rootSpan.end()
					})
				})
			}
		)
}
