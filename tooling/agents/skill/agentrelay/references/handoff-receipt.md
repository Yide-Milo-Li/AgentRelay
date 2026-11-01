# Completion receipt template

The `result` passed to `complete_handoff` is read by the sender. Keep it under 20,000 characters and use these three sections.

```markdown
## Summary
What was done, in two to five sentences.
- Verified: <commands or checks that passed, with their outcome>
- Not verified: <what was not checked, and why>

## Changes
- Branch: <branch>
- Commits: <short hash and subject for each commit since the base commit>
- Pushed: <yes | no>
- Pull request: <link, when there is one>
- Other changes: <files changed outside commits, settings, deployments; or "none">

## Open questions
- <decisions left for the sender, follow-up work, risks; or "none">
```

Report what actually happened. A receipt is the sender's record of the work, so do not describe checks that were not run as passing.
