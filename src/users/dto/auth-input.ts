export function trimIdentity(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export function normalizeEmailDomain(value: unknown): unknown {
  const trimmed = trimIdentity(value);
  if (typeof trimmed !== 'string') return trimmed;

  const separatorIndex = trimmed.lastIndexOf('@');
  if (separatorIndex < 0) return trimmed;

  return `${trimmed.slice(0, separatorIndex)}@${trimmed
    .slice(separatorIndex + 1)
    .toLowerCase()}`;
}
