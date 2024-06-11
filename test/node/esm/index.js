if ('Bun' in globalThis) {
    throw new Error('❌ Use Node.js to run this test!')
}

import { opentelemetry } from '@elysiajs/opentelemetry'

if (typeof opentelemetry !== 'function') {
    throw new Error('❌ ESM Node.js failed')
}

console.log('✅ ESM Node.js works!')
