# Security policy

## How to report

If you find a vulnerability in this project, please report it privately. Do not open a public issue or pull request that includes exploit details or leaked secrets.

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). If that is not available, open a security-focused draft and contact a maintainer through a private GitHub channel.

Include the affected version or commit, what you observed, and how to reproduce it. We will try to reply promptly and credit you if you want that.

## What not to commit or paste

Never commit or attach:

- `.env` files or real environment values
- `data/keys.json`, `data/admin.json`, or metrics databases
- Full API keys (`agy-` plus the secret suffix), password hashes, session cookies, or tokens
- `.agy-home/` logs, `memory/` archives, or `*.key` / `*.pem` files
- Personal home paths, usernames, or other private machine details that are not needed

`.gitignore` is set to exclude these paths. Check `git status` before you commit.

## Running the server safely

- Bind to `127.0.0.1` unless you have a separate access-control plan.
- Use dashboard API keys (`AGY_REQUIRE_KEY=1`) and store them in a mode-600 file, not in a shared config file.
- Treat the admin password and API keys as secrets. Revoke a key if it may have leaked.
- Reset a forgotten admin password by stopping the server, deleting `data/admin.json`, and setting a new password on the next start. Keys in `data/keys.json` are kept.
