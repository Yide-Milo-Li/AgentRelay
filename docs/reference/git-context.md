# Git context

A handoff can say which code state its sender stopped at, so the receiving agent starts from the same place instead of guessing:

- **Fields.** `create_handoff` takes optional `branch` and `baseCommit`, stored as `git_branch` and `git_base_commit` (`0017`). `branch` must be a name `git check-ref-format --branch` accepts (at most 200 characters; a leading `refs/heads/` is dropped) and needs `baseCommit`; `baseCommit` alone stands for a detached HEAD and must be a full 40- or 64-character hash, stored lowercase. Blank values count as none. Invalid values answer 400 before anything is written.
- **Lifecycle.** The fields are set on creation only: claiming, completing, requeueing and undoing never change them, and a reply never inherits its parent's, because work sent back usually sits on a newer commit. They are part of the idempotent payload, so a retry with a different code state answers 409.
- **Receiving.** Both MCP endpoints and the browser routes return them as they were stored. The receiver checks them against its checkout before claiming (see the Receiver SOP); the server never runs git, resolves a ref or contacts a Git host.
- **Web UI.** The detail pane shows a *Code state* row under the route: the branch, the 7-character commit (full hash in its label) and a button that copies `git fetch && git switch <branch> && git status` (or `git switch --detach <hash>`), with every value shell-quoted. Inbox rows show the branch beside the project. Neither is ever a link.
- **Not carried.** Uncommitted changes are not part of the handoff; the sender says in `content` whether there are any.
