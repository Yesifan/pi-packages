# Changesets

Every pull request that changes a published package must include a changeset unless the change is
only documentation, tests, or CI configuration:

```bash
pnpm changeset
```

Select the affected packages, choose the SemVer bump, and describe the user-visible change. Commit
the generated Markdown file with the pull request. On `main`, the release workflow collects these
files into a version pull request. Merging that pull request publishes the changed packages.
