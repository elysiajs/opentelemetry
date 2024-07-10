import * as otel from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import {
	BatchSpanProcessor,
	ConsoleSpanExporter,
	Span
} from '@opentelemetry/sdk-trace-node'
import { Resource } from '@opentelemetry/resources'
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

const sdk = new NodeSDK({
	instrumentations: [getNodeAutoInstrumentations()],
	resource: new Resource({
		[SEMRESATTRS_SERVICE_NAME]: 'Elysia'
	}),
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

sdk.start()

console.log("Preload")
