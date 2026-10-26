# Agent and contributor guidelines

Rules for anyone (human or AI agent) changing this repo. Follow them on every
change; the PR description must show they were followed.

## Engineering principles

- Simplicity first. The easiest code that correctly solves the problem wins.
  Add abstraction only when duplication or a real second use case exists.
- DRY: shared logic (constraint filtering, ranking, paging, labels) lives in
  one module with one clear contract; never re-implement rules at call sites.
- Clear names and small focused modules; one responsibility per module.
- SOLID where it fits naturally; no pattern proliferation to look senior.
- Every function's contract (inputs, outputs, guarantees) must be obvious from
  its name, types and a short comment where the why is not obvious.

## Commits and pull requests

- Every commit message states what changed and why:
  `fix(scope): ...`, `feat(scope): ...`, `test(scope): ...`, `docs: ...`.
- Multi-file changes go on a branch and land on `main` as ONE squash-merge,
  so code and its documentation are one atomic commit. Branch commits never
  auto-deploy; the squash merge is the only deploy trigger.
- Every PR description includes: what changed and why, which tests ran and
  their results, and remaining limitations or known gaps.
- Failed checks block release. No merge while any required check is failing -
  no exceptions without the owner's explicit say-so on that specific case.

## Documentation

- `architecture.md` must be updated in the same squash-merged change as any
  behavior change: real SHAs, stable headings/node IDs, and an honest
  LIVE-vs-COMMITTED distinction (production SHA named explicitly).

## Testing and release gate

- `npm test` (node:test suite) and `npm run build` (runs `tsc --noEmit -p web`
  before the Vite build) must both pass before a merge is proposed.
- Automated tests are not user-flow coverage: the deployed site must be
  exercised in a real browser at the exact production commit (desktop and
  390px mobile) before any user-facing "fixed" claim.
- Always name the production commit a claim is measured against.

## Data honesty (product rules)

- Never invent facts: cooking time, difficulty, nutrition, view counts or
  recipe details that are not in the data are labelled "unknown", never
  guessed. Derived values are labelled as estimates with their basis.
- AI-generated text is advisory taste commentary only - never nutrition,
  allergy, health or safety guarantees, and it must not contradict the
  deterministic constraint matching.
- Only verified recipes are suggested; partial cards stay visibly partial;
  "Veg" means strict no-egg.
- Canonical-ingredient identity: a derived form ("corn starch/flour/oil",
  spaced or hyphenated) is not the ingredient itself.
- No-repeat: dated suggestions and confirmed-cooked dishes are excluded for
  30 days; saved-for-later is never excluded; browsing/page exclusions never
  touch history.

## Repo hygiene and security

- No secrets, tokens, private Sheet/Doc IDs or personal data in the repo.
  The committed snapshot is public video-derived data only.
- No paid services; new dependencies need a stated reason.

## Enforcement status (honest)

- Automated: `npm run build` runs `tsc --noEmit` before bundling; the
  node:test suite runs locally and is required green before merge.
- Policy only (not yet automated): branch protection / required checks on
  `main` are NOT configured - the failed-checks-block-release rule is
  currently enforced by process, not by GitHub settings.
