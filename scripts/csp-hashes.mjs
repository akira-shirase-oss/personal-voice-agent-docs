#!/usr/bin/env node
// Computes the sha256 of every inline <script> in dist/ and writes the result into dist/_headers,
// so Cloudflare's CSP can keep script-src 'self' plus these hashes instead of 'unsafe-inline'.
// New or changed inline scripts need a build again; that's the point (anything not hashed is blocked).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = process.env.DIST ?? new URL('../dist', import.meta.url).pathname;
const SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

const hashes = new Set();
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path);
		else if (name.endsWith('.html')) {
			for (const [, code] of readFileSync(path, 'utf8').matchAll(SCRIPT)) {
				hashes.add(`'sha256-${createHash('sha256').update(code).digest('base64')}'`);
			}
		}
	};
};
walk(DIST);

const file = join(DIST, '_headers');
const lines = readFileSync(file, 'utf8').split('\n');
const marker = "INLINE_SCRIPT_HASHES";
let touched = 0;
const out = lines.map((line) => {
	if (!line.includes(marker)) return line;
	touched++;
	return line.replaceAll(marker, [...hashes].join(' '));
});
if (touched === 0) {
	console.error('csp-hashes: no INLINE_SCRIPT_HASHES marker in dist/_headers');
	process.exit(1);
}
writeFileSync(file, out.join('\n'));
console.log(`csp-hashes: ${hashes.size} inline script hash(es) into ${relative(process.cwd(), file)}`);
