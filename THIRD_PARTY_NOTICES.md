# Third-party notices

Harness is built from, and ships, software written by others. This file lists
the major components and their licenses. The complete, generated inventory of
every bundled package (JavaScript and Python) with its license text is
`THIRD_PARTY_LICENSES.txt`, produced by `npm run package` and shipped inside
each build.

## OpenWork — MIT

Harness is a fork of [OpenWork](https://github.com/different-ai/openwork)
(upstream commit `917f672a705e5fbb56cd64a34ab4e39e7ae44e49`). The desktop app,
UI, local server and supporting packages in this repository are derived from
it. OpenWork's enterprise edition (the `ee/` directory, under a separate
source-available license) is **not** part of Harness.

```
MIT License

Copyright (c) 2026 Different AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Hindsight — MIT

The local memory engine is [Hindsight](https://github.com/vectorize-io/hindsight)
(`hindsight-api-slim` 0.10.1), vendored unmodified in `vendor/hindsight/` from
commit `ccfe85b4851957ac2adf88b4a9ddf9668b2882f1` (see
`vendor/hindsight/VENDORED.md`).

```
MIT License

Copyright (c) 2025 Vectorize AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other bundled runtimes

| Component | Role in Harness | License |
|---|---|---|
| [OpenCode](https://github.com/anomalyco/opencode) | Agent engine (bundled sidecar binary) | MIT |
| [Electron](https://www.electronjs.org/) / Chromium | Desktop shell | MIT (Electron); BSD-3-Clause and others (Chromium, see `LICENSES.chromium.html` in builds) |
| [CPython](https://www.python.org/) via [python-build-standalone](https://github.com/astral-sh/python-build-standalone) | Runs the memory engine | PSF License 2.0 |
| [PostgreSQL](https://www.postgresql.org/) via [pg0](https://github.com/vectorize-io/pg0) | Memory engine database (embedded) | PostgreSQL License; pg0: MIT |
| [pgvector](https://github.com/pgvector/pgvector) | Vector search for memory | PostgreSQL License |

Each of these, and every npm and PyPI package in a build, appears with its full
license text in `THIRD_PARTY_LICENSES.txt`.
