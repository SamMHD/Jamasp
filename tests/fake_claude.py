"""Stand-in for the `claude` CLI: reads ids from the prompt, emits JSON ledes."""
import json
import re
import sys

prompt = sys.argv[-1]
ids = re.findall(r"^([0-9a-f]{16})\t", prompt, flags=re.MULTILINE)
print(json.dumps({i: f"LEDE for {i}" for i in ids}))
