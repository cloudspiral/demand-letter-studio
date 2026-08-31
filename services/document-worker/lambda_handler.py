"""SQS entry point. The deployed worker uses the same deterministic operations as local CLI."""

import json
from worker import dispatch


def handler(event, _context):
    results = []
    for record in event.get("Records", []):
        results.append(dispatch(json.loads(record["body"])))
    return {"results": results}
