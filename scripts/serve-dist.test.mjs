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
import { privacyContextOptions, axeContextOptions } from './lib/browser-contexts.mjs';

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

test('a header name in two matching rules joins, never replaces', () => {
	// Cloudflare unions the same header across matching rules with ", " —
	// replacing would send a value the deploy never sends.
	const rules = parseHeaders(`/*\n  X-One: a\n\n/page/\n  X-One: b\n`);
	assert.equal(headersFor(rules, '/page/')['X-One'], 'a, b');
	assert.equal(headersFor(rules, '/other/')['X-One'], 'a', 'the narrow rule does not leak');
});

test('a `!` header line detaches a header an earlier rule set', () => {
	// Cloudflare detaches: `  ! Name` inside a rule removes that header for the
	// paths the rule matches, however a wider rule set it.
	const rules = parseHeaders(`/*\n  X-Frame-Options: DENY\n  X-One: a\n\n/embed/\n  ! X-Frame-Options\n`);
	assert.equal(headersFor(rules, '/embed/')['X-Frame-Options'], undefined);
	assert.equal(headersFor(rules, '/embed/')['X-One'], 'a', 'other headers still apply');
	assert.equal(headersFor(rules, '/page/')['X-Frame-Options'], 'DENY', 'the detach stays inside its rule');
});

test('Cloudflare\u2019s _headers limits are enforced, not silently applied', () => {
	// A file Cloudflare would reject must not be "applied" differently here:
	// 100 rules at most, 2000 characters a line at most.
	assert.throws(() => parseHeaders(`/*\n  X-One: ${'x'.repeat(2001)}\n`), /line/i);
	const many = Array.from({ length: 101 }, (_, i) => `/p${i}\n  X-One: a`).join('\n');
	assert.throws(() => parseHeaders(many), /100|rules/i);
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
	// The shape Starlight actually writes, observed in the crawl: a base-36 group
	// id, a bounded list of booleans, a scroll offset — and nothing else.
	const good = JSON.stringify({ hash: '07funsf', open: [true], scroll: 0 });
	assert.equal(storageVerdict('sessionStorage', 'sl-sidebar-state', good), null);
	assert.equal(
		storageVerdict('sessionStorage', 'sl-sidebar-state', JSON.stringify({ hash: 'a', open: [], scroll: 12.5 })),
		null,
		'an empty open list and a fractional scroll are still the shape',
	);
	assert.ok(storageVerdict('localStorage', 'sl-sidebar-state', good), 'wrong area — it must die with the tab');
	assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', 'true'), 'not JSON');
	for (const [what, bad] of [
		['an extra key', { hash: '07funsf', open: [true], scroll: 0, x: 1 }],
		['a string inside open', { hash: '07funsf', open: [true, 'yes'], scroll: 0 }],
		['a long hash', { hash: 'z'.repeat(17), open: [true], scroll: 0 }],
		['a non-base-36 hash', { hash: 'UPPER!', open: [true], scroll: 0 }],
		['a negative scroll', { hash: '07funsf', open: [true], scroll: -1 }],
		['a scroll that is a string', { hash: '07funsf', open: [true], scroll: '0' }],
		['open as an object', { hash: '07funsf', open: { '07funsf': true }, scroll: 0 }],
		['more open slots than the cap', { hash: '07funsf', open: Array(65).fill(false), scroll: 0 }],
	]) {
		assert.ok(storageVerdict('sessionStorage', 'sl-sidebar-state', JSON.stringify(bad)), `${what} is refused`);
	}
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

test('the nonce marks every response, including the 404s of a clean checkout', async () => {
	// On a clean checkout there is no dist/ yet: `/` is a 404, and that 404 is
	// still the spawned server answering — its nonce must echo there or
	// verifyNonce refuses the right server and the gate fails before a build.
	const { proc, base, nonce } = spawnDistServer(SERVE_DIST, { dist: join(ROOT, 'fixtures', 'empty-dist') });
	try {
		const url = await base;
		const response = await fetch(`${url}/missing-page`, { headers: { Connection: 'close' } });
		await response.arrayBuffer();
		assert.equal(response.status, 404);
		assert.equal(response.headers.get('x-serve-dist-nonce'), nonce, 'a 404 carries the nonce too');
		assert.equal(await verifyNonce(url, nonce), true, 'a dist-less spawn still verifies');
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

// ---- The context split: CSP is the subject in one, bypassed only for axe. ----

test('the privacy context never bypasses the CSP it exists to test', () => {
	const privacy = privacyContextOptions();
	assert.equal(privacy.bypassCSP, undefined, 'the security subject must run the real policy');
	assert.equal(axeContextOptions().bypassCSP, true, "only the accessibility context bypasses, for axe-core's inline injection");
});
