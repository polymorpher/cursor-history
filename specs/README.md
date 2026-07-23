# Feature design archive

Files under `specs/` record feature requirements, implementation plans, and
historical decisions from the point when each feature was developed. They are
not the canonical CLI or library reference and may contain obsolete command
names, examples, or assumptions.

Use these current user documents instead:

- [README](../README.md)
- [Cross-machine backup and restore](../LOCAL_MIGRATION.md)
- [Changelog](../CHANGELOG.md)

For the exact command surface of the checked-out revision, run:

```bash
npm run build
node dist/cli/index.js --help
node dist/cli/index.js <command> --help
```
