# Changelog

All notable changes to this project will be documented in this file.

<!-- git-cliff-unreleased-start -->

## 0.1.3 - **not yet released**

### 🚀 Features

- **qc-logging:** Add qc logging and basic type utils ([#3](https://github.com/apify/apify-actor-utils/pull/3)) ([bb9461e](https://github.com/apify/apify-actor-utils/commit/bb9461e5811f0dbf7e49bd9b850ecd66d62a7a04)) by [@JuanGalilea](https://github.com/JuanGalilea)

### SafePushData

- Restrict placeholders to empty values, prefer null for unions ([fd698a8](https://github.com/apify/apify-actor-utils/commit/fd698a8150470d2e82f7b127336dabb1bcbda60a)) by [@claude](https://github.com/claude)

### gteam-internal

- Add a new `./gteam-internal` subpath export with its own `safePushData`, wrapping `Actor.pushData`/`Dataset.pushData` directly instead of taking a `pushFn`
- Consolidate all tests onto Vitest (drops the separate `node:test` suite)

<!-- git-cliff-unreleased-end -->

## [0.1.2](https://github.com/apify/apify-actor-utils/releases/tag/v0.1.2) (2026-07-22)

## [0.1.1](https://github.com/apify/apify-actor-utils/releases/tag/v0.1.1) (2026-07-22)
