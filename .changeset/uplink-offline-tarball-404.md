---
'@verdaccio/store': patch
'@verdaccio/proxy': patch
---

Return 503 when an uplink cannot be reached for a missing tarball, recover the uplink circuit breaker after fail_timeout, stop client disconnects during tarball caching from crashing the process, and refresh uplink metadata on a tarball miss even inside maxage so a just-published version is not a false 404.
