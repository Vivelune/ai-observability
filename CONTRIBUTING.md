# Contributing

## Branches
`main` is always working. Work on short-lived branches: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.

## Commits (Conventional Commits)
`<type>(<scope>): <what and why, imperative>`
Types: feat, fix, docs, chore, refactor, test. Scopes: sdk, ingest, worker, web, infra, docs, loadtest.
Example: `feat(ingest): validate span batches with shared zod schema`

## Pull requests
One PR per branch, even when self-reviewed. Fill in the PR template, link the ADR if you made a decision, and make sure `pnpm lint`, `pnpm test` and `pnpm build` pass before merging (squash merge).

## Decisions
Significant choices get an ADR in `docs/decisions/` (copy `0000-template.md`).

## Branch model
The long-lived working branch on GitHub is `ai-observability`. Create feature branches from it, open PRs back into it, and keep it passing `pnpm lint`, `pnpm test` and `pnpm build`.

```
git switch ai-observability
git pull
git switch -c feat/<topic>
# work, commit in small steps
git push -u origin feat/<topic>
# open a PR into ai-observability, squash merge
```
