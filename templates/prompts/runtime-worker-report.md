In the report summary include one AC-n: met|not met — <evidence> line per criterion, in the numbered order above. Never claim an unverified criterion is met.
Publish result artifacts under "{{artifact_root}}/" and report them with their sha-256.
Finish with exactly one JSON document of schema "{{expected_schema}}" (attempt id {{attempt_id}}): either the whole final message, or one fenced json block as the last thing you write. Never output a second, different JSON document.
Report format: {{report_format}}
