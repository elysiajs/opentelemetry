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
			spanProcessors: [
				new BatchSpanProcessor(
					new OTLPTraceExporter()
				)
			]
		})
	)
```

See [documentation](https://elysiajs.com/plugins/opentelemetry.html) for more details.
