// What a CSP probe's outcome means. When the policy refuses a script or a fetch,
// Playwright can surface that refusal as an evaluation error whose message names
// the directive — that error is the expected result, not a check failure. Any
// other error is a real failure.
export function isCspRefusal(err) {
	return /Content Security Policy/i.test(String(err?.message ?? err));
}
