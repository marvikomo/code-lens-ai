// No import: the resolver cannot use IMPORTS->EXPORTS, and neither `handle`
// lives in this file, so it falls through to the by-name pool where two
// declarations compete.
export function runAmbiguous(): void {
  handle(1);
}

export function runUnique(): void {
  uniqueHelper(1);
}
