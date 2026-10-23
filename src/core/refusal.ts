/** A write solobooks won't do: one sentence saying why, and the input field to change. */
export class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly field: string,
  ) {
    super(reason);
  }

  toJSON(): { reason: string; field: string } {
    return { reason: this.reason, field: this.field };
  }
}
