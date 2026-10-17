/** An expected, user-facing failure; its message is shown in the UI. */
export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
