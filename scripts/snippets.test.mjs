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
