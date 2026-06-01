# @elysia/opentelemetry

## Installation
```bash
bun install @elysia/opentelemetry
```

## Example
```typescript twoslash
import { Elysia } from 'elysia'
import { opentelemetry } from '@elysia/opentelemetry'

import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'

new Elysia()
	.use(
		opentelemetry({
			enabled: process.env.OTEL_ENABLED !== 'false',
			serviceName: 'api',
			spanProcessors: [
				new BatchSpanProcessor(
					new OTLPTraceExporter()
				)
			]
		})
	)
```

## Production defaults

```typescript
new Elysia()
	.use(
		opentelemetry({
			enabled: process.env.OTEL_ENABLED !== 'false',
			serviceName: process.env.OTEL_SERVICE_NAME ?? 'api',
			recordBody: false,
			headersToSpanAttributes: {
				request: ['user-agent', 'content-type'],
				response: ['content-type']
			}
		})
	)
```

- Use `enabled: false` to keep the plugin in the app graph while skipping SDK and span setup.
- Keep `recordBody` disabled unless request or response bodies are safe to export.
- Allow-list headers instead of using `'*'` in production.

See [documentation](https://elysiajs.com/plugins/opentelemetry.html) for more details.
