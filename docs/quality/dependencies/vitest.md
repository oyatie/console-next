Reason: Vitest runs the unit and gate tests (`npm test`, configured in vitest.config.ts).
Provenance: Version 5.0.5 is pinned in package-lock.json from https://registry.npmjs.org/vitest/-/vitest-5.0.5.tgz with an integrity hash, matching the registry URL recorded in dependency-verification.json; it locks @vitest/mocker 5.0.5.
License: MIT for vitest 5.0.5 and @vitest/mocker 5.0.5, as recorded in package-lock.json and by `npm view <name>@5.0.5 license`.
Security: No advisory names vitest itself; the bump moves @vitest/mocker to 5.0.5, fixing GHSA-qxg6-89mg-rqv8 (medium; vulnerable >= 5.0.0-beta.1, < 5.0.3) and GHSA-xp26-3454-mjgp (medium; vulnerable >= 5.0.0-rc.2, < 5.0.3); 5.0.5 is above the first patched 5.0.3.
