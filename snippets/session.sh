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
		if [ ! -f "$PVA_DIR/Cargo.toml" ]; then
			echo "pva_build: no Cargo.toml at $PVA_DIR (resolved from $(pwd)) — set PVA_DIR to the product checkout's absolute path, or PVA_BIN to a built binary" >&2
			return 1
		fi
		cargo build -p voice-session --manifest-path "$PVA_DIR/Cargo.toml" || return 1
		PVA_BIN="$PVA_DIR/target/debug/voice-session"
	fi
	export PVA_BIN
}

# Kill whatever a previous pva_start left running — its service, sleeper and
# drain. Every pva_start reuses the same session dir; without this the earlier
# sessions' children stay alive past the suite's end holding the driver's
# pipes open (the orphan that kept a voice-session running for 14 h).
#
# The pid files may be stale — left by a run that itself died — so a pid could
# now belong to an unrelated process. Only kill a pid whose own command line
# mentions $PVA_WORK: every session child carries it (the service's data dir,
# the drain's fifo path, the sleeper's hold file). If `ps` can't answer, the
# pid isn't provably ours and is left alone; the driver's job reap is the
# fallback for children of this run.
pva_cleanup() {
	local w="${PVA_WORK:-.}/session" f p
	[ -d "$w" ] && [ -n "${PVA_WORK:-}" ] && [ "$PVA_WORK" != "." ] || return 0
	for f in pid sleeper drain; do
		[ -f "$w/$f" ] || continue
		p="$(cat "$w/$f")"
		case "$(ps -p "$p" -o args= 2>/dev/null)" in
			*"$PVA_WORK"*) kill "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null ;;
		esac
	done
	return 0
}

pva_start() {
	pva_build || return 1
	local w="${PVA_WORK:-.}/session"
	pva_cleanup
	rm -rf "$w"
	mkdir -p "$w"
	mkfifo "$w/in" "$w/out"
	local dir="${1:-${PVA_WORK:-.}/data}"
	mkdir -p "$dir"
	# The writer first: opening `in` for read (the service) blocks until a writer exists.
	# tail -f on a hold file blocks forever, portably (BSD has no `sleep infinity`),
	# and its path marks the process as ours for pva_cleanup's `ps` check.
	: >"$w/.sleeper-hold"
	tail -f "$w/.sleeper-hold" >"$w/in" &
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
	# A service that died at spawn leaves `in` with no reader — pva_send's
	# fifo open would block the whole step. Check it survived a beat; the
	# sleep's end also lets bash reap, so kill -0 tells the truth.
	sleep 0.2
	if ! kill -0 "$(cat "$w/pid")" 2>/dev/null; then
		echo "pva_start: the service exited at spawn" >&2
		[ -s "$w/err" ] && { echo "  last stderr:" >&2; tail -10 "$w/err" >&2; }
		return 1
	fi
}

pva_send() {
	local w="${PVA_WORK:-.}/session" pid
	pid="$(cat "$w/pid" 2>/dev/null || true)"
	# Opening `in` for write blocks until a reader appears — with a dead or
	# never-started service that is forever. Fail the step fast, with the
	# service's last stderr lines, rather than hang to the step bound.
	if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
		echo "pva_send: the service is not running${pid:+ (pid $pid)}" >&2
		[ -s "$w/err" ] && { echo "  last stderr:" >&2; tail -10 "$w/err" >&2; }
		return 1
	fi
	printf '%s\n' "$1" >>"$w/in"
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
	pid="$(cat "$w/pid" 2>/dev/null || true)"
	pva_send '{"type":"shutdown"}' || true
	for _ in $(seq 40); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.25
	done
	kill "$(cat "$w/sleeper")" "$(cat "$w/drain")" "$pid" 2>/dev/null || true
	# A service that ignored shutdown or died in a bad state gets a beat of
	# grace, then the KILL — nothing may outlive this function.
	for _ in $(seq 8); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.25
	done
	kill -9 "$(cat "$w/sleeper")" "$(cat "$w/drain")" "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
}
