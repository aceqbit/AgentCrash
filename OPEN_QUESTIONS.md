# OPEN_QUESTIONS

- Postgres 18 is used instead of 16 (environment fixed by the user). Decision: proceed; recorded in DECISIONS.md D1.- Sweep counts 4 points per step (20 for bank_5). P4 only fires on steps with `requires_approval`; on other steps the run completes without a crash and the row has `crashed: false`. Decision: keep 20 rows, as CLAUDE.md section 13 requires.
- Windows reports no signal for a killed child, so "died by SIGKILL" is asserted through a marker file written by the hook immediately before `process.kill(pid, 'SIGKILL')`.
- Sweep pass/fail uses only the mock effect logs (E1, E2, E3 via "never resent"). E4 is journal-internal and is asserted by the gateway integration tests, not the verifier. The `unknown` column is read from the gateway run API and is informational.
