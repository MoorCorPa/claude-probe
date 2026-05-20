function isTransientError(err) {
  if ([502, 503, 429, 529].includes(err.status)) return true;
  const msg = err.message || "";
  return msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ETIMEDOUT") || msg.includes("ENOTFOUND");
}

module.exports = { isTransientError };
