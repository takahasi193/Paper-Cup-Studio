export function getPathBase(fullPath: string): string {
  if (!fullPath) return '';
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.pop() || fullPath;
}

export function splitPathTail(fullPath: string): { prefix: string; base: string } {
  if (!fullPath) return { prefix: '', base: '' };
  const match = fullPath.match(/^(.*[\\/])([^\\/]+)[\\/]?$/);
  if (!match) {
    return { prefix: '', base: fullPath };
  }
  return {
    prefix: match[1] ?? '',
    base: match[2] ?? fullPath,
  };
}
