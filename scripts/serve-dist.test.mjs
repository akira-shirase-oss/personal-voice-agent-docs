// The _headers rules serve-dist applies, and the storage pins the privacy check
// enforces: blocks apply in file order, `*` matches anything, a specific rule
// can override a `/*` value for one header name, and every stored entry must be
// a pinned key, in its pinned area, holding Starlight's own shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseHeaders, headersFor } from './serve-dist.mjs';
import { storageVerdict } from './lib/allowed-storage.mjs';
import { spawnDistServer, verifyNonce } from './lib/preview-server.mjs';
import { isCspRefusal } from './lib/csp-probe.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SERVE_DIST = join(ROOT, 'scripts', 'serve-dist.mjs');

test('every matching rule applies, later rules winning per header', () => {
	const rules = parseHeaders(`/*\n  X-One: a\n  X-Two: b\n\n/*.md\n  Content-Type: text/markdown\n`);
	const html = headersFor(rules, '/guide/');
	assert.equal(html['X-One'], 'a');
	assert.equal(html['X-Two'], 'b');
	assert.equal(html['Content-Type'], undefined, 'no .md rule on a page');
	const md = headersFor(rules, '/guide.md');
	assert.equal(md['X-One'], 'a', '/* still applies');
	assert.equal(md['Content-Type'], 'text/markdown');
});

test('a wildcard inside a pattern only matches what it covers', () => {
	const rules = parseHeaders(`/api/*\n  X-Api: yes\n`);
	assert.equal(headersFor(rules, '/api/reference/')['X-Api'], 'yes');
	assert.equal(headersFor(rules, '/other/')['X-Api'], undefined);
});

test('comments and blank lines carry no rule', () => {
	const rules = parseHeaders(`# a comment\n\n/*\n  X-One: a\n\n# another\n`);
	assert.equal(rules.length, 1);
	assert.deepEqual(rules[0].headers, [['X-One', 'a']]);
});

test('the shipped _headers gives every path its CSP and markdown its type', () => {
	const file = join(ROOT, 'dist', '_headers');
	if (!existsSync(file)) return; // before the first build there is nothing to parse
	const rules = parseHeaders(readFileSync(file, 'utf8'));
	const page = headersFor(rules, '/quick-start/');
	assert.match(page['Content-Security-Policy'] ?? '', /script-src 'self' 'wasm-unsafe-eval' 'sha256-/, 'the build filled the inline-script hashes');
	assert.equal(page['Referrer-Policy'], 'no-referrer');
	const md = headersFor(rules, '/quick-start.md');
	assert.equal(md['Content-Type'], 'text/markdown; charset=utf-8');
});

// ---- The storage pins: a key only Starlight could write, in its area, in its shape. ----

test('the theme key only lives in localStorage as light, dark or empty', () => {
	assert.equal(storageVerdict('localStorage', 'starlight-theme', 'dark'), null);
	assert.equal(storageVerdict('localStorage', 'starlight-theme', ''), null, 'empty is auto');
	assert.ok(storageVerdict('sessionStorage', 'starlight-theme', 'dark'), 'wrong area');
	assert.ok(storageVerdict('localStorage', 'starlight-theme', '{"accent":"blue"}'), 'a payload is not the theme');
});

test('the sidebar key only lives in sessionStorage as Starlight\'s state object', () => {
	const good = JSON.stringify({ i: '07funsf', open: { '07funsf': true, abc: false }, scroll: 213 });
	assert.equal(storageVerdict('sessionStorage', 'sl-sidebar-state', good), null);
	assert.ok(storageVerdict('localStorage', 'sl-sidebar-state', good), 'wrong area — it must die with the tab');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', 'true'), 'not JSON');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', '{"i":"x","open":"all","scroll":0}'), 'open must be a map of booleans');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', '{"i":"x","open":{},"scroll":"0"}'), 'scroll must be a number');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', '{"i":"x","open":{}}'), 'missing scroll');
});

test('any other key fails wherever it is found', () => {
	for (const area of ['localStorage', 'sessionStorage']) {
		assert.ok(storageVerdict(area, 'recent-searches', '[]'), `${area}: a new key is a fail, not a warning`);
		assert.ok(storageVerdict(area, 'pagefind-filters', '{}'));
		assert.ok(storageVerdict(area, 'user-id', 'x'));
	}
});

// ---- The spawned server is only ever trusted after it echoes its nonce. ----

test('a spawned serve-dist answers on its printed port with the run\'s nonce', async () => {
	const { proc, base, nonce } = spawnDistServer(SERVE_DIST);
	try {
		const url = await base;
		assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/, 'it prints the bound address, not the requested one');
		assert.equal(await verifyNonce(url, nonce), true, 'the spawn echoes its own nonce');
	} finally {
		proc.kill();
	}
});

test('a pre-existing listener that never echoes the nonce is refused', async () => {
	// The stale-daemon case: something already answers on the port, but it is not
	// this run's spawn — the check must refuse to browse it.
	const dummy = createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>stale</html>'));
	dummy.listen(0, '127.0.0.1');
	await new Promise((r) => dummy.once('listening', r));
	try {
		const base = `http://127.0.0.1:${dummy.address().port}`;
		assert.equal(await verifyNonce(base, randomUUID()), false, 'a foreign listener is refused, never browsed');
	} finally {
		dummy.close();
	}
});

test('a serve-dist spawned without a nonce is refused too', async () => {
	// Before nonces: the same server, but nothing marks it as this run's.
	const proc = spawn(process.execPath, [SERVE_DIST, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
	try {
		const base = await new Promise((resolve, reject) => {
			let buf = '';
			const timer = setTimeout(() => reject(new Error('no address printed')), 10_000);
			proc.stdout.on('data', (d) => {
				buf += d;
				const m = buf.match(/https?:\/\/[^\s]+/);
				if (m) {
					clearTimeout(timer);
					resolve(m[0].replace(/\/$/, ''));
				}
			});
			proc.on('exit', (code) => {
				clearTimeout(timer);
				reject(new Error(`exited ${code}`));
			});
		});
		assert.equal(await verifyNonce(base, randomUUID()), false, 'a pre-nonce serve-dist does not verify');
	} finally {
		proc.kill();
	}
});

// ---- The CSP probes: the refusal is the pass, any other error is not. ----

test('a CSP violation error is the expected refusal; other errors are not', () => {
	assert.ok(isCspRefusal(new Error("EvalError: Executing inline script violates the following Content Security Policy directive 'script-src'")), 'the thrown refusal counts as blocked');
	assert.ok(isCspRefusal(new Error('Refused to load the script because of the content security policy directive')), 'the refused-to-load phrasing also counts');
	assert.equal(isCspRefusal(new Error('page.goto: net::ERR_CONNECTION_REFUSED')), false, 'an unrelated error is a failure, not a pass');
	assert.equal(isCspRefusal(new TypeError('Cannot read properties of null')), false);
	assert.equal(isCspRefusal('a plain string'), false);
	assert.equal(isCspRefusal(undefined), false);
});
