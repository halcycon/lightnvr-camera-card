# lightNVR camera card

This repository provides a HACS Dashboard custom card using an existing lightNVR server and its managed go2rtc instance. The server may run on a separate host.

- Keep the public project free of real NVR hosts, credentials, camera URLs, SDP, and private recovery records.
- Coordinate parallel edits using explicit file ownership and verified dependencies.
- Delegated workers must follow their assigned scope; do not delegate recursively, stage, commit, push, or deploy without assignment.
- Use only generated/owned local media and isolated test services for automated tests. Do not contact or mutate the user's production NVR/cameras from the supplied example credentials.
- Report actual checks as passed, failed, or unavailable. Browser mocks do not establish real lightNVR protocol compatibility or physical camera talk.
- Preserve lightNVR's authentication, action grants, privacy, and per-direction audio policies. No raw public go2rtc proxy or fallback around a denial.
- `.execution/` is private and ignored. It must never be staged or published.
