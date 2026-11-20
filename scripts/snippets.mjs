#!/usr/bin/env node
// Runs the docs' examples against a real voice-session and fails on any difference from what the
// pages show. The examples live in the MDX itself:
//
//   ```sh run=session                  a command, run in order in one bash session
//   ```sh run=session exit=1           a command the page shows failing: it must end with that status
//   ```json output=session             what the command before it prints; compared after
//                                        normalising session ids, digests and times
//   ```text output=session match=lines a stream: every line shown must arrive, in any order
//   {/* snippet session: snippets/session.sh */}   a script sourced at that point
//
// The session suite drives the real service binary over the protocol: snippets/session.sh defines
// pva_build / pva_start / pva_send / pva_expect / pva_stop on top of bash coproc. The binary is
// built from PVA_DIR (a product checkout — CI makes one; locally, your clone) unless PVA_BIN
// points at a built voice-session.
//
//   node scripts/snippets.mjs                       check every block (needs PVA_DIR or PVA_BIN)
//   node scripts/snippets.mjs --update              write what ran into the pages' output blocks
//   node scripts/snippets.mjs --list                print the steps without running them
//   node scripts/snippets.mjs --coverage            count every code block: run, a checked output,
//                                                   or `not-run="reason"`; fails on any other block
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DOCS = join(ROOT, 'src/content/docs');
const SUITES = ['session'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at === -1 ? fallback : args[at + 1];
};
const only = option('suite', '');
const workdir = resolve(option('cwd', join(ROOT, '.snippets/work')));

// ---------------------------------------------------------------- reading the pages

function mdxFiles(dir) {
	return readdirSync(dir)
		.flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? mdxFiles(path) : path.endsWith('.mdx') ? [path] : [];
		})
		.sort();
}

const FENCE = /^([ \t]*)(`{3,})([\w-]*)([^\n]*)\n([\s\S]*?)\n\1\2[ \t]*$/gm;
export const fences = (text) => [...text.matchAll(FENCE)];
const COMMENT = /\{\/\*\s*snippet\s+([\w-]+):\s*(\S+)((?:\s+[^\s*]\S*)*)\s*\*\/\}/g;
const meta = (text, key) => text.match(new RegExp(`(?:^|\\s)${key}=("([^"]*)"|\\S+)`))?.[2] ?? text.match(new RegExp(`(?:^|\\s)${key}=(\\S+)`))?.[1];

function readSteps() {
	const steps = [];
	for (const file of mdxFiles(DOCS)) {
		const text = readFileSync(file, 'utf8');
		const found = [];
		for (const match of text.matchAll(FENCE)) {
			const [, indent, , lang, info, body] = match;
			const run = meta(info, 'run');
			const output = meta(info, 'output');
			if (!run && !output) continue;
			const code = body
				.split('\n')
				.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
				.join('\n');
			found.push({ at: match.index, kind: run ? 'run' : 'output', suite: run ?? output, lang, info, code, file, start: match.index, end: match.index + match[0].length, indent, raw: match[0] });
		}
		for (const match of text.matchAll(COMMENT)) {
			found.push({ at: match.index, kind: 'script', suite: match[1], path: match[2], args: (match[3] ?? '').trim(), file });
		}
		found.sort((a, b) => a.at - b.at);
		for (const step of found) {
			if (step.kind === 'output') {
				const previous = steps.findLast((candidate) => candidate.suite === step.suite);
				if (!previous || previous.kind !== 'run' || previous.expect) throw new Error(`${relative(ROOT, file)}: an output block with no command before it`);
				previous.expect = step;
			} else {
				steps.push(step);
			}
		}
	}
	for (const step of steps) if (!SUITES.includes(step.suite)) throw new Error(`${relative(ROOT, step.file)}: unknown suite "${step.suite}"`);
	return steps;
}

// ---------------------------------------------------------------- comparing output

/** What is compared: values that differ on every run become placeholders. */
export function normalise(text) {
	return text
		.replace(/\\r\\n/g, '\\n')
		.replace(/\r\n/g, '\n')
		.replaceAll(workdir, '<work>')
		.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<session>')
		.replace(/\b[0-9a-f]{16}\b/g, '<digest>')
		.replace(/\b[0-9a-f]{64}\b/g, '<hex64>')
		.replace(/\b[0-9a-f]{40}\b/g, '<commit>')
		.replace(/^([bcdlps-][rwx-]{9})[@+]/gm, '$1') // an `ls -l` mode's ACL/attribute marker
		.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>')
		.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?Z?/g, '<time>')
		.replace(/[ \t]+$/gm, '')
		.trim();
}

/** Whole-text equality; with `match=lines`, every line shown must be among the lines that arrived. */
export function matches(actual, expect) {
	if (meta(expect.info ?? '', 'match') !== 'lines') return normalise(actual) === normalise(expect.code);
	const seen = new Set(normalise(actual).split('\n'));
	return normalise(expect.code)
		.split('\n')
		.filter((line) => line.trim() !== '')
		.every((line) => seen.has(line));
}

// ---------------------------------------------------------------- running

function bySuiteHas(steps, suite) {
	return steps.some((step) => step.suite === suite && step.kind === 'run');
}

function runAll(steps) {
	const dir = join(ROOT, '.snippets', 'run');
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	mkdirSync(workdir, { recursive: true });
	// The session suite needs a real voice-session: fail up front, not mid-driver on stale output.
	if (bySuiteHas(steps, 'session') && !process.env.PVA_BIN) {
		const pvaDir = process.env.PVA_DIR ?? join(ROOT, '..', 'personal-voice-agent');
		if (!existsSync(join(pvaDir, 'Cargo.toml'))) {
			console.error(`snippets: the "session" suite needs a voice-session — set PVA_DIR to a product checkout (looked in ${pvaDir}) or PVA_BIN to a built binary`);
			return 1;
		}
		process.env.PVA_DIR = pvaDir;
	}
	// One bash session per suite: sourced scripts (the session helpers) and state carry across the
	// suite's blocks; each run= block's own stdout and status are captured separately.
	const bySuite = new Map();
	for (const [i, step] of steps.entries()) {
		if (!bySuite.has(step.suite)) bySuite.set(step.suite, []);
		bySuite.get(step.suite).push([i, step]);
	}
	let failed = 0;
	const pending = [];
	for (const suite of SUITES) {
		const suiteSteps = bySuite.get(suite);
		if (!suiteSteps || (only && suite !== only)) continue;
		const lines = ['set -uo pipefail', 'shopt -s expand_aliases', `cd ${JSON.stringify(workdir)}`, `export PVA_WORK=${JSON.stringify(workdir)}`];
		for (const [i, step] of suiteSteps) {
			if (step.kind === 'script') {
				lines.push(`. ${JSON.stringify(join(ROOT, step.path))} ${step.args}`);
			} else {
				const stepFile = join(dir, `${i}.sh`);
				writeFileSync(stepFile, step.code + '\n');
				lines.push(`. ${JSON.stringify(stepFile)} > ${JSON.stringify(join(dir, `${i}.out`))} 2> ${JSON.stringify(join(dir, `${i}.err`))}; echo $? > ${JSON.stringify(join(dir, `${i}.status`))}`);
			}
		}
			const driver = join(dir, `suite-${suite}.sh`);
		writeFileSync(driver, lines.join('\n') + '\n');
		const result = spawnSync('bash', [driver], { encoding: 'utf8', timeout: 1_800_000 });
		if (result.error || result.status !== 0) {
			console.error(`snippets: the "${suite}" session died (${result.error ?? result.status}): ${(result.stderr ?? '').slice(-200)}`);
			failed++;
		}
		for (const [i, step] of suiteSteps) {
			if (step.kind !== 'run') continue;
			const outFile = join(dir, `${i}.out`);
			const statusFile = join(dir, `${i}.status`);
			if (!existsSync(statusFile)) {
				console.error(`snippets: ${relative(ROOT, step.file)} — step ${i} never ran (the session died first)`);
				failed++;
				continue;
			}
			const actual = readFileSync(outFile, 'utf8');
			const status = Number(readFileSync(statusFile, 'utf8').trim());
			const want = Number(meta(step.info ?? '', 'exit') ?? 0);
			if (status !== want) {
				console.error(`snippets: ${relative(ROOT, step.file)} — step ${i} wanted exit ${want}, got ${status}`);
				failed++;
			}
			if (step.expect) {
				if (flag('update')) {
					pending.push([step.expect, actual]);
				} else if (!matches(actual, step.expect)) {
					console.error(`snippets: ${relative(ROOT, step.file)} — output of step ${i} differs from the page`);
					failed++;
				}
			}
		}
	}
	return failed + applyUpdates(pending);
}

// Updates are applied after the whole run, per file, latest block first — rewriting an earlier
// block must not shift the offsets of the ones after it.
function applyUpdates(pending) {
	const byFile = new Map();
	for (const [expect, actual] of pending) {
		if (!byFile.has(expect.file)) byFile.set(expect.file, []);
		byFile.get(expect.file).push([expect, actual]);
	}
	for (const [file, edits] of byFile) {
		let text = readFileSync(file, 'utf8');
		for (const [expect, actual] of edits.sort((a, b) => b[0].start - a[0].start)) {
			const head = expect.raw.slice(0, expect.raw.indexOf('\n') + 1);
			const tail = expect.raw.slice(expect.raw.lastIndexOf('\n'));
			const shown = actual.trimEnd().split('\n').map((line) => expect.indent + line).join('\n');
			text = text.slice(0, expect.start) + head + shown + tail + text.slice(expect.end);
		}
		writeFileSync(file, text);
	}
	return 0;
}

// ---------------------------------------------------------------- coverage

function coverage() {
	let run = 0, output = 0, notRun = 0, todo = 0, unmarked = 0;
	for (const file of mdxFiles(DOCS)) {
		const text = readFileSync(file, 'utf8');
		for (const match of text.matchAll(FENCE)) {
			const info = match[4];
			if (meta(info, 'run') || meta(info, 'output')) {
				if (meta(info, 'run')) run++;
				else output++;
			} else if (meta(info, 'not-run') !== undefined) {
				notRun++;
				if ((meta(info, 'not-run') ?? '').startsWith('todo:')) {
					todo++;
					console.error(`snippets: ${relative(ROOT, file)} — not-run="todo: ${meta(info, 'not-run').slice(5)}"`);
				}
			} else {
				unmarked++;
				console.error(`snippets: ${relative(ROOT, file)} — an unmarked code block: ${match[5].split('\n')[0]}`);
			}
		}
	}
	console.log(`snippets: ${run} run, ${output} checked output, ${notRun} not-run (${todo} todo), ${unmarked} unmarked`);
	return unmarked > 0 ? 1 : 0;
}

// ----------------------------------------------------------------

export function main() {
	const steps = readSteps();
	if (flag('coverage')) process.exit(coverage());
	if (flag('list')) {
		for (const [i, step] of steps.entries()) console.log(`${i}\t${step.suite}\t${relative(ROOT, step.file)}\t${step.kind === 'script' ? step.path : step.code.split('\n')[0]}`);
		process.exit(0);
	}
	const failed = runAll(steps);
	console.log(`snippets: ${failed === 0 ? 'every block ran and matched' : `${failed} failure(s)`}`);
	process.exit(failed ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
