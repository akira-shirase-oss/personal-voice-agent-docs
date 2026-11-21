// The browser storage the docs are allowed to keep: only Starlight's own chrome
// state, each key pinned to the storage area Starlight writes and to the value
// shape it writes. Anything else — a key from another feature, the right key in
// the wrong area, or a value that is not Starlight's shape — is reader data the
// docs promised not to keep, and the privacy check fails on it.
export const ALLOWED_STORAGE = {
	// The theme choice: Starlight writes "light", "dark", or "" for auto.
	'starlight-theme': {
		area: 'localStorage',
		shape: (v) => v === '' || v === 'light' || v === 'dark',
	},
	// Which sidebar groups are open: {hash: "<id>", open: [bool, …], scroll: <px>} —
	// hash is a short base-36 group id, open a bounded list of booleans (one per
	// sidebar group; the cap is far past this site's group count), scroll a
	// finite non-negative pixel position. Only in sessionStorage — it dies with
	// the tab. Anything else in the object is not Starlight's shape.
	'sl-sidebar-state': {
		area: 'sessionStorage',
		shape: (v) => {
			try {
				const s = JSON.parse(v);
				return (
					s !== null &&
					typeof s === 'object' &&
					Object.keys(s).sort().join(',') === 'hash,open,scroll' &&
					typeof s.hash === 'string' &&
					s.hash.length <= 16 &&
					/^[0-9a-z]+$/.test(s.hash) &&
					Array.isArray(s.open) &&
					s.open.length <= 64 &&
					s.open.every((b) => typeof b === 'boolean') &&
					Number.isFinite(s.scroll) &&
					s.scroll >= 0
				);
			} catch {
				return false;
			}
		},
	},
};

// Why a stored entry is or is not allowed — the privacy check turns each verdict
// into its failure line, or stores nothing when null comes back.
export function storageVerdict(area, name, value) {
	const rule = ALLOWED_STORAGE[name];
	if (!rule) return `${area} stores ${name} — the docs keep no reader data in the browser`;
	if (rule.area !== area) return `${name} is in ${area}, not ${rule.area} — Starlight's chrome keys have fixed homes`;
	if (!rule.shape(value)) return `${area}.${name} holds ${JSON.stringify(value)?.slice(0, 80)} — not the shape Starlight writes`;
	return null;
}
