// Unit tests for the snippet machinery's pure parts: fence/meta reading, output normalisation and
// the two comparison modes. The end-to-end proof is the CI suite running every block for real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, matches, fences } from './snippets.mjs';

test('session ids, digests and times normalise', () => {
	const line = '{"type":"ready","session":"c9f8b7a6-1234-4abc-9def-0123456789ab","protocol":1}';
	assert.equal(normalise(line), '{"type":"ready","session":"<session>","protocol":1}');
	assert.equal(normalise('"digest":"0123456789abcdef"'), '"digest":"<digest>"');
	assert.equal(normalise('at 2026-11-20T08:53:12Z ok'), 'at <time> ok');
});

test('a whole output must equal the page; match=lines tolerates extras', () => {
	const page = { info: '', code: '{"type":"pong","seq":1}' };
	assert.equal(matches('{"type":"pong","seq":1}\n', page), true);
	assert.equal(matches('{"type":"pong","seq":2}\n', page), false);
	const stream = { info: ' match=lines', code: '{"type":"turn_opened","turn":1}\n{"type":"capture","turn":1,"on":true}' };
	assert.equal(matches('{"type":"turn_opened","turn":1}\n{"type":"capture","turn":1,"on":true}\n{"type":"extra"}', stream), true);
	assert.equal(matches('{"type":"turn_opened","turn":1}', stream), false);
});

test('fences finds indented blocks and their info strings', () => {
	const page = 'text\n\n   ```sh run=session\n   pva_send "{}"\n   ```\nmore\n';
	const found = fences(page);
	assert.equal(found.length, 1);
	assert.equal(found[0][3], 'sh');
	assert.match(found[0][4], /run=session/);
	assert.equal(found[0][5].trim(), 'pva_send "{}"');
});

// ---------------------------------------------------------------- the runner's bounds

// A step that never finishes must be killed — with the whole process group it spawned, so no
// child outlives the driver — and reported by name. This is the red main from the session
// suite: pva_start's children held the driver's stderr open past the CI timeout and were left
// running for hours.
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { driverLines, runDriver, timeoutReports, ROOT } from './snippets.mjs';

const scratch = () => mkdtempSync(join(ROOT, '.snippets', 'test-'));

const dead = (pid) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
};

// kill(0) on a just-killed process can succeed while it is still an unreaped
// zombie (or hit a recycled pid): poll a bounded window instead of checking once.
const deadSoon = async (pid, ms = 3000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (dead(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
};

test('a hanging step is killed with its whole process group and reported', async () => {
	const dir = scratch();
	try {
		const step = { kind: 'run', suite: 'session', code: `sleep 60 & echo $! > "${join(dir, 'sleeper.pid')}"\nwait`, info: '', file: join(ROOT, 'src/content/docs/fake.mdx'), start: 0, end: 0, indent: '', raw: '' };
		writeFileSync(join(dir, '0.sh'), step.code + '\n');
		writeFileSync(join(dir, 'driver.sh'), driverLines('session', [[0, step]], dir, { stepTimeout: 1 }).join('\n') + '\n');
		const result = await runDriver(join(dir, 'driver.sh'), 30_000);
		assert.equal(result.timedOut, false, 'the step bound fires before the suite bound');
		assert.ok(existsSync(join(dir, '0.timeout')), 'a marker names the timed-out step');
		const sleeper = Number(readFileSync(join(dir, 'sleeper.pid'), 'utf8').trim());
		assert.ok(await deadSoon(sleeper), 'the step\'s child was killed with the group');
		const reports = timeoutReports(dir, [[0, step]]);
		assert.equal(reports.length, 1);
		assert.match(reports[0], /fake\.mdx/);
		assert.match(reports[0], /step 0/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the suite-level bound kills the driver\'s process group', async () => {
	const dir = scratch();
	try {
		const script = `sleep 60 & echo $! > "${join(dir, 'sleeper.pid')}"\nwait\n`;
		writeFileSync(join(dir, 'driver.sh'), script);
		const result = await runDriver(join(dir, 'driver.sh'), 400);
		assert.equal(result.timedOut, true);
		const sleeper = Number(readFileSync(join(dir, 'sleeper.pid'), 'utf8').trim());
		assert.ok(await deadSoon(sleeper), 'nothing outlives the driver');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a leftover child cannot hold the driver\u2019s pipes past the last step', async () => {
	// The CI hang itself: every step completes, but the child a step spawned
	// keeps bash's stderr open — the trailer reaps it so close still fires.
	const dir = scratch();
	try {
		const step = { kind: 'run', suite: 'session', code: `sleep 60 & echo $! > "${join(dir, 'sleeper.pid')}"`, info: '', file: join(ROOT, 'src/content/docs/fake.mdx'), start: 0, end: 0, indent: '', raw: '' };
		writeFileSync(join(dir, '0.sh'), step.code + '\n');
		writeFileSync(join(dir, 'driver.sh'), driverLines('session', [[0, step]], dir, { stepTimeout: 10 }).join('\n') + '\n');
		const started = Date.now();
		const result = await runDriver(join(dir, 'driver.sh'), 30_000);
		assert.ok(Date.now() - started < 15_000, 'close fires once the trailer reaps the leftover child');
		assert.equal(result.timedOut, false);
		const sleeper = Number(readFileSync(join(dir, 'sleeper.pid'), 'utf8').trim());
		assert.ok(await deadSoon(sleeper), 'the leftover child is reaped');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a finished step\u2019s watchdog leaves no stray child in the group', async () => {
	// Killing a watchdog must kill its `sleep` too: an orphaned one lingers for
	// the whole step bound in the driver's process group. An empty group is the
	// assertion — process.kill(-pgid, 0) keeps succeeding while any member lives.
	// The 0.2 s steps give the watchdog a beat to record its sleep's pid.
	const dir = scratch();
	try {
		const mk = (code) => ({ kind: 'run', suite: 'session', code, info: '', file: join(ROOT, 'src/content/docs/fake.mdx'), start: 0, end: 0, indent: '', raw: '' });
		const suiteSteps = [[0, mk('sleep 0.2')], [1, mk('sleep 0.2')]];
		writeFileSync(join(dir, 'driver.sh'), driverLines('session', suiteSteps, dir, { stepTimeout: 20 }).join('\n') + '\n');
		const result = await runDriver(join(dir, 'driver.sh'), 30_000);
		assert.equal(result.status, 0);
		const deadline = Date.now() + 5000;
		for (;;) {
			try {
				process.kill(-result.pid, 0);
				assert.ok(Date.now() < deadline, 'a stray child outlived its watchdog in the driver group');
				await new Promise((r) => setTimeout(r, 50));
			} catch (e) {
				if (e.code === 'ESRCH') return; // the group is empty — every watchdog died with its step
				throw e;
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
