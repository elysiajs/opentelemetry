# 1.3.1 - 13 Jul 2025
Improvement:
- [#48](https://github.com/elysiajs/opentelemetry/pull/48) add test suite and update dependencies
- set name after response as fallback

Bug fix:
- [#47](https://github.com/elysiajs/opentelemetry/pull/47), [#49](https://github.com/elysiajs/opentelemetry/pull/49) avoid race condition "Cannot execute operation on ended Span"

# 1.3.0-exp.0 - 23 Apr 2025
Change:
- Add support for Elysia 1.3


# 1.2.0-rc.0 - 23 Dec 2024
Change:
- Add support for Elysia 1.2

# 1.1.7 - 31 Oct 2024
Change:
- remove auto-node-instrumenetation by default

# 1.1.6 - 10 Oct 2024
Improvement:
- setTimeout reference hack to prevent gc

Feature:
- export `getCurrentSpan`, `setAttributes`

Bug fix:
- possibly setTimeout memory leak

# 1.1.5 - 5 Sep 2024
Feature:
- add provenance publish

# 1.1.4 - 19 Aug 2024
- Negate isInitialized

# 1.1.3 - 19 Aug 2024
Bug fix:
- Support bun build --minify-identifiers

# 1.1.2 - 4 Aug 2024
Bug fix:
- Check nullability of rootSpan

# 1.1.1 - 16 July 2024
Bug fix:
- Cast startActiveSpan and record as same as `@opentelemetry/api` package.
