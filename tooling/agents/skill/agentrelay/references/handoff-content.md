# Handoff content template

Use these sections in this order. Leave out a section only when it would be empty, except Code State, which is always present for work in a repository.

```markdown
## Objective
One or two sentences: what the receiver should achieve.

## Task Context
What has happened so far and why: decisions made, approaches ruled out, relevant files, links, error messages.
Quote exact code, commands and output in fenced blocks.

## Code State
- Project: <project>
- Branch: <branch, or "detached HEAD">
- Base commit: <full baseCommit>
- Pushed: <yes | no, the commit exists only on the sending device>
- Uncommitted changes: <none | the listed files; they are not included in this handoff>

## Proposed Plan
The approach the receiver should take, step by step.

## Next Steps
- [ ] First concrete action
- [ ] ...
- [ ] How to verify the result

## Constraints
Rules the receiver must keep: files not to touch, commands not to run, approvals still needed.
```

Notes:

- Write for a reader with no access to this conversation. Spell out names, paths and decisions.
- Keep secrets out: no tokens, passwords, private keys or personal data, even if they appeared in the conversation.
- Images travel as `attachmentIds`; refer to them in the content by order ("image 1 shows the error dialog").
