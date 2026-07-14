/**
 * Build one IMAP SEARCH query that discovers every possible ownership
 * candidate for a run. The caller must still fetch each result and apply the
 * exact ownership predicate before using a UID as a destructive operand.
 *
 * IMAP OR is binary on the wire; ImapFlow compiles this array into the nested
 * tree required by the protocol. Combining the hints here avoids issuing one
 * round trip per Message-ID in every mailbox on large Bridge profiles.
 */
export function buildOwnershipDiscoveryQuery(headerName, token, messageIds = [], subjects = []) {
  const terms = [
    { header: { [headerName]: token } },
    ...[...new Set(messageIds)].map((messageId) => ({ header: { "message-id": messageId } })),
    ...[...new Set(subjects)].map((subject) => ({ subject })),
  ];
  return terms.length === 1 ? terms[0] : { or: terms };
}
