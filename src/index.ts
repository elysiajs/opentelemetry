import { Elysia, type TraceEvent, type TraceProcess, StatusMap } from 'elysia'
import {
	trace,
	metrics,
	context as otelContext,
	propagation,
	SpanStatusCode,
	type ContextManager,
	type Context,
	type SpanOptions,
	type Span,
	type Attributes,
	TraceAPI,
	SpanKind,
	TracerProvider,
	ProxyTracerProvider
} from '@opentelemetry/api'

import { NodeSDK } from '@opentelemetry/sdk-node'

// @ts-ignore bun only
const headerHasToJSON = typeof new Headers().toJSON === 'function'

const toHeaderNameSet = (names: string[] | undefined): Set<string> =>
	new Set((names ?? []).map((name) => name.toLowerCase()))

const SENSITIVE_QUERY_KEYS = new Set([
	'token',
	'access_token',
	'refresh_token',
	'id_token',
	'password',
	'passwd',
	'pwd',
	'secret',
	'client_secret',
	'api_key',
	'apikey',
	'api-key',
	'authorization',
	'credential',
	'credentials',
	'code',
	'nonce'
])

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
	/**
	 * Optional function to determine whether a given request should be traced.
	 *
	 * @param req - The incoming request object to evaluate.
	 * @returns A boolean indicating whether tracing should be enabled for this request.
	 */
	checkIfShouldTrace?: (req: Request) => boolean
	/**
	 * Redact `userinfo` and sensitive query values in `url.full` / `url.query`.
	 * Omitted: default redaction. `false`: record raw URLs (may leak secrets in query or credentials).
	 */
	spanUrlRedaction?:
		| false
		| {
				stripCredentials?: boolean
				sensitiveQueryParams?: string[]
		  }
	/**
	 * Record full request/response body content on spans.
	 * `true`: record both request and response bodies.
	 * `{ request: true }` or `{ response: true }`: record only one side.
	 * Default: `false` (no body content recorded).
	 */
	recordBody?: boolean | { request?: boolean; response?: boolean }
	/**
	 * HTTP header names (case-insensitive) to capture as span attributes.
	 * Use `"*"` in either list to capture all headers (useful for dev/debugging; may include sensitive values).
	 * Including `"cookie"` in `requestHeaders` also emits `http.request.cookie` when `context.cookie` exists.
	 * Default: none (no headers recorded).
	 */
	headersToSpanAttributes?: {
		request?: string[]
		response?: string[]
	}
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
				return Promise.resolve(result).then(
					(value) => {
						span.end()
						return value
					},
					(rejectResult) => {
						span.setStatus({
							code: SpanStatusCode.ERROR,
							message:
								rejectResult instanceof Error
									? rejectResult.message
									: JSON.stringify(
											rejectResult ?? 'Unknown error'
										)
						})

						span.recordException(rejectResult)
						span.end()
						throw rejectResult
					}
				)

			span.end()
			return result
		} catch (error) {
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

const serializeBody = (body: unknown): { text: string; size: number } => {
	if (body instanceof Uint8Array) return { text: '', size: body.length }
	if (body instanceof ArrayBuffer) return { text: '', size: body.byteLength }
	if (body instanceof Blob) return { text: '', size: body.size }

	let text: string
	try {
		text = typeof body === 'object' ? JSON.stringify(body) : String(body)
	} catch {
		text = '[Unserializable]'
	}

	return { text, size: text.length }
}

const redactQueryString = (query: string, keys: Set<string>): string => {
	if (query === '' || keys.size === 0) return query

	let out = ''
	let partStart = 0
	let keyEnd = -1

	for (let i = 0; i <= query.length; i++) {
		const ch = i === query.length ? 38 : query.charCodeAt(i)

		if (ch === 61 && keyEnd === -1) {
			keyEnd = i // '='
			continue
		}

		if (ch !== 38) continue // '&'

		const partEnd = i
		const rawKeyEnd = keyEnd === -1 ? partEnd : keyEnd
		const rawKey = query.slice(partStart, rawKeyEnd)

		if (out) out += '&'
		out += keys.has(rawKey.toLowerCase())
			? rawKey + '=[REDACTED]'
			: query.slice(partStart, partEnd)

		partStart = i + 1
		keyEnd = -1
	}

	return out
}

export const shouldStartNodeSDK = (provider: TracerProvider) => {
	return (
		provider instanceof ProxyTracerProvider &&
		provider.getDelegateTracer('check') === undefined
	)
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

export const startSpan = (
	name: string,
	options?: SpanOptions,
	context?: Context
): Span => {
	const tracer = getTracer()

	return tracer.startSpan(name, options, context)
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
export const getCurrentSpan = (): Span | undefined => trace.getActiveSpan()

/**
 * Set attributes to the current span
 *
 * @returns boolean - whether the attributes are set or not
 */
export const setAttributes = (attributes: Attributes) =>
	!!getCurrentSpan()?.setAttributes(attributes)

export const opentelemetry = ({
	serviceName = 'Elysia',
	instrumentations,
	contextManager,
	checkIfShouldTrace,
	spanUrlRedaction,
	recordBody,
	headersToSpanAttributes,
	...options
}: ElysiaOpenTelemetryOptions = {}) => {
	const spanRequestHeaderSet = toHeaderNameSet(
		headersToSpanAttributes?.request
	)
	const spanResponseHeaderSet = toHeaderNameSet(
		headersToSpanAttributes?.response
	)
	const requestHeaderWildcard = spanRequestHeaderSet.has('*')
	const responseHeaderWildcard = spanResponseHeaderSet.has('*')
	const recordRequestBody =
		recordBody === true || (recordBody && recordBody.request) || false
	const recordResponseBody =
		recordBody === true || (recordBody && recordBody.response) || false
	const urlRedactOpts =
		spanUrlRedaction === false ? null : (spanUrlRedaction ?? {})
	const sensitiveKeys = urlRedactOpts
		? new Set([
				...SENSITIVE_QUERY_KEYS,
				...(urlRedactOpts.sensitiveQueryParams ?? []).map((k: string) =>
					k.toLowerCase()
				)
			])
		: undefined
	const stripCreds = urlRedactOpts?.stripCredentials !== false

	let tracer = trace.getTracer(serviceName)

	if (shouldStartNodeSDK(trace.getTracerProvider())) {
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

	const meter = metrics.getMeter(serviceName)
	const httpServerDuration = meter.createHistogram(
		'http.server.request.duration',
		{
			description: 'Duration of HTTP server requests.',
			unit: 's',
			advice: {
				explicitBucketBoundaries: [
					0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75,
					1, 2.5, 5, 7.5, 10, 30, 60, 120, 300, 600, 900, 1800
				]
			}
		}
	)

	return new Elysia({
		name: '@elysia/opentelemetry'
	})
		.wrap((fn, request) => {
			const shouldTrace = checkIfShouldTrace
				? checkIfShouldTrace(request)
				: true

			if (!shouldTrace) return fn

			const headers = headerHasToJSON
				? // @ts-ignore bun only
					request.headers.toJSON()
				: Object.fromEntries(request.headers.entries())

			const ctx = propagation.extract(otelContext.active(), headers)

			return tracer.startActiveSpan(
				'Root',
				{ kind: SpanKind.SERVER },
				ctx,
				(rootSpan) => {
					const spanContext = trace.setSpan(ctx, rootSpan)
					// Execute fn within the span's context using with() instead of bind()
					// This ensures proper cleanup when the function completes or errors
					return (...args: any[]) => {
						return otelContext.with(spanContext, () => fn(...args))
					}
				}
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

				function setParent(span: Span) {
					// @ts-ignore
					if (span.ended) return

					// @ts-ignore
					if (rootSpan.ended) return void span.end()

					const newContext = trace.setSpan(otelContext.active(), span)

					const currentContext: Map<Symbol, unknown> =
						// @ts-expect-error private property
						otelContext.active()._currentContext

					currentContext?.set(
						contextKeySpan,
						newContext.getValue(contextKeySpan)
					)
				}

				function inspect(name: Capitalize<TraceEvent>) {
					return function inspect({
						onEvent,
						total,
						onStop
					}: TraceProcess<'begin', true>) {
						if (
							total === 0 ||
							// @ts-ignore
							rootSpan.ended
						)
							return

						tracer.startActiveSpan(
							name,
							{},
							createContext(rootSpan),
							(event) => {
								if (
									// @ts-ignore
									rootSpan.ended
								)
									return

								onEvent(({ name, onStop }) => {
									const useChildSpan = total > 1
									let span: Span
									if (useChildSpan) {
										span = tracer.startSpan(
											name,
											{},
											createContext(event)
										)
										setParent(span)
									} else {
										setParent(event)
										span = event
									}

									onStop(({ error }) => {
										setParent(rootSpan)

										if (
											(span as any).ended ||
											(rootSpan as any).ended
										)
											return
										if (error) {
											span.setAttributes({
												'error.type':
													error.constructor?.name ??
													error.name,
												'error.stack': error.stack
											})
										}

										if (useChildSpan) span.end()
									})
								})

								onStop(() => {
									setParent(rootSpan)

									if ((event as any).ended) return
									event.end()
								})
							}
						)
					}
				}

				// @ts-expect-error private property
				const rawUrl: string = context.url
				// @ts-expect-error private property
				const qi: number | undefined = context.qi
				const hasQuery = qi !== undefined && qi !== -1
				let urlQuery = hasQuery ? rawUrl.slice(qi + 1) : undefined
				let urlFull = rawUrl

				if (urlRedactOpts) {
					if (urlQuery !== undefined) {
						urlQuery = redactQueryString(urlQuery, sensitiveKeys!)
						urlFull = `${rawUrl.slice(0, qi)}?${urlQuery}`
					}

					if (stripCreds && urlFull.indexOf('@') > 0) {
						try {
							const u = new URL(urlFull)
							if (u.username || u.password) {
								u.username = ''
								u.password = ''
								urlFull = u.href
							}
						} catch {
							// keep urlFull as-is
						}
					}
				}

				const attributes: Record<string, string | number> =
					Object.assign(Object.create(null), {
						// ? Elysia Custom attribute
						'http.request.id': id,
						'http.request.method': method,
						'url.path': path,
						'url.full': urlFull
					})

				if (urlQuery !== undefined) attributes['url.query'] = urlQuery

				const protocolSeparator = urlFull.indexOf('://')
				if (protocolSeparator > 0)
					attributes['url.scheme'] = urlFull.slice(
						0,
						protocolSeparator
					)

				const requestStartTime = performance.now()
				let durationRecorded = false

				const recordDuration = () => {
					if (durationRecorded) return
					durationRecorded = true

					const durationS =
						(performance.now() - requestStartTime) / 1000
					const statusCode =
						attributes['http.response.status_code']

					const metricAttributes = {
						'http.request.method': attributes['http.request.method'] ?? method,
						'url.scheme': attributes['url.scheme'],
						'http.response.status_code': statusCode,
						'http.route': attributes['http.route']
					} as Record<string, string | number | undefined>

					if (typeof statusCode === 'number' && statusCode >= 500)
						metricAttributes['error.type'] = String(statusCode)

					httpServerDuration.record(durationS, metricAttributes)
				}

				onRequest(inspect('Request'))
				onParse(inspect('Parse'))
				onTransform(inspect('Transform'))
				onBeforeHandle(inspect('BeforeHandle'))

				onHandle(({ onStop }) => {
					const span = tracer.startSpan(
						'Handle',
						{},
						createContext(rootSpan)
					)
					setParent(span)

					onStop(({ error }) => {
						setParent(rootSpan)

						// @ts-ignore
						if ((span as any).ended || rootSpan.ended) return

						if (error) {
							span.recordException(error)
							rootSpan.recordException(error)
						}

						span.end()
					})
				})

				onAfterHandle(inspect('AfterHandle'))
				onError((event) => {
					inspect('Error')(event)

					event.onStop(({ error }) => {
						setParent(rootSpan)
						if ((rootSpan as any).ended) return

						{
							let status = context.set.status

							if (typeof status === 'string') {
								status = StatusMap[status]
							} else if (
								typeof status !== 'number' &&
								// @ts-ignore
								typeof error?.status === 'number'
							)
								// @ts-ignore
								status = error.status

							if (typeof status === 'number') {
								attributes['http.response.status_code'] = status

								if (status >= 500)
									rootSpan.setStatus({
										code: SpanStatusCode.ERROR
									})
							}

							rootSpan.setAttributes(attributes)
						}

						if (
							// @ts-ignore
							!rootSpan.ended
						) {
							recordDuration()
							rootSpan.end()
						}
					})
				})
				onMapResponse(inspect('MapResponse'))
				onTransform(() => {
					const { cookie, request, route, path } = context

					if (route)
						rootSpan.updateName(
							// @ts-ignore private property
							`${method} ${route || path}`
						)

					if (context.route) attributes['http.route'] = context.route

					/**
					 * ? Caution: This is not a standard way to get content-length
					 *
					 * As state in OpenTelemetry specification:
					 * The size of the request payload body in bytes.
					 * This is the number of bytes transferred excluding headers and is often,
					 * but not always, present as the Content-Length header.
					 * For requests using transport encoding, this should be the compressed size.
					 **/
					const contentLength = request.headers.get('content-length')
					if (contentLength) {
						const number = parseNumericString(contentLength)

						if (number !== null)
							attributes['http.request_content_length'] = number
					}

					const userAgent = request.headers.get('User-Agent')
					if (userAgent) attributes['user_agent.original'] = userAgent

					const server = context.server
					if (server) {
						attributes['server.port'] = server.port ?? 80
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
								if (
									!requestHeaderWildcard &&
									!spanRequestHeaderSet.has(key)
								)
									continue

								if (typeof value === 'object')
									// Handle Set-Cookie array
									attributes[`http.request.header.${key}`] =
										JSON.stringify(value)
								else if (value !== undefined)
									attributes[`http.request.header.${key}`] =
										value

								continue
							}

							if (typeof value === 'object') {
								const serialized = JSON.stringify(value)

								headers[key] = serialized

								if (
									requestHeaderWildcard ||
									spanRequestHeaderSet.has(key)
								)
									attributes[`http.request.header.${key}`] =
										serialized
							} else if (value !== undefined) {
								headers[key] = value

								if (
									requestHeaderWildcard ||
									spanRequestHeaderSet.has(key)
								)
									attributes[`http.request.header.${key}`] =
										value
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
							if (
								!responseHeaderWildcard &&
								!spanResponseHeaderSet.has(key)
							)
								continue

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
						const ip =
							headers['true-client-ip'] ??
							headers['cf-connection-ip'] ??
							headers['x-forwarded-for'] ??
							headers['x-real-ip'] ??
							server?.requestIP(request)

						if (ip)
							attributes['client.address'] =
								typeof ip === 'string'
									? ip
									: (ip.address ?? ip.toString())
					}

					// ? Elysia Custom attribute (opt-in: requestHeaders includes `cookie`)
					if (
						(requestHeaderWildcard ||
							spanRequestHeaderSet.has('cookie')) &&
						cookie
					) {
						const _cookie = <Record<string, string>>{}

						for (const [key, { value }] of Object.entries(cookie))
							_cookie[key] = JSON.stringify(value)

						attributes['http.request.cookie'] =
							JSON.stringify(_cookie)
					}

					rootSpan.setAttributes(attributes)
				})

				onParse(() => {
					const body = context.body
					if (
						body === undefined ||
						body === null ||
						!recordRequestBody
					)
						return

					const { text, size } = serializeBody(body)
					if (text) attributes['http.request.body'] = text
					attributes['http.request.body.size'] = size
				})

				onMapResponse(() => {
					const body = context.body
					if (
						body !== undefined &&
						body !== null &&
						recordRequestBody
					) {
						const { text, size } = serializeBody(body)
						if (text) attributes['http.request.body'] = text
						attributes['http.request.body.size'] = size
					}

					{
						let status = context.set.status ?? 200
						if (typeof status === 'string')
							status = StatusMap[status] ?? 200

						attributes['http.response.status_code'] = status
					}

					// @ts-ignore
					const response = context.responseValue
					if (response !== undefined && recordResponseBody) {
						const { text, size } = serializeBody(response)
						if (text) attributes['http.response.body'] = text
						attributes['http.response.body.size'] = size
					}

					if (!(rootSpan as any).ended) {
						const statusCode =
							attributes['http.response.status_code']
						if (
							typeof statusCode === 'number' &&
							statusCode >= 500
						) {
							rootSpan.setStatus({
								code: SpanStatusCode.ERROR
							})
						}
						rootSpan.setAttributes(attributes)
					}
				})

				onAfterResponse((event) => {
					inspect('AfterResponse')(event)

					{
						let status = context.set.status ?? 200
						if (typeof status === 'string')
							status = StatusMap[status] ?? 200

						attributes['http.response.status_code'] = status
					}

					const body = context.body
					if (
						body !== undefined &&
						body !== null &&
						recordRequestBody
					) {
						const { text, size } = serializeBody(body)
						if (text) attributes['http.request.body'] = text
						attributes['http.request.body.size'] = size
					}

					if (!(rootSpan as any).ended) {
						const statusCode =
							attributes['http.response.status_code']

						if (typeof statusCode === 'number' && statusCode >= 500)
							rootSpan.setStatus({
								code: SpanStatusCode.ERROR
							})

						rootSpan.setAttributes(attributes)
					}

					event.onStop(() => {
						setParent(rootSpan)
						if ((rootSpan as any).ended) return

						if (
							// @ts-ignore
							!rootSpan.ended
						) {
							recordDuration()
							rootSpan.end()
						}
					})
				})

				// @ts-ignore
				context.request.signal.addEventListener('abort', () => {
					const active = trace.getActiveSpan()
					if (active && !(active as any).ended) active.end()

					if ((rootSpan as any).ended) return

					rootSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: 'Request aborted'
					})
					recordDuration()
					rootSpan.end()
				})
			}
		)
}
