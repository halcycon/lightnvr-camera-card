# lightNVR camera card

This repository implements the plan in `lightnvr-camera-card-plan.md`: a HACS Dashboard custom card using an existing lightNVR server and its managed go2rtc instance.

- Keep the public project free of real NVR hosts, credentials, camera URLs, SDP, and private recovery records.
- Follow the assigned task's exclusive ownership and verified dependencies. Do not edit adjacent tasks, shared contracts/manifests after T1, or the plan without coordinator assignment.
- Workers must use the supplied private run gate before meaningful work; stop on hold or stale monitor. Do not delegate recursively, stage, commit, push, or deploy.
- The user explicitly authorized full-access worker tools (`--sandbox danger-full-access --ask-for-approval never`). File ownership and lifecycle checks still apply.
- Use only generated/owned local media and isolated test services for automated tests. Do not contact or mutate the user's production NVR/cameras from the supplied example credentials.
- Report actual checks as passed, failed, or unavailable. Browser mocks do not establish real lightNVR protocol compatibility or physical camera talk.
- Preserve lightNVR's authentication, action grants, privacy, and per-direction audio policies. No raw public go2rtc proxy or fallback around a denial.
- `.execution/` is private and ignored. It must never be staged or published.
