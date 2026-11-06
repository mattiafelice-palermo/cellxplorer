# 090 — Scoped scientific cache compatibility review

Independent GPT-6 Astra, Medium: no actionable findings.

Verified the original 1.6.5 change did not modify calc.py or
time_capacity_derived.py. Compatibility stays limited to the explicit Neware
1.6.4/1.6.5 pair at the same source hash and parser identity. Exact artifacts win;
BioLogic and unknown generations remain isolated. Prepared fallback validates the
candidate's actual calculation version, raw fingerprint, layout, schema and bytes.
Fresh writes retain current versions.

Seven new regression tests include nine format/version fixture combinations,
startup work selection, selective prepared reads, unchanged file identities and
bytes, result-key isolation and rejection of unknown or mismatched artifacts.
A portable round-trip regression confirms an older compatible cache is not rebuilt.
Independent reverse-version and corrupt-preferred-prepared/valid-compatible
checks also pass without regeneration. Invalid cycle bytes retain the existing
reader failure rather than being silently accepted. No live profile was modified.

Canonical preflight status is recorded in the related specification.
