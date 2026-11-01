#!/usr/bin/env python3
"""Extract the shipped references verbatim; run disposable apps with RPU's real decoder receiver."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
SCRATCH = Path(os.environ.get('UF7_SCRATCH', '/tmp/uf7'))
OUT = HERE / 'fixed-runs'
OUT.mkdir(exist_ok=True)
SKILL = ROOT / 'skills/polaris-tracing'
BASE_ENV = {k: v for k, v in os.environ.items() if not k.startswith('OTEL_')}


def block(file, index):
    return re.findall(r'^```[a-z]*\n([\s\S]*?)^```$', (SKILL / file).read_text(), re.M)[index]


def command(args, cwd, env=BASE_ENV):
    run = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=90)
    if run.returncode:
        raise RuntimeError(f'{args}: {run.stdout}\n{run.stderr}')
    return run.stdout + run.stderr


def link(source, target):
    if not target.exists():
        target.symlink_to(source, target_is_directory=True)


def prepare(runtime):
    app = SCRATCH / runtime
    app.mkdir(exist_ok=True)
    commonjs = runtime.endswith('cjs')
    (app / 'package.json').write_text(json.dumps({'type': 'commonjs' if commonjs else 'module'}))
    deps = Path(os.environ.get('UF7_BUN_DEPS' if runtime.startswith('bun') else 'UF7_NODE_DEPS', '/tmp/rpu-p7/bun/node_modules' if runtime.startswith('bun') else '/tmp/rpu-p7/node/node_modules'))
    link(deps, app / 'node_modules')
    (app / 'tracing.ts').write_text(block('references/tracing-helper.md', 0))
    fixture = (HERE / ('bun-server.ts' if runtime.startswith('bun') else 'node-server.ts')).read_text()
    fixture = fixture.replace('process.on("SIGTERM", () => {', 'process.on("SIGTERM", async () => {')
    fixture = fixture.replace('setTimeout(() => {', 'setTimeout(async () => {')
    fixture = fixture.replace('console.log("app: drained");', 'await shutdownTelemetry();\n    console.log("app: drained");')
    if runtime.startswith('bun'):
        (app / 'instrumentation.ts').write_text(block('references/bun.md', 1))
        http = block('references/bun.md', 2) + '\n' + block('references/bun.md', 4)
        (app / 'http.ts').write_text(http)
        fixture = fixture.replace('import { tracedFetch }', 'import { tracedFetch, outgoingFetch }')
        fixture = fixture.replace('    await tail();', '    await tail();\n    await outgoingFetch(process.env.ECHO_URL!);')
        fixture = fixture.replace(': new URL(req.url).pathname)', ': "unmatched")')
    else:
        (app / 'instrumentation.ts').write_text(block('references/node.md', 1))
        # Plain node:http route attributes, as instructed by node.md.
        fixture = 'import { trace } from "@opentelemetry/api";\n' + fixture
        fixture = fixture.replace('  try {\n    if (req.url', '  const pattern = req.url?.startsWith("/orders/") ? "/orders/:id" : "unmatched";\n  trace.getActiveSpan()?.setAttributes({ "http.route": pattern });\n  trace.getActiveSpan()?.updateName(`GET ${pattern}`);\n  try {\n    if (req.url')
    fixture = 'import { shutdownTelemetry } from "./instrumentation.ts";\n' + fixture
    (app / 'server.ts').write_text(fixture)
    if commonjs:
        (app / 'instrumentation.cjs').write_text(block('references/node.md', 2))
        fixture = fixture.replace('./instrumentation.ts', './instrumentation.cjs')
        (app / 'server.ts').write_text(fixture)
        # Compile imports/exports and strip types; the helper has no import.meta.
        for name in ['tracing', 'server']:
            command(['bun', 'build', f'{name}.ts', '--target=node', '--format=cjs', '--packages=external', '--external=./tracing.ts', '--external=./instrumentation.cjs', f'--outfile={name}.cjs'], app)
        p = app / 'server.cjs'
        p.write_text(p.read_text().replace('./tracing.ts', './tracing.cjs'))
    return app


def wait_file(path, child):
    for _ in range(200):
        if path.exists():
            return path.read_text()
        if child.poll() is not None:
            raise RuntimeError('receiver exited')
        time.sleep(.05)
    raise TimeoutError(str(path))


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        return e.read()


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def exercise(name, app, args, next_app=False):
    output = SCRATCH / ('out-' + name)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir()
    with (output / 'collector.stdout').open('w') as clog, (output / 'app.stdout').open('w') as alog:
        receiver = subprocess.Popen(['bun', str(HERE / 'collector.ts'), str(output)], cwd=ROOT,
                                    env={**BASE_ENV, 'COLLECTOR_DELAY_MS': '20'}, stdout=clog, stderr=clog)
        child = None
        try:
            port = int(wait_file(output / 'port', receiver))
            # Reserve a separate loopback HTTP boundary to observe injected context.
            from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
            import threading
            parents = []
            class Echo(BaseHTTPRequestHandler):
                def do_GET(self):
                    parents.append(self.headers.get('traceparent'))
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'ok')
                def log_message(self, *_):
                    pass
            echo = ThreadingHTTPServer(('127.0.0.1', 0), Echo)
            threading.Thread(target=echo.serve_forever, daemon=True).start()
            import socket
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                app_port = probe.getsockname()[1]
            endpoint = f'http://127.0.0.1:{port}/otlp/tok_review'
            env = {**BASE_ENV, 'OTEL_EXPORTER_OTLP_ENDPOINT': endpoint, 'PORT': str(app_port),
                   'NEXT_TELEMETRY_DISABLED': '1', 'ECHO_URL': f'http://127.0.0.1:{echo.server_port}/echo'}
            launch = args + (['-p', str(app_port)] if next_app else [])
            child = subprocess.Popen(launch, cwd=app, env=env, stdout=alog, stderr=alog)
            for _ in range(600 if next_app else 100):
                try:
                    get(f'http://127.0.0.1:{app_port}/')
                    break
                except (OSError, TimeoutError):
                    if child.poll() is not None:
                        raise RuntimeError((output / 'app.stdout').read_text())
                    time.sleep(.1)
            for path in ['/orders/42', '/rates/eur', '/fail']:
                get(f'http://127.0.0.1:{app_port}{path}')
            if next_app:
                time.sleep(7)  # Framework-owned batched exporter; no app SDK shutdown API.
            child.terminate()
            code = child.wait(timeout=20)
            if not next_app:
                assert code == 3, (name, code, (output / 'app.stdout').read_text())
                assert 'app: drained' in (output / 'app.stdout').read_text()
            time.sleep(.2)
            spans, logs = records(output / 'spans.jsonl'), records(output / 'logs.jsonl')
            assert spans and logs, (name, spans, logs)
            manual = [s for s in spans if s['name'] in ['orders.load', 'rates.load', 'orders.charge']]
            assert manual, (name, spans)
            assert all(int(s['attributes'].get('code.line.number', 0)) > 0 for s in manual)
            assert all(s['attributes']['code.file.path'].endswith(('server.ts', 'server.cjs', 'route.ts')) for s in manual), manual
            errors = [s for s in manual if s['name'] == 'orders.charge']
            assert errors and errors[0]['status'] == 'error', errors
            if next_app:
                assert all(s['attributes']['code.file.path'].startswith('/') for s in manual)
                assert all(int(s['attributes']['code.line.number']) == 4 for s in manual)
            assert any(e['name'] == 'exception' and e['attributes']['exception.stacktrace'] != '[redacted]'
                       for s in errors for e in s['events']), errors
            ids = {(s['traceId'], s['id']) for s in spans}
            assert all((l.get('traceId'), l.get('spanId')) in ids for l in logs), logs
            if name == 'bun-esm':
                clients = [s for s in spans if s['kind'] == 'client']
                assert len(clients) == 1 and parents, (clients, parents)
                assert any(s['kind'] == 'server' and s['id'] == clients[0]['parentId']
                           and s['traceId'] == clients[0]['traceId'] for s in spans)
                assert parents[0] == f"00-{clients[0]['traceId']}-{clients[0]['id']}-01"
                assert any(s['name'] == 'GET unmatched' for s in spans)
                assert not any(s['name'] == 'GET /orders/42' for s in spans)
            requests = (output / 'requests.log').read_text()
            assert '/v1/metrics' not in requests and 'decode failed' not in requests, requests
            summary = {'case': name, 'command': launch, 'exit': code, 'spans': len(spans), 'logs': len(logs),
                       'manual': [{'name': s['name'], 'code': s['attributes'], 'status': s['status']} for s in manual],
                       'outgoingTraceparents': parents}
            (OUT / f'{name}.txt').write_text(json.dumps(summary, indent=2) + '\n' + requests + '\n' + (output / 'app.stdout').read_text())
            print(f'PASS {name}: {len(spans)} spans, {len(logs)} correlated logs, exit {code}', flush=True)
            echo.shutdown()
        finally:
            if child and child.poll() is None:
                child.kill()
                child.wait()
            receiver.terminate()
            receiver.wait()


def gates():
    app = SCRATCH / 'no-deps'
    app.mkdir(exist_ok=True)
    (app / 'package.json').write_text('{"type":"module"}')
    for name, code, args in [
        ('node-esm', block('references/node.md', 1), ['node', '--import', './instrumentation.mjs', '-e', 'console.log("unconfigured app")']),
        ('node-cjs', block('references/node.md', 2), ['node', '--require', './instrumentation.cjs', '-e', 'console.log("unconfigured app")']),
        ('bun', block('references/bun.md', 1), ['bun', '--preload', './instrumentation.mjs', '-e', 'console.log("unconfigured app")']),
    ]:
        (app / ('instrumentation.cjs' if name.endswith('cjs') else 'instrumentation.mjs')).write_text(code)
        result = command(args, app)
        assert 'unconfigured app' in result
        (OUT / f'gate-{name}.txt').write_text(result)
    (app / 'instrumentation.mjs').write_text(block('references/next.md', 1))
    for runtime in ['node', 'bun']:
        env = {**BASE_ENV, 'NODE_ENV': 'production', 'NEXT_RUNTIME': 'nodejs',
               'OTEL_EXPORTER_OTLP_ENDPOINT': 'http://127.0.0.1:1/otlp/tok_review'}
        result = command([runtime, '-e', 'import("./instrumentation.mjs").then(m => m.register()).then(() => console.log("production: no SDK imports"))'], app, env)
        (OUT / f'gate-next-{runtime}.txt').write_text(result)
    print('PASS no-endpoint and production gates without SDK dependencies', flush=True)


def next_fixture():
    app = SCRATCH / 'next'
    for package in ['next', 'react', 'react-dom']:
        link(ROOT / 'apps/site/node_modules' / package, app / 'node_modules' / package)
    (app / 'instrumentation.ts').write_text(block('references/next.md', 1))
    routes = app / 'app' / '[[...path]]'
    routes.mkdir(parents=True, exist_ok=True)
    helper = block('references/tracing-helper.md', 0).replace('logs, SeverityNumber, ', '')
    helper = 'import { logs, SeverityNumber } from "@opentelemetry/api-logs";\n' + helper
    (app / 'tracing.ts').write_text(helper)
    (routes / 'route.ts').write_text('''import { traced, log } from "../../tracing";
export async function GET(req: Request) {
  try {
    return await traced(new URL(req.url).pathname === "/fail" ? "orders.charge" : "orders.load", async () => {
      log("next request");
      if (new URL(req.url).pathname === "/fail") throw new Error("declined");
      return new Response("ok");
    }, { "code.file.path": `${process.cwd()}/app/[[...path]]/route.ts`, "code.line.number": 4 });
  } catch { return new Response("failed", { status: 500 }); }
}
''')
    return app


if __name__ == '__main__':
    versions = command(['node', '--version'], ROOT) + command(['bun', '--version'], ROOT)
    (OUT / 'versions.txt').write_text(versions)
    gates()
    for name, args in [
        ('node-esm', ['node', '--import', './instrumentation.ts', 'server.ts']),
        ('node-cjs', ['node', '--require', './instrumentation.cjs', 'server.cjs']),
        ('bun-esm', ['bun', '--preload', './instrumentation.ts', 'server.ts']),
        ('bun-cjs', ['bun', '--preload', './instrumentation.cjs', 'server.cjs']),
    ]:
        app = prepare('node-cjs' if name == 'bun-cjs' else name)
        exercise(name, app, args)
    app = next_fixture()
    for runtime in ['node', 'bun']:
        exercise('next-' + runtime, app, [runtime, 'node_modules/next/dist/bin/next', 'dev', '--webpack'], True)
