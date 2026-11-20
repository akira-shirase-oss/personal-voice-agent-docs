#!/usr/bin/env bash
# The session suite's helpers: run a real voice-session over the protocol and let the pages show
# its answers verbatim. Sourced by a {/* snippet session: snippets/session.sh */} marker.
#
# Every run= block is its own bash process, so the session survives across blocks through named
# pipes under $PVA_WORK/session: `in` (a sleeper holds the writer so stdin never hits EOF between
# steps) and `out` (the service's stdout). A `cat` drains `out` into `out.raw` from the start —
# the service's writer task dies on EPIPE, so stdout must always have a reader, exactly like the
# real app. `pva_expect` then polls `out.raw` for the next unseen line.
#
#   pva_build          build voice-session from $PVA_DIR (a product checkout) once
#   pva_start <dir>    start the service on a fresh data directory
#   pva_send <json>    write one client line to its stdin
#   pva_expect         print the next service line (waits up to $PVA_EXPECT_TIMEOUT, default 15 s)
#   pva_stop           send shutdown, stop the sleeper and drain, wait for exit
#
# PVA_BIN overrides the built path (a prebuilt voice-session). Answers are also appended to
# $PVA_WORK/session.log so the whole exchange is inspectable after the run.

pva_build() {
	if [ -z "${PVA_BIN:-}" ]; then
		: "${PVA_DIR:?set PVA_DIR to a personal-voice-agent checkout, or PVA_BIN to a built binary}"
		cargo build -p voice-session --manifest-path "$PVA_DIR/Cargo.toml"
		PVA_BIN="$PVA_DIR/target/debug/voice-session"
	fi
	export PVA_BIN
}

pva_start() {
	pva_build
	local w="${PVA_WORK:-.}/session"
	rm -rf "$w"
	mkdir -p "$w"
	mkfifo "$w/in" "$w/out"
	local dir="${1:-${PVA_WORK:-.}/data}"
	mkdir -p "$dir"
	# The writer first: opening `in` for read (the service) blocks until a writer exists.
	# tail -f /dev/null holds the write end forever, portably (BSD has no `sleep infinity`).
	tail -f /dev/null >"$w/in" &
	echo "$!" >"$w/sleeper"
	# And the reader: the service opens `out` for write and its writer task dies on EPIPE, so a
	# drain must be attached before it starts and stay attached for the whole session.
	: >"$w/out.raw"
	cat "$w/out" >>"$w/out.raw" &
	echo "$!" >"$w/drain"
	echo 0 >"$w/seen"
	"$PVA_BIN" --data-dir "$dir" <"$w/in" >"$w/out" 2>"$w/err" &
	echo "$!" >"$w/pid"
	echo "$dir" >"$w/data"
}

pva_send() {
	printf '%s\n' "$1" >>"${PVA_WORK:-.}/session/in"
}

pva_expect() {
	local w="${PVA_WORK:-.}/session" line seen deadline
	seen="$(cat "$w/seen")"
	deadline=$((SECONDS + ${PVA_EXPECT_TIMEOUT:-15}))
	while true; do
		line="$(sed -n "$((seen + 1))p" "$w/out.raw")"
		if [ -n "$line" ]; then
			echo $((seen + 1)) >"$w/seen"
			printf '%s\n' "$line" | tee -a "${PVA_WORK:-.}/session.log"
			return 0
		fi
		if [ "$SECONDS" -ge "$deadline" ]; then
			echo "pva_expect: no service line within ${PVA_EXPECT_TIMEOUT:-15} s" >&2
			return 1
		fi
		sleep 0.05
	done
}

pva_stop() {
	local w="${PVA_WORK:-.}/session" pid
	pid="$(cat "$w/pid")"
	pva_send '{"type":"shutdown"}' || true
	for _ in $(seq 40); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.25
	done
	kill "$(cat "$w/sleeper")" "$(cat "$w/drain")" "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
}
