# Contributing to SettleX

Thanks for helping improve SettleX. Contributions are welcome through GitHub issues and pull requests.

## Before you start

1. Check the existing issues and pull requests to avoid duplicating work.
2. For a substantial change, open or comment on an issue with your proposed approach and wait for a maintainer to confirm it is in scope. This lets maintainers assign or claim the work clearly.
3. For a good first issue, comment that you would like to work on it and wait for a maintainer to assign it or acknowledge your claim before starting.
4. For security vulnerabilities, follow [SECURITY.md](SECURITY.md); do not report them in a public issue.

## Local setup

- Use Node.js 20 and npm 10 (the version in `package.json` is npm 10.8.2).
- Install dependencies with `npm ci`.
- Copy `.env.local.example` to `.env.local` and fill in the values needed for the feature you are working on. Never commit `.env.local` or real credentials.
- Run the app with `npm run dev`.
- For contract work, use the commands and setup described in the root README's Smart Contract section and `contract/Cargo.toml`.

## Branches and commits

- Branch from the current `main` branch and keep each branch focused on one issue or change.
- Name issue branches `issue-<number>-<short-kebab-case-description>` (for example, `issue-302-update-guides`). For work without an issue, use `feature/<short-kebab-case-description>` or `fix/<short-kebab-case-description>`.
- Use clear, imperative commit subjects. Conventional prefixes such as `docs:`, `fix:`, `feat:`, `test:`, and `chore:` are encouraged.

## Pull requests and required checks

- Open a pull request against `main`. Link the issue it addresses and explain the user-visible change, implementation notes, and any follow-up work.
- Keep the diff focused, update relevant documentation, and include or update tests when behavior changes.
- Before requesting review, run and pass:

  ```sh
  npm run typecheck && npm run lint && npm test && npm run build
  ```

- The GitHub Actions CI workflow must pass, including the frontend quality job and Rust contract tests when the change affects them. Address review feedback and keep the branch current with `main` before merge.
- Do not merge your own pull request unless a maintainer has explicitly approved that process.

## Code and community

Be respectful, assume good intent, and follow the project's [Code of Conduct](CODE_OF_CONDUCT.md).
