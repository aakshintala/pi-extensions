# Use a lean Linux CI merge gate

Status: accepted

The project will use one GitHub Actions workflow with one sequential job on the hosted `ubuntu-latest` x86_64 runner. The job runs tests, the runtime audit, and provenance checks, and becomes the required merge gate once a meaningful extension package and audit exist. This deliberately excludes a macOS matrix, live provider calls, credentials, and terminal screenshot tests; parallel jobs or additional platforms can be added only when measured package behavior or CI duration justifies them.

## Considered options

- **Parallel jobs:** rejected initially because the repository has no runtime package yet and the extra setup is process without present value.
- **Pinned Ubuntu image:** rejected in favor of `ubuntu-latest` to reduce runner maintenance; image drift is accepted.
- **macOS matrix:** rejected because the package has no known native platform dependency and GitHub-hosted macOS capacity is constrained.
