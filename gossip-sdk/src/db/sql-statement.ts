/** SQL statement classes used for transaction ownership and durability. */
export type StatementKind =
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'savepoint'
  | 'mutation'
  | 'other';

export const TOP_LEVEL_SAVEPOINT_ERROR =
  'Top-level savepoints are not supported';

/**
 * Remove SQL comments without treating comment markers inside quoted values or
 * identifiers as comments. Classification still happens only after SQLite has
 * accepted execution, but exact transaction boundaries prevent a valid
 * savepoint rollback or multi-statement lookalike from releasing ownership.
 */
function withoutSqlComments(sql: string): string {
  let result = '';
  let quote: "'" | '"' | '`' | ']' | null = null;

  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    const next = sql[index + 1];

    if (quote !== null) {
      result += character;
      if (quote === ']') {
        if (character === ']') quote = null;
      } else if (character === quote) {
        if (next === quote) {
          result += next;
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      result += character;
      continue;
    }
    if (character === '[') {
      quote = ']';
      result += character;
      continue;
    }
    if (character === '-' && next === '-') {
      index += 2;
      // SQLite keeps `--` active through CR and ends it only at LF or
      // end-of-input. Treating CR as a terminator can make transaction text
      // that SQLite comments out look executable to the ownership classifier.
      while (index < sql.length && sql[index] !== '\n') {
        index++;
      }
      result += ' ';
      continue;
    }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      result += ' ';
      // SQLite treats end-of-input as terminating a block comment. Preserve
      // that lexical rule so executed mutations and transaction boundaries
      // cannot be misclassified merely because the final `*/` is absent.
      if (end === -1) break;
      index = end + 1;
      continue;
    }
    result += character;
  }

  return result;
}

export function classifyStatement(sql: string): StatementKind {
  const uncommented = withoutSqlComments(sql);
  // This ECMAScript trim is the canonical boundary-normalization contract.
  // The Rust validator mirrors its exact code-point set, rejects Rust-only
  // boundary whitespace, and rejects leading empty statements that this
  // classifier deliberately leaves as `other`.
  const normalized = uncommented.trim();
  if (
    /^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;?$/i.test(
      normalized
    )
  ) {
    return 'begin';
  }
  if (/^(?:COMMIT|END)(?:\s+TRANSACTION)?\s*;?$/i.test(normalized)) {
    return 'commit';
  }
  if (/^ROLLBACK(?:\s+TRANSACTION)?\s*;?$/i.test(normalized)) {
    return 'rollback';
  }
  if (/^SAVEPOINT\b/i.test(normalized)) {
    return 'savepoint';
  }
  if (
    /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|WITH|VACUUM|PRAGMA|ANALYZE|REINDEX)\b/i.test(
      normalized
    )
  ) {
    return 'mutation';
  }
  return 'other';
}
