// The server the privacy check browses: serve-dist spawned on an ephemeral port
// with a per-run nonce, verified to be that spawn before a page ever loads. A
// listener that happens to be on a port — a daemon left from an earlier run, an
// unrelated dev server — is refused, never browsed.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Spawns serve-dist (port 0 → any free port, printed on stdout) with a nonce it
// echoes in a response header. `dist` serves a tree other than the real build —
// the privacy check's known-bad fixtures use it. Returns the process, its base
// URL and the nonce.
export function spawnDistServer(serveDistPath, { dist = null } = {}) {
	const nonce = randomUUID();
	const args = [serveDistPath, '--port', '0', '--nonce', nonce];
	if (dist) args.push('--dist', dist);
	const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
	const base = new Promise((resolve, reject) => {
		let buf = '';
		const timer = setTimeout(() => reject(new Error('serve-dist never printed its address')), 10_000);
		proc.stdout.on('data', (d) => {
			buf += d;
			const m = buf.match(/https?:\/\/[^\s]+/);
			if (m) {
				clearTimeout(timer);
				resolve(m[0]);
			}
		});
		proc.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error(`serve-dist exited with ${code} before printing its address`));
		});
	});
	return { proc, base: base.then((b) => b.replace(/\/$/, '')), nonce };
}

// Waits for the server to answer, then confirms the answering server is the
// spawned one by the nonce it echoes. Anything else — including a serve-dist
// from before nonces — answers without it and is refused.
export async function verifyNonce(base, nonce, attempts = 50) {
	for (let i = 0; i < attempts; i++) {
		const response = await fetch(`${base}/`, { headers: { Connection: 'close' } }).catch(() => null);
		if (response) {
			await response.arrayBuffer().catch(() => {});
			return response.headers.get('x-serve-dist-nonce') === nonce;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}
