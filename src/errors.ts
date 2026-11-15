export type HarnessErrorCode =
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'dependency-cycle'
  | 'blocked-by-dependents'

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
