import path from 'node:path';

const ARTIFACTS_ROOT =
  process.env.DATA_DIR ?? path.resolve(process.cwd(), '..', 'artifacts');

export function buildArtifactUrl(fullPath: string | null | undefined) {
  if (!fullPath) return '#';
  const normalized = path.normalize(fullPath);
  const relative = path.relative(ARTIFACTS_ROOT, normalized);
  if (relative.startsWith('..')) {
    return '#';
  }
  const encoded = relative
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/api/artifacts/${encoded}`;
}


