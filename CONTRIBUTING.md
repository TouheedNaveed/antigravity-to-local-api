# Contributing

Thanks for helping improve this bridge. Please keep changes focused and do not commit secrets.

## Setup

1. Fork the repository and clone your fork.
2. Use Node.js 22.5 or newer.
3. Copy `.env.example` to `.env`. Keep `HOST=127.0.0.1`.
4. For a running server you also need the `agy` CLI signed in. Unit tests do not need it.

```bash
cp .env.example .env
npm start
```

No `npm install` is required.

## Tests

```bash
npm test
npm run check
```

`npm run check` syntax-checks the modules and then runs the tests. Please run it before you open a pull request.

## Branch and pull request flow

1. Create a branch from `main` for one change (`fix/body-limit`, `docs/opencode`, and similar).
2. Keep the diff limited to that change.
3. Run `npm run check`.
4. Open a pull request against `main` and fill in the template.

## Never commit secrets

Do not add any of the following:

- `.env` (only `.env.example` with placeholders)
- `data/` (`keys.json`, `admin.json`, metrics databases)
- `.agy-home/`, `.orig/`
- `memory/*.sqlite*`, `memory/raw/`
- `*.key`, `*.pem`, `*.log`
- Real API keys, password hashes, tokens, or personal paths

If you paste a command or screenshot, use `agy-YOUR_KEY` and other placeholders. If a secret lands in a commit, tell the maintainers privately (see [SECURITY.md](SECURITY.md)). Do not try to hide it with a later commit on the same branch.

## Code notes

- Stay compatible with Node 22.5+ and avoid new npm dependencies unless there is a strong reason.
- Match the existing style: ESM (`.mjs`), small modules, no em dashes in user-facing copy.
- Do not weaken auth defaults (`AGY_REQUIRE_KEY`, loopback bind, dashboard CSRF and Host checks).
