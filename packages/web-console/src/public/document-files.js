// A repository inspection also returns `files`, but those are source paths,
// not exported documents. Use this check for new events and saved chat replay.
export function isDocumentDownload(file) {
  return Boolean(file && typeof file.filename === 'string' && file.filename.trim()
    && Number.isSafeInteger(file.bytes) && file.bytes >= 0
    && typeof file.href === 'string'
    && /^\/api\/documents\/jobs\/[a-zA-Z0-9-]+\/download(?:\?|$)/.test(file.href));
}
