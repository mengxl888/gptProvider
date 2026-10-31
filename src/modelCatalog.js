// Convert Codex catalog entries and synthetic gateway entries to a stable OpenAI model list.
export function modelIdsForApi(models = [], extraIds = []) {
  const ids = [];
  for (const item of [...models, ...extraIds]) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return [...new Set(ids)];
}
