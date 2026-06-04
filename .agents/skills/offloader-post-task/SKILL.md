---
name: offloader-post-task
description: Post-task validation checklist for the pi-content-offloader project. Run after ANY code change — fixes, features, refactors, bug hunts, config updates, type changes, or dependency updates. Ensures lint passes, types check, and tests pass.
---

# pi-content-offloader Post-Task Checklist

After EVERY code change task (fix, feature, refactor, config update, or any implementation work), run these steps in order:

```bash
bun run fix        # Biome lint/format fix
bun run check      # TypeScript type check
bun run test       # Run test suite
```

## Rules

1. Run ALL steps, in order, after completing the task and before marking it done.
2. If any step fails, fix the failure before marking the task complete.
3. Pre-existing unrelated test failures (e.g., timeouts) are acceptable — note them but don't block the task.
4. Return to the project root after the checklist.
