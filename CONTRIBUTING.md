# Contributing to Harness

Thanks for contributing. Please read these two short sections before opening a
pull request.

## 1. Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying the
[Developer Certificate of Origin v1.1](https://developercertificate.org/):

```
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your@email>` trailer asserting that
you wrote the change (or otherwise have the right to submit it) and that you
may submit it under this repository's licenses. Pull requests with unsigned
commits cannot be merged.

## 2. How your contribution is licensed

Everything in this repository is under the [MIT license](./LICENSE).
Contributions are accepted under the same license (inbound = outbound),
certified by your DCO sign-off. You keep ownership of your contribution.

## Practical notes

- Use pnpm, never npm or yarn.
- Keep diffs as small as possible; propose the simpler solution.
- Runtime-observable changes need test evidence on the PR (see `AGENTS.md`).
- Never commit secrets, credentials, or personal data.
