"""Stand-in for `claude -p` in runner tests.

argv[1] = mode: ok | fail | flaky | sleep
For `flaky`, a state file (argv[2]) makes the first call fail, later calls succeed.
The prompt is always the last argument.
"""
import pathlib
import sys
import time

mode = sys.argv[1]
if mode == "ok":
    print("ran fine")
    sys.exit(0)
if mode == "fail":
    print("boom", file=sys.stderr)
    sys.exit(1)
if mode == "flaky":
    marker = pathlib.Path(sys.argv[2])
    if marker.exists():
        print("recovered")
        sys.exit(0)
    marker.write_text("tried")
    sys.exit(1)
if mode == "sleep":
    time.sleep(5)
    sys.exit(0)
