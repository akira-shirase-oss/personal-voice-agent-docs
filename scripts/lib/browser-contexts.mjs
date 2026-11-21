// The two Chromium contexts the privacy check drives, split on purpose. The
// privacy context enforces the site's real CSP — that policy is the thing
// under test, so it must never run with bypassCSP. The accessibility context
// bypasses it only so axe-core can inject: axe's script tag is an inline
// script the site's own script-src rightly refuses, and accessibility is
// independent of the CSP. A test pins the split so the security subject is
// never the weakened context.
export function privacyContextOptions() {
	return {
		ignoreHTTPSErrors: true,
		// Code-block copy buttons write the clipboard; granted so the handler runs.
		permissions: ['clipboard-read', 'clipboard-write'],
	};
}

export function axeContextOptions() {
	return { ignoreHTTPSErrors: true, bypassCSP: true };
}
