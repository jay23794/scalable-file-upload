import { RowFieldMap } from './types';

/** Read a dotted path out of an actor row without assuming anything about it. */
function readPath(row: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return row[path];
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * First candidate key that holds a usable string.
 *
 * Numbers are accepted and stringified because actors are inconsistent about
 * whether an id is a number or a string.
 */
export function pickString(
  row: Record<string, unknown>,
  candidates: readonly string[] | undefined,
): string | null {
  if (!candidates) return null;
  for (const candidate of candidates) {
    const value = readPath(row, candidate);
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Everything the service needs to read out of one row, in one pass. */
export function readRow(row: Record<string, unknown>, fields: RowFieldMap) {
  return {
    employerUrl: pickString(row, fields.employerUrl),
    boardUrl: pickString(row, fields.boardUrl),
    sourceJobId: pickString(row, fields.sourceJobId),
    company: pickString(row, fields.company),
    title: pickString(row, fields.title),
    location: pickString(row, fields.location),
    searchTerm: pickString(row, fields.searchTerm),
  };
}
