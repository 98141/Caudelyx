export const etag = (row) => '"' + row._id + ':' + row.version + '"';
export const keyNames = ['expenses', 'expense_rules', 'liabilities', 'liability_versions', 'card_acquisitions', 'asset_stubs', 'events', 'history'];
export const table = (kind, name) => 's09_' + name + '_' + kind.toLowerCase();
export const booksTable = 's09_books';
export const privateAccounts = 's09_personal_accounts';
export const privateJournals = 's09_personal_journals';
export const assignments = 's09_personal_assignments';
export const declarations = 's09_ownership_declarations';
export const relationships = 's09_relationships';
export const commands = 's09_commands';
export const globalEvidence = 's09_evidence';
//# sourceMappingURL=models.js.map