# UI interactions

The DBMG theme now uses Lucide navigation icons, Radix AlertDialog confirmations,
Radix Dialog mobile navigation, and Sonner notifications. Global interaction
styles live in `apps/web/src/app/interactions.css`.

`FeedbackProvider` belongs at the root layout. `useConfirm` resolves false on
cancel, Escape, or provider unmount; concurrent confirmation requests do not
overwrite the active request. Cancel receives initial focus. `Button` exposes
pending state with a spinner, disabled state, and `aria-busy`.

`useTask` locks synchronously to prevent repeated submissions before React
renders. Profile, budget, usage, sourcing, setup editors, and template cloning
use it. Account creation and import upload retain their existing busy states
with synchronous request locks. Import mapping cannot change during a request.
Role updates retain the current role on cancellation or API failure.

Sourcing validates integer target counts (1 through 5,000) and ignores stale
estimate responses. Starting a run requires an available current estimate.
Existing endpoint payloads and backend permission checks are preserved.
Deferred card decisions retain their separate undo queue and bottom toast.

## Validation

- Web tests cover confirmation cancellation/focus, duplicate requests, retry
  after failure, role rollback, stale estimates, and keyboard drawer dismissal.
- Existing E2E scripts now confirm through accessible alert dialogs instead of
  native browser dialogs. They still require a running test API and web server.
- A separate browser preview uses real components with mocked API responses.
  Profile/sourcing/actions were checked at 320, 390, 768, and 1440 px without
  horizontal page overflow. Mobile drawer, confirmation, and success toast were
  exercised. Screenshots remain ignored under `output/playwright/`.
- This preview does not verify backend integration or production on the Mac.
  Local Next server startup was previously blocked by automatic approval review;
  full E2E verification remains outstanding.

No database migration is needed. Build/recreate only the web service after the
source changes have been reviewed and explicitly authorized for deployment.
