### Added

- An agent can wait for news of a GitHub pull request: a failed check, all checks passed, a new
  comment by someone else, a merge conflict, or the merge. OpenBot reads the pull request every two
  minutes with your GitHub connection and continues the agent's request when there is news. A merge
  or a close ends the wait.
