#!/usr/bin/env node
// Serves dist/ the way Cloudflare Pages serves it: static files plus the headers
// dist/_headers declares. astro preview does not send _headers, so the privacy
// check drives its browser against this instead — the CSP, Referrer-Policy and
// the rest it tests are the real deployed values, not a local approximation.
//
//   node scripts/serve-dist.mjs --port 58668
//
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
// opens a block, the indented `Name: value` lines after it are its headers.
// Blank lines and `#` comments are skipped. `*` is Cloudflare's only wildcard
// and matches anything, slashes included.
export function parseHeaders(file) {
	const rules = [];
	let current = null;
	for (const line of file.split('\n')) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue;
		if (/^\s/.test(line)) {
			const at = line.indexOf(':');
			if (at !== -1) current?.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
			continue;
		}
		const pattern = line.trim();
		const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
		current = { pattern, regex, headers: [] };
		rules.push(current);
	}
	return rules;
}

// The headers a path is served with: every matching rule applies in file order,
// later rules overriding an earlier `/*` per header name.
export function headersFor(rules, path) {
	const out = new Map();
	for (const rule of rules) {
		if (!rule.regex.test(path)) continue;
		for (const [name, value] of rule.headers) out.set(name.toLowerCase(), [name, value]);
	}
	return Object.fromEntries([...out.values()].map(([name, value]) => [name, value]));
}

export function serveDir(dist, rules, port, host = '127.0.0.1') {
	const root = normalize(dist);
	const server = createServer((req, res) => {
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
	const at = process.argv.indexOf('--port');
	const port = Number(at === -1 ? 0 : process.argv[at + 1]) || 58668;
	const rules = existsSync(join(DIST, '_headers')) ? parseHeaders(readFileSync(join(DIST, '_headers'), 'utf8')) : [];
	serveDir(DIST, rules, port);
	console.log(`serving ${DIST} on http://127.0.0.1:${port}`);
}
