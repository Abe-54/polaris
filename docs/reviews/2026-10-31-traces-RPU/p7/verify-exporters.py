#!/usr/bin/env python3
"""Run the actual SKILL.md expression with all three endpoint precedence branches."""
import json
import os
from pathlib import Path
import subprocess
from verify import BASE_ENV, HERE, ROOT, SCRATCH, OUT, block, command, link, records, wait_file

app = SCRATCH / 'fixed-exporter'
app.mkdir(exist_ok=True)
(app / 'package.json').write_text('{"type":"module"}')
link(Path(os.environ.get('UF7_NODE_DEPS', '/tmp/rpu-p7/node/node_modules')), app / 'node_modules')
output = SCRATCH / 'out-fixed-exporter'
output.mkdir(exist_ok=True)
for name in ['port', 'requests.log', 'spans.jsonl']:
    (output / name).unlink(missing_ok=True)
with (output / 'collector.stdout').open('w') as log:
    receiver = subprocess.Popen(['bun', str(HERE / 'collector.ts'), str(output)], cwd=ROOT, env=BASE_ENV, stdout=log, stderr=log)
    try:
        port = int(wait_file(output / 'port', receiver))
        origin = f'http://127.0.0.1:{port}/otlp'
        snippet = block('SKILL.md', 0)
        prelude = '''import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { TracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace";
const existingVendorUrl = process.env.VENDOR_URL;
const existingHeaders = { authorization: "Bearer review-fake", "x-axiom-dataset": "dev" };
'''
        snippet = snippet.replace('new OTLPTraceExporter({ url, headers: existingHeaders });', 'const exporter = new OTLPTraceExporter({ url, headers: existingHeaders });')
        tail = '''
const provider = new TracerProvider({ spanProcessors: [new BatchSpanProcessor({ exporter })] });
provider.getTracer("fixed").startSpan(process.env.CASE).end();
await provider.shutdown();
console.log(process.env.CASE + ": " + url);
'''
        (app / 'fixed.mjs').write_text(prelude + snippet + tail)
        # Compile an async CommonJS entry without changing the endpoint expression.
        cjs = prelude.replace('import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";', 'const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-proto");').replace('import { TracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace";', 'const { TracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace");')
        (app / 'fixed.cjs').write_text(cjs + '(async () => {\n' + snippet + tail + '\n})();')
        results = []
        for runtime, file in [('node', 'fixed.mjs'), ('node', 'fixed.cjs'), ('bun', 'fixed.mjs')]:
            for case in ['vendor', 'base', 'specific']:
                env = {**BASE_ENV, 'VENDOR_URL': origin + '/vendor/v1/traces', 'CASE': f'{runtime}-{file}-{case}'}
                if case != 'vendor':
                    env['OTEL_EXPORTER_OTLP_ENDPOINT'] = origin + '/base/'
                if case == 'specific':
                    env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = origin + '/specific/v1/traces'
                result = command([runtime, file], app, env)
                assert result.strip().endswith(f'/{case}/v1/traces'), result
                results.append(result)
        spans = records(output / 'spans.jsonl')
        assert len(spans) == 9, len(spans)
        (OUT / 'fixed-exporters.txt').write_text(''.join(results) + '\n' + (output / 'requests.log').read_text())
        print('PASS fixed exporters: Node ESM + CJS and Bun, all 9 precedence cases')
    finally:
        receiver.terminate()
        receiver.wait()
