### Added

- An agent can wait for one event of a webhook routine, such as the failed build of one pull request.
  Only an event that matches the wait's event type and filters continues the request. Other events
  run the routine as before.
