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
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = resolve(new URL('..', import.meta.url).pathname);
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

// A step gets PVA_STEP_TIMEOUT seconds (default 300 — the first pva_start may
// build the service from source), then the watchdog fires SIGALRM at the
// driver. The trap writes <i>.timeout naming the step and `kill -9 0`s the
// whole process group: the step's own children — a sleeper, a drain, a
// voice-session that never got its shutdown — die with it. The driver must
// run as its own group leader; runDriver spawns it detached.
export function driverLines(suite, suiteSteps, dir, { stepTimeout = 300 } = {}) {
	const lines = [
		'set -uo pipefail',
		'shopt -s expand_aliases',
		`cd ${JSON.stringify(workdir)}`,
		`export PVA_WORK=${JSON.stringify(workdir)}`,
		`trap 'echo "$PVA_STEP_I" > "$PVA_STEP_MARK" 2>/dev/null; kill -9 0' ALRM`,
	];
	for (const [i, step] of suiteSteps) {
		// The watchdog is push-based: the sleep's own exit runs `kill -ALRM`, so
		// the bound fires even when the driver is blocked inside a builtin (a
		// fifo open in pva_send) where a reaping-based poll would stay blind to
		// an expired sleep. The subshell writes the sleep's pid to a file the
		// driver reads at step end: kill the subshell AND its sleep by name.
		// A TERM landing before the pid reaches the file leaves an inert orphan
		// that can only sleep-then-die — bounded by the bound, group-killable.
		lines.push(
			`export PVA_STEP_I=${i} PVA_STEP_MARK=${JSON.stringify(join(dir, `${i}.timeout`))} PVA_WATCHPID=${JSON.stringify(join(dir, `${i}.watchpid`))}`,
			`( sleep ${stepTimeout} & echo "$!" > "$PVA_WATCHPID"; wait; kill -ALRM $$ ) >/dev/null 2>&1 & step_watch=$!`,
		);
		if (step.kind === 'script') {
			lines.push(`. ${JSON.stringify(join(ROOT, step.path))} ${step.args}`);
		} else {
			const stepFile = join(dir, `${i}.sh`);
			writeFileSync(stepFile, step.code + '\n');
			lines.push(`. ${JSON.stringify(stepFile)} > ${JSON.stringify(join(dir, `${i}.out`))} 2> ${JSON.stringify(join(dir, `${i}.err`))}; echo $? > ${JSON.stringify(join(dir, `${i}.status`))}`);
		}
		// Subshell first (it can only fire once), then its sleep by recorded
		// pid. The file appears a beat after spawn — wait it out briefly.
		lines.push(
			'kill "$step_watch" 2>/dev/null',
			'for _ in 1 2 3 4 5 6 7 8 9 10; do p=$(cat "$PVA_WATCHPID" 2>/dev/null || echo 0); case "$p" in ""|0|*[!0-9]*) sleep 0.02 ;; *) kill "$p" 2>/dev/null; break ;; esac; done',
			'wait "$step_watch" 2>/dev/null',
		);
	}
	// Anything a step left running is a direct job of this shell: TERM it, then
	// KILL, then reap. Otherwise the children keep the driver's pipes open past
	// exit and the runner hangs on them — the failure this bound exists for.
	lines.push(
		'kill $(jobs -p) 2>/dev/null || true',
		'wait 2>/dev/null || true',
		'kill -9 $(jobs -p) 2>/dev/null || true',
		'wait 2>/dev/null || true',
	);
	return lines;
}

// The suite driver detached in its own process group, bounded: on the suite
// timeout the GROUP is killed, never just bash — a step's orphaned children
// cannot keep the output pipes open or outlive the runner (the failure that
// left a voice-session running for 14 h). timedOut distinguishes the bound
// firing from the driver dying on its own.
export function runDriver(path, timeoutMs) {
	return new Promise((resolvePromise) => {
		const child = spawn('bash', [path], { detached: true });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// The group is already gone.
			}
		}, timeoutMs);
		child.on('error', (error) => {
			clearTimeout(timer);
			resolvePromise({ status: null, signal: null, timedOut, stdout, stderr, error, pid: child.pid });
		});
		child.on('close', (status, signal) => {
			clearTimeout(timer);
			resolvePromise({ status, signal, timedOut, stdout, stderr, pid: child.pid });
		});
	});
}

// An env-provided bound: a finite number of at least 1, else the default.
// `sleep ${NaN}` would exit instantly and fire a false timeout on step 0.
function bound(value, fallback) {
	const n = Number(value ?? fallback);
	return Number.isFinite(n) && n >= 1 ? n : fallback;
}

// Every <i>.timeout marker the driver left behind for THIS suite's steps,
// translated into one line per step that hung — the file and the step number.
// The marker dir is shared, so a later suite must not re-report earlier ones.
export function timeoutReports(dir, suiteSteps) {
	const mine = new Set(suiteSteps.map(([index]) => index));
	const tail = (path, lines) => {
		try {
			return readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).slice(-lines);
		} catch {
			return [];
		}
	};
	return readdirSync(dir)
		.filter((name) => name.endsWith('.timeout'))
		.map((name) => Number(name.slice(0, -'.timeout'.length)))
		.filter((i) => mine.has(i))
		.sort((a, b) => a - b)
		.map((i) => {
			const found = suiteSteps.find(([index]) => index === i);
			const where = found ? relative(ROOT, found[1].file) : 'unknown file';
			// A blocked step often writes nothing before dying — the step's own
			// stderr and the service's are the only witnesses to its cause.
			const stepErr = tail(join(dir, `${i}.err`), 5);
			const serviceErr = found?.[1].suite === 'session' ? tail(join(workdir, 'session', 'err'), 5) : [];
			const detail = [
				...stepErr.map((line) => `    step stderr: ${line}`),
				...serviceErr.map((line) => `    service stderr: ${line}`),
			];
			return `snippets: ${where} — step ${i} timed out; it and its process group were killed`
				+ (detail.length ? `\n${detail.join('\n')}` : '');
		});
}

async function runAll(steps) {
	const dir = join(ROOT, '.snippets', 'run');
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	mkdirSync(workdir, { recursive: true });
	// The session suite needs a real voice-session: fail up front, not mid-driver on stale output.
	if (bySuiteHas(steps, 'session')) {
		// The driver runs from $PVA_WORK, not the repo — a relative PVA_DIR or
		// PVA_BIN resolves there, not here. Resolve both against the repo root
		// now, or pva_build's cargo can't find the checkout and the service
		// never spawns (CI's step-1 hang: pva_send then blocks on the fifo).
		if (process.env.PVA_BIN) {
			process.env.PVA_BIN = resolve(ROOT, process.env.PVA_BIN);
		}
		if (process.env.PVA_DIR) {
			process.env.PVA_DIR = resolve(ROOT, process.env.PVA_DIR);
		}
	}
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
		const stepTimeout = bound(process.env.PVA_STEP_TIMEOUT, 300);
		const suiteTimeout = bound(process.env.PVA_SUITE_TIMEOUT_MS, 1_500_000);
		const driver = join(dir, `suite-${suite}.sh`);
		writeFileSync(driver, driverLines(suite, suiteSteps, dir, { stepTimeout }).join('\n') + '\n');
		const result = await runDriver(driver, suiteTimeout);
		const reports = timeoutReports(dir, suiteSteps);
		for (const report of reports) {
			console.error(report);
			failed++;
		}
		if (result.timedOut) {
			console.error(`snippets: the "${suite}" suite ran past its ${Math.round(suiteTimeout / 60_000)} min bound — its whole process group was killed`);
			failed++;
		} else if (reports.length === 0 && (result.error || result.signal || result.status !== 0)) {
			console.error(`snippets: the "${suite}" session died (${result.error ?? result.signal ?? result.status}): ${(result.stderr ?? '').slice(-200)}`);
			failed++;
		}
		for (const [i, step] of suiteSteps) {
			if (step.kind !== 'run') continue;
			const outFile = join(dir, `${i}.out`);
			const statusFile = join(dir, `${i}.status`);
			if (!existsSync(statusFile)) {
				// A step with a .timeout marker was already reported by name —
				// it ran and hung, so "never ran" is the wrong number for it.
				if (existsSync(join(dir, `${i}.timeout`))) continue;
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

export async function main() {
	const steps = readSteps();
	if (flag('coverage')) process.exit(coverage());
	if (flag('list')) {
		for (const [i, step] of steps.entries()) console.log(`${i}\t${step.suite}\t${relative(ROOT, step.file)}\t${step.kind === 'script' ? step.path : step.code.split('\n')[0]}`);
		process.exit(0);
	}
	const failed = await runAll(steps);
	console.log(`snippets: ${failed === 0 ? 'every block ran and matched' : `${failed} failure(s)`}`);
	process.exit(failed ? 1 : 0);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
