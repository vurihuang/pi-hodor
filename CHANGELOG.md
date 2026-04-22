# Changelog

## 0.3.0 - 2026-04-22

### Added
- Retry silent `stop` responses that happen immediately after a normal user message when the assistant emits no visible output.
- Add focused auto-continue tests for silent-stop retries and ESM import safety.

### Changed
- Extract auto-continue stop-reason detection into `auto-continue.ts` to keep the extension entrypoint smaller and easier to verify.
- Use `fileURLToPath(import.meta.url)` for the bundled config path so the extension loads cleanly in ESM contexts.
- Update README behavior docs to reflect the broader default retry coverage.
