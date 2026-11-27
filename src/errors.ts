export type HarnessErrorCode =
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'dependency-cycle'
  | 'blocked-by-dependents'
  | 'review-required'
  | 'review-open'
  | 'review-stale'
  | 'review-round-cap'
  | 'review-phase'
  | 'review-lens-missing'
  | 'review-checks'
  | 'review-unrefuted'
  | 'readiness-required'
  | 'readiness-stale'

export class HarnessError extends Error {
  constructor(
    readonly code: HarnessErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'HarnessError'
  }
}

export type ErrorText = string
