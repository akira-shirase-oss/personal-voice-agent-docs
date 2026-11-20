#!/usr/bin/env node
// Generates src/data/protocol.json from the product's docs/PROTOCOL.md — the reference's data.
// Parses the two message tables ("App → service", "Service → app") and the enum lines
// (slot kinds, failure reasons, outcomes, confirmation reasons) into a typed document.
// scripts/check-protocol.mjs then keeps the result honest against the wire itself.
//
//   PVA_DIR=../personal-voice-agent node scripts/gen-protocol.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'src/data/protocol.json');
const PRODUCT = process.env.PVA_DIR ?? new URL('../../personal-voice-agent', import.meta.url).pathname;
const PROTOCOL_MD = join(PRODUCT, 'docs/PROTOCOL.md');
const REMOTE = 'https://raw.githubusercontent.com/akira-shirase-oss/personal-voice-agent/main/docs/PROTOCOL.md';

/** Backticked names at depth 0 — field names, not the values inside () or {}. */
function fields(cell) {
	const names = [];
	let depth = 0;
	let current = '';
	let inTick = false;
	for (const ch of cell) {
		if (ch === '`') {
			if (inTick && depth === 0 && current) names.push(current);
			inTick = !inTick;
			current = '';
		} else if (inTick) current += ch;
		else if (ch === '(' || ch === '{') depth++;
		else if (ch === ')' || ch === '}') depth--;
	}
	return names;
}

/** Backticked names anywhere — for the enum lines' value lists. */
function values(text) {
	return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** The rows of a `| type | Fields | Meaning |` table inside a `## heading` section. */
function table(source, heading) {
	const at = source.indexOf(heading);
	if (at === -1) return [];
	const section = source.slice(at, source.indexOf('\n## ', at + 1) === -1 ? undefined : source.indexOf('\n## ', at + 1));
	const rows = {};
	for (const line of section.split('\n')) {
		const match = line.match(/^\|\s*((?:`[^`]+`,?\s*)+)\|\s*([^|]*)\|\s*([^|]*)\|/);
		if (!match || match[1].startsWith('`type`')) continue;
		for (const type of values(match[1])) rows[type] = { fields: fields(match[2].trim()), meaning: match[3].trim() };
	}
	return rows;
}

export function parse(source) {
	const enums = {};
	for (const line of source.split('\n')) {
		if (line.startsWith('Slot kinds:')) enums.slot_kinds = values(line);
		else if (line.startsWith('Provider failure reasons:')) enums.provider_failure_reasons = values(line.split(';')[0]);
		else if (line.startsWith('Outcomes:')) enums.turn_outcomes = values(line);
		else if (line.startsWith('Confirmation `reasons`:')) enums.confirmation_reasons = values(line);
	}
	return {
		source: 'docs/PROTOCOL.md (v1)',
		framing: { format: 'JSON lines over stdin/stdout', max_line_bytes: 65536, first_message: 'hello' },
		app_to_service: table(source, '## App → service'),
		service_to_app: table(source, '## Service → app'),
		enums,
	};
}

export async function main() {
	let source;
	if (existsSync(PROTOCOL_MD)) {
		source = readFileSync(PROTOCOL_MD, 'utf8');
	} else {
		console.error(`gen-protocol: no local product tree at ${PRODUCT}; fetching PROTOCOL.md from GitHub`);
		const response = await fetch(REMOTE);
		if (!response.ok) {
			console.error(`gen-protocol: could not read PROTOCOL.md (HTTP ${response.status})`);
			process.exit(1);
		}
		source = await response.text();
	}
	const doc = parse(source);
	writeFileSync(OUT, JSON.stringify(doc, null, '\t') + '\n');
	const count = Object.keys(doc.app_to_service).length + Object.keys(doc.service_to_app).length;
	console.log(`gen-protocol: wrote ${OUT} — ${count} message types from PROTOCOL.md`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
