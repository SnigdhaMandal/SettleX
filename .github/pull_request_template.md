## Summary

<!-- What does this change do, and why? Link the issue it addresses. -->

## Change type

- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Maintenance

## Verification

Run the full required local check command before requesting review:

```sh
npm run typecheck && npm run lint && npm test && npm run build
```

- [ ] The command above passes.
- [ ] Relevant Rust contract checks (`cd contract && cargo test`) pass if contract code changed.
- [ ] I updated relevant documentation.
- [ ] I added or updated tests for behavior changes.
- [ ] I did not include secrets or local environment files.
