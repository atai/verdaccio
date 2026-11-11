---
'@verdaccio/store': patch
'@verdaccio/proxy': patch
---

Return 503 when an uplink cannot be reached for a missing tarball, recover the uplink circuit breaker after fail_timeout, and stop client disconnects during tarball caching from crashing the process.
