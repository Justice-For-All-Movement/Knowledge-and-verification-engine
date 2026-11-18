# Standalone HTTP credential selection

A rotating credential provider must be read once per request. Previously, both Evidence and Consent adapters checked tenant/project claims from one token, then read the provider again when constructing the Authorization header. Rotation between the reads could send another scope's token. The receiving engine verifies the sent token, but that does not bind the original caller to that token's tenant/project.

The shared HTTP call now captures one credential, checks its scope and sends that exact value. A later request reads the provider again; a tenant or project change denies before transport. This is a credential-selection check, not local signature authentication, current membership verification or a distributed permission fence.

Four synthetic transport regression groups failed on accepted source 993e688136e900450fe597a0f75c3aaec4a90e99 and pass after the fix (zero failures/skips). They cover both adapters, same-scope rotation and foreign tenant/project denial. Tokens are fictional payloads; no real credentials or providers are used. Typecheck/build/registry and final-head CI qualification are recorded separately. Full real-PostgreSQL, cross-engine and installed-package qualification remain pending for this change.

No runtime imports, persistence/schema changes, engine dependency changes, sends or publication are added. PAM remains stopped at its authorized foundation regardless of other service-layer deployment documentation. Private outputs, neutral fixtures and the original 15-engine/122-task plan remain the boundaries for this continuation.
