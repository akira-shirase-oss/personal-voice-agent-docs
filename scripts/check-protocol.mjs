#!/usr/bin/env node
// The protocol reference's contract with the wire it describes. src/data/protocol.json is generated
// from docs/PROTOCOL.md by scripts/gen-protocol.mjs; this check keeps it honest by comparing it both
// ways against the golden lines the Rust and Swift suites both decode:
//
//   - every "type" in fixtures/protocol/client.jsonl (app→service) and service.jsonl
//     (service→app) must exist in the doc, in the right direction;
//   - every type the doc declares must have a golden line;
//   - the top-level fields a doc entry lists must equal the union of fields the golden
//     lines of that type carry (a field nobody ever sends is drift; one the wire sends
//     and the doc omits is a hole).
//
// Reads the product's fixtures via PVA_DIR (a local checkout or the copy CI makes), else fetches
// them from the product's default branch on GitHub.
//
//   node scripts/check-protocol.mjs                     local tree via PVA_DIR, else fetch
//   PVA_DIR=../personal-voice-agent node scripts/check-protocol.mjs
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const SPEC = join(ROOT, 'src/data/protocol.json');
const PRODUCT = process.env.PVA_DIR ?? new URL('../../personal-voice-agent', import.meta.url).pathname;
const FILES = { app_to_service: 'fixtures/protocol/client.jsonl', service_to_app: 'fixtures/protocol/service.jsonl' };
const REMOTE = (file) => `https://raw.githubusercontent.com/akira-shirase-oss/personal-voice-agent/main/${file}`;

/** type → union of the fields its golden lines carry (minus "type"). */
export function wireTypes(jsonl) {
	const types = {};
	for (const line of jsonl.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const message = JSON.parse(trimmed);
		const entry = (types[message.type] ??= new Set());
		for (const key of Object.keys(message)) if (key !== 'type') entry.add(key);
	}
	return types;
}

export function compare(doc, wire, direction) {
	const bad = [];
	const documented = doc[direction] ?? {};
	for (const [type, fields] of Object.entries(wire)) {
		if (!documented[type]) bad.push(`${direction}: wire type "${type}" is missing from the reference`);
		else {
			const have = new Set(documented[type].fields);
			for (const field of fields) if (!have.has(field)) bad.push(`${direction}: "${type}" sends "${field}" the reference doesn't list`);
			for (const field of have) if (!fields.has(field)) bad.push(`${direction}: the reference gives "${type}" a "${field}" no golden line carries`);
		}
	}
	for (const type of Object.keys(documented)) if (!wire[type]) bad.push(`${direction}: the reference declares "${type}" but no golden line has it`);
	return bad;
}

export async function main() {
	const doc = JSON.parse(readFileSync(SPEC, 'utf8'));
	const bad = [];
	for (const [direction, file] of Object.entries(FILES)) {
		let jsonl;
		const local = join(PRODUCT, file);
		if (existsSync(local)) {
			jsonl = readFileSync(local, 'utf8');
		} else {
			console.error(`check-protocol: no local product tree at ${PRODUCT}; fetching ${file} from GitHub`);
			const response = await fetch(REMOTE(file));
			if (!response.ok) {
				console.error(`check-protocol: could not read ${file} (HTTP ${response.status})`);
				process.exit(1);
			}
			jsonl = await response.text();
		}
		bad.push(...compare(doc, wireTypes(jsonl), direction));
	}
	for (const what of bad) console.error(`check-protocol: ${what}`);
	if (bad.length === 0) {
		const count = Object.keys(doc.app_to_service).length + Object.keys(doc.service_to_app).length;
		console.log(`check-protocol: reference and golden lines agree on ${count} message types`);
	}
	process.exit(bad.length ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
