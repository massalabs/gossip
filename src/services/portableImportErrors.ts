export class PortableImportRestartRequiredError extends Error {
  readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PortableImportRestartRequiredError';
    this.cause = options?.cause;
  }
}

export class PortableImportInvalidPasswordError extends Error {
  constructor() {
    super('Imported account password was not accepted');
    this.name = 'PortableImportInvalidPasswordError';
  }
}
