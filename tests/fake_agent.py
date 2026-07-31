"""Stand-in for `claude -p` in runner tests.

argv[1] = mode: ok | fail | flaky | sleep
For `flaky`, a state file (argv[2]) makes the first call fail, later calls succeed.
The prompt is always the last argument.
"""
import pathlib
import subprocess
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
if mode == "spawn_orphan":
    # Spawns a long-sleeping grandchild, records its pid, then sleeps itself —
    # used to prove a timeout kills the whole process group, not just us.
    marker = pathlib.Path(sys.argv[2])
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    marker.write_text(str(child.pid))
    time.sleep(30)
    sys.exit(0)
