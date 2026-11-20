#!/usr/bin/env node
// Finds every URL a reader could copy from a page — in code blocks and in prose — and fails on
// ones that would mislead. Personal Voice Agent has no HTTP API and no hosted service, so:
//
//   - http://localhost or http://127.0.0.1 is allowed only on the pages that run on this machine
//     (ALLOWED below — the quick start and the operating pages' local commands);
//   - 0.0.0.0 anywhere fails (a listen address, not one to visit);
//   - credentials or tokens in a query string fail;
//   - private IPv4 subnets (10/8, 172.16/12, 192.168/16) fail — they would leak the author's
//     network. Documentation subnets and 127/8 stay allowed;
//   - plain http anywhere else fails: every real link is https.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const DOCS = join(ROOT, 'src/content/docs');
const PAGES = join(ROOT, 'src/pages');

// Pages whose commands run on the reader's machine may show loopback addresses.
export const ALLOWED = [
	/^src\/content\/docs\/quick-start\.mdx$/,
	/^src\/content\/docs\/operating\//,
];
const LOCAL = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1)/;
const PRIVATE_V4 = /^https?:\/\/(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
const URL_IN_TEXT = /https?:\/\/[^\s"'`)\]},;>]+/g;

export function problems(text, file) {
	const bad = [];
	const local = ALLOWED.some((ok) => ok.test(file));
	for (const match of text.matchAll(URL_IN_TEXT)) {
		const url = match[0].replace(/[.,;:]+$/, '');
		if (LOCAL.test(url) && !local) bad.push(`${url} is a this-machine address on a page that isn't local`);
		else if (PRIVATE_V4.test(url)) bad.push(`${url} is a private IPv4 address — use a documentation subnet or an example name`);
		else if (/^https?:\/\/0\.0\.0\.0/.test(url)) bad.push(`${url}: 0.0.0.0 listens everywhere; it isn't an address to visit`);
		else if (/[?&](token|key|secret|sig|password)=[A-Za-z0-9]/i.test(url)) bad.push(`${url} looks like it carries a credential`);
		else if (/^http:\/\//.test(url) && !LOCAL.test(url)) bad.push(`${url} is plain http`);
	}
	return bad;
}

export function scan(dir) {
	const bad = [];
	const walk = (at) => {
		for (const name of readdirSync(at)) {
			const path = join(at, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.(mdx?|astro)$/.test(name)) {
				const file = relative(ROOT, path);
				for (const problem of problems(readFileSync(path, 'utf8'), file)) bad.push(`${file}: ${problem}`);
			}
		}
	};
	walk(dir);
	return bad;
}

export function main(dir = join(ROOT, 'src')) {
	const bad = scan(dir);
	for (const problem of bad) console.error(`check-urls: ${problem}`);
	console.log(`check-urls: ${bad.length === 0 ? 'all URLs are https or labelled-local' : `${bad.length} bad URL(s)`}`);
	process.exit(bad.length ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
