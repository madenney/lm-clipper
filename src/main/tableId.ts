/** Table and filter ids go into SQL as identifiers: only plain names are allowed. */
export function validateTableId(id: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(id)) {
    throw new Error(`Invalid table/filter ID: ${id}`)
  }
}
