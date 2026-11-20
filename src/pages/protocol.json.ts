import type { APIRoute } from 'astro';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The protocol reference's data at /protocol.json — the document check-protocol.mjs keeps in
 *  sync both ways with the service's golden lines. */
export const GET: APIRoute = () =>
	new Response(readFileSync(join(process.cwd(), 'src/data/protocol.json'), 'utf8'), {
		headers: { 'Content-Type': 'application/json' },
	});
