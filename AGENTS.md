## Commands

- `bun test` — bun test runner
- `bun run typecheck` — strict TS check, no emit
- `bun run lint` — `oxlint` across repo
- `bun run fmt:check` — read-only format verification
- `bun run fmt:fix` — apply `oxfmt`

## Design Principles

- **No shortcuts**: every rule here exists because skipping it caused real harm. Corners cut now bite later. Follow the pattern even when it feels like overhead — especially then.

- **Deep modules, narrow interfaces** (Ousterhout, _A Philosophy of Software Design_)

- **Hexagonal Architecture**: services declare deps as local interfaces.
