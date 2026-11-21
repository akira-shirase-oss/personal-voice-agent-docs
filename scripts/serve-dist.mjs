#!/usr/bin/env node
// Serves dist/ the way Cloudflare Pages serves it: static files plus the headers
// dist/_headers declares. astro preview does not send _headers, so the privacy
// check drives its browser against this instead — the CSP, Referrer-Policy and
// the rest it tests are the real deployed values, not a local approximation.
//
//   node scripts/serve-dist.mjs --port 58668 [--nonce <value>]
//
// With --nonce, every response carries X-Serve-Dist-Nonce: the privacy check
// spawns the server on port 0 with a fresh nonce and verifies the echo before
// it browses, so a stale or foreign listener can never stand in for it.
// The header parser is exported for scripts/serve-dist.test.mjs.
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.wasm': 'application/wasm',
	'.woff2': 'font/woff2',
	'.webmanifest': 'application/manifest+json',
};

// Parse a Cloudflare _headers file into rules, in file order: a bare path line
// opens a block, the indented `Name: value` lines after it are its headers, and
// an indented `! Name` line detaches a header a wider rule set. Blank lines and
// `#` comments are skipped. `*` is Cloudflare's only wildcard and matches
// anything, slashes included. The file Cloudflare itself would reject is
// rejected here too — at most 100 rules, at most 2000 characters a line — so
// what this test server applies is exactly what the deploy will.
export function parseHeaders(file) {
	const rules = [];
	let current = null;
	for (const line of file.split('\n')) {
		if (line.length > 2000) throw new Error('_headers: a line exceeds Cloudflare\'s 2000-character limit');
		if (!line.trim() || line.trimStart().startsWith('#')) continue;
		if (/^\s/.test(line)) {
			const body = line.trim();
			if (body.startsWith('!')) {
				const name = body.slice(1).trim().replace(/:$/, '');
				if (name) current?.detaches.push(name.toLowerCase());
				continue;
			}
			const at = body.indexOf(':');
			if (at !== -1) current?.headers.push([body.slice(0, at).trim(), body.slice(at + 1).trim()]);
			continue;
		}
		const pattern = line.trim();
		const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
		current = { pattern, regex, headers: [], detaches: [] };
		rules.push(current);
		if (rules.length > 100) throw new Error('_headers: more than Cloudflare\'s 100-rule limit');
	}
	return rules;
}

// The headers a path is served with: every matching rule applies in file order.
// The same header name across matching rules joins with ", " the way Cloudflare
// unions them — a later rule does not erase an earlier value — and a `!` line
// removes the name from what is accumulated so far.
export function headersFor(rules, path) {
	const out = new Map();
	for (const rule of rules) {
		if (!rule.regex.test(path)) continue;
		for (const name of rule.detaches) out.delete(name);
		for (const [name, value] of rule.headers) {
			const key = name.toLowerCase();
			const had = out.get(key);
			out.set(key, [name, had ? `${had[1]}, ${value}` : value]);
		}
	}
	return Object.fromEntries([...out.values()].map(([name, value]) => [name, value]));
}

export function serveDir(dist, rules, port, host = '127.0.0.1', nonce = null) {
	const root = normalize(dist);
	const server = createServer((req, res) => {
		// The nonce marks the server itself, not the response's success — a 404
		// from a clean checkout is still this spawn answering, and verifyNonce
		// must be able to tell it from anything else.
		if (nonce) res.setHeader('X-Serve-Dist-Nonce', nonce);
		const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
		// _headers is deploy config, not content — Cloudflare never serves it.
		let rel = path.replace(/^\/+/, '');
		if (rel === '_headers') {
			res.writeHead(404).end('not found');
			return;
		}
		let file = normalize(join(root, rel));
		if (file !== root && !file.startsWith(root + sep)) {
			res.writeHead(404).end('not found');
			return;
		}
		if (existsSync(file) && statSync(file).isDirectory()) {
			// The site builds trailingSlash:always — a bare directory redirects to it.
			if (!path.endsWith('/')) {
				res.writeHead(301, { Location: `${path}/` });
				res.end();
				return;
			}
			file = join(file, 'index.html');
		}
		if (!existsSync(file) || !statSync(file).isFile()) {
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
			return;
		}
		const headers = headersFor(rules, path);
		const sent = new Set(Object.keys(headers).map((n) => n.toLowerCase()));
		if (!sent.has('content-type')) headers['Content-Type'] = TYPES[extname(file)] ?? 'application/octet-stream';
		res.writeHead(200, headers);
		if (req.method === 'HEAD') {
			res.end();
			return;
		}
		createReadStream(file).pipe(res);
	});
	server.listen(port, host);
	return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const arg = (name) => {
		const at = process.argv.indexOf(name);
		return at === -1 ? null : process.argv[at + 1];
	};
	// Port 0 is a real request — any free port, the bound one printed on listen.
	const given = arg('--port');
	const port = given === null ? 58668 : Number(given);
	const nonce = arg('--nonce');
	// --dist serves another tree: the privacy check's known-bad fixtures use it.
	const dist = arg('--dist') ?? DIST;
	const rules = existsSync(join(dist, '_headers')) ? parseHeaders(readFileSync(join(dist, '_headers'), 'utf8')) : [];
	const server = serveDir(dist, rules, port, '127.0.0.1', nonce);
	server.on('listening', () => console.log(`serving ${dist} on http://127.0.0.1:${server.address().port}`));
}
