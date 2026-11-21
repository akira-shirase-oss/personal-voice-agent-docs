// The fixture's bad writer: the privacy crawl presses the copy button, and this
// stores a key no allowlist covers — in sessionStorage, which is per-tab, so the
// only honest read is on the tab the interaction happened on.
document.querySelector('div.copy button').addEventListener('click', () => {
	sessionStorage.setItem('recent-searches', '["consent"]');
});
