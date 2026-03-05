import { existsSync } from 'node:fs';
import { basename } from 'node:path';

import { enqueuePublish, getQueueStatus, type PublishRequest } from './publish-queue';
import type VerbunccioStorage from './verbunccio-storage';

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bumpRev(currentRev?: string): string {
  if (!currentRev) return '1-verbunccio';
  const n = parseInt(currentRev.split('-')[0], 10);
  return `${(isNaN(n) ? 0 : n) + 1}-verbunccio`;
}

function safeDecode(raw: string): { ok: true; value: string } | { ok: false } {
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) {
      return { ok: false };
    }
    return { ok: true, value: decoded };
  } catch {
    return { ok: false };
  }
}

async function proxyToUpstream(req: Request, pathname: string, search?: string): Promise<Response> {
  try {
    const upstream = new URL('https://registry.npmjs.org');
    upstream.pathname = pathname;
    if (search) upstream.search = search;
    const headers = new Headers(req.headers);
    headers.delete('authorization');
    headers.delete('host');
    const resp = await fetch(upstream.toString(), {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    // Bun's fetch auto-decompresses the body, so we must strip
    // Content-Encoding and Content-Length to avoid the client trying
    // to decompress an already-decompressed stream.
    const proxyHeaders = new Headers(resp.headers);
    proxyHeaders.delete('content-encoding');
    proxyHeaders.delete('content-length');
    return new Response(resp.body, {
      status: resp.status,
      headers: proxyHeaders,
    });
  } catch {
    return jsonResponse(502, { error: 'bad_gateway', reason: 'upstream registry unavailable' });
  }
}

// Publish a new package version
async function handlePublish(
  req: Request,
  storage: VerbunccioStorage,
  port: number,
  pkgName: string,
): Promise<Response> {
  let body: Record<string, any>;
  try {
    body = (await req.json()) as Record<string, any>;
  } catch {
    return jsonResponse(400, { error: 'bad_request', reason: 'invalid JSON body' });
  }

  const incomingVersions = (body.versions ?? {}) as Record<string, any>;
  const versionKeys = Object.keys(incomingVersions);
  if (versionKeys.length !== 1) {
    return jsonResponse(400, { error: 'bad_request', reason: 'expected exactly one version' });
  }
  const newVersionKey = versionKeys[0];
  const newVersionData = incomingVersions[newVersionKey];

  const attachments = (body._attachments ?? {}) as Record<string, any>;
  const attachmentKeys = Object.keys(attachments);
  if (attachmentKeys.length === 0) {
    return jsonResponse(400, { error: 'bad_request', reason: 'missing attachment' });
  }

  // Lock around the entire read-check-save-mutate-write sequence
  return storage.withLock(pkgName, async () => {
    const existing = storage.getPackument(pkgName);

    // Check for duplicate version
    if (existing && existing.versions[newVersionKey] !== undefined) {
      return jsonResponse(409, { error: 'conflict', reason: 'version already exists' });
    }

    // Save tarballs from attachments (inside lock, after duplicate check)
    const savedTarballs: string[] = [];
    for (const [attachmentName, meta] of Object.entries(attachments)) {
      // npm sends scoped attachment names like "@scope/pkg-1.0.0.tgz",
      // extract the basename for safe disk storage
      const safeFilename = basename(attachmentName);
      if (!safeFilename || safeFilename.includes('..') || safeFilename.includes('\0')) {
        return jsonResponse(400, { error: 'bad_request', reason: 'invalid attachment filename' });
      }
      const base64Data = (meta as Record<string, any>).data as string;
      const buffer = Buffer.from(base64Data, 'base64');
      if (buffer.length === 0) {
        return jsonResponse(400, { error: 'bad_request', reason: 'empty attachment data' });
      }
      await storage.saveTarball(pkgName, safeFilename, buffer);
      savedTarballs.push(safeFilename);
    }

    const doc = existing
      ? { ...existing }
      : {
          _id: pkgName,
          _rev: '0-verbunccio',
          name: pkgName,
          'dist-tags': {} as Record<string, string>,
          versions: {} as Record<string, any>,
          time: {} as Record<string, string>,
        };

    // Add new version
    doc.versions = { ...doc.versions };

    // Rewrite dist.tarball URL to canonical form
    if (newVersionData.dist) {
      const tarballFilename = `${pkgName.split('/').pop()}-${newVersionKey}.tgz`;
      newVersionData.dist = {
        ...newVersionData.dist,
        tarball: `http://127.0.0.1:${port}/${pkgName}/-/${tarballFilename}`,
      };
    }
    doc.versions[newVersionKey] = newVersionData;

    // Merge dist-tags
    const incomingTags = (body['dist-tags'] ?? {}) as Record<string, string>;
    doc['dist-tags'] = { ...doc['dist-tags'], ...incomingTags };

    // Add time entry
    doc.time = { ...(doc.time ?? {}) };
    doc.time[newVersionKey] = new Date().toISOString();

    // Bump revision
    const newRev = bumpRev(doc._rev);
    doc._rev = newRev;

    // Strip _attachments from the doc before saving
    delete doc._attachments;

    try {
      await storage.savePackument(pkgName, doc);
    } catch (err) {
      // Roll back saved tarballs on packument save failure
      for (const filename of savedTarballs) {
        await storage.deleteTarball(pkgName, filename);
      }
      throw err;
    }

    return jsonResponse(201, { ok: true, id: pkgName, rev: newRev });
  });
}

// TTL for cached upstream packument data (5 minutes)
const UPSTREAM_CACHE_TTL = 5 * 60 * 1000;

// Timeout for upstream fetches when we have local data to fall back on
const UPSTREAM_MERGE_TIMEOUT = 5_000;

async function fetchUpstreamPackument(pkgName: string): Promise<Record<string, any> | null> {
  try {
    const url = `https://registry.npmjs.org/${pkgName}`;
    const resp = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_MERGE_TIMEOUT),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

function mergePackuments(
  upstream: Record<string, any>,
  local: Record<string, any>,
  name: string,
  port: number,
): Record<string, any> {
  const merged = { ...upstream };

  // Merge versions: upstream as base, local versions overlay on top
  merged.versions = { ...(upstream.versions ?? {}) };
  for (const [ver, data] of Object.entries(local.versions ?? {})) {
    merged.versions[ver] = data;
  }

  // Rewrite upstream tarball URLs to route through our proxy so
  // bun/npm fetches hit handleGetTarball (which proxies to upstream
  // for tarballs not stored locally)
  const shortName = name.split('/').pop()!;
  for (const [ver, data] of Object.entries(merged.versions)) {
    const vData = data as Record<string, any>;
    if (vData.dist?.tarball) {
      const tarballFilename = `${shortName}-${ver}.tgz`;
      vData.dist = {
        ...vData.dist,
        tarball: `http://127.0.0.1:${port}/${name}/-/${tarballFilename}`,
      };
    }
  }

  // Merge dist-tags: upstream as base, local tags overlay
  merged['dist-tags'] = { ...(upstream['dist-tags'] ?? {}), ...(local['dist-tags'] ?? {}) };

  // Merge time entries
  merged.time = { ...(upstream.time ?? {}), ...(local.time ?? {}) };

  // Use local _id, _rev, name
  merged._id = local._id;
  merged._rev = local._rev;
  merged.name = local.name;

  return merged;
}

// Get a packument (metadata document) for a package
async function handleGetPackument(
  req: Request,
  storage: VerbunccioStorage,
  pkgNameStr: string,
  port: number,
  search?: string,
): Promise<Response> {
  if (storage.hasPackage(pkgNameStr)) {
    // Check merged packument cache first
    const cached = storage.getMergedPackument(pkgNameStr);
    if (cached && Date.now() - cached.fetchedAt < UPSTREAM_CACHE_TTL) {
      return respondWithJson(req, cached.json);
    }

    // Fetch upstream and merge with local data
    const localDoc = storage.getPackument(pkgNameStr)!;
    const upstream = await fetchUpstreamPackument(pkgNameStr);

    let json: string;
    if (upstream) {
      const merged = mergePackuments(upstream, localDoc, pkgNameStr, port);
      json = JSON.stringify(merged);
    } else {
      // Upstream unavailable, fall back to local-only packument
      json = storage.getFullJson(pkgNameStr)!;
    }

    storage.setMergedPackument(pkgNameStr, json);
    return respondWithJson(req, json);
  }
  return proxyToUpstream(req, `/${pkgNameStr}`, search);
}

function respondWithJson(req: Request, json: string): Response {
  if (req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(json).byteLength),
      },
    });
  }
  return new Response(json, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// Serve a tarball file
async function handleGetTarball(
  req: Request,
  storage: VerbunccioStorage,
  pkgName: string,
  filename: string,
  search?: string,
): Promise<Response> {
  const filepath = storage.getTarballPath(pkgName, filename);
  const file = Bun.file(filepath);

  if (await file.exists()) {
    if (req.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(file.size),
        },
      });
    }
    return new Response(file, {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  return proxyToUpstream(req, `/${pkgName}/-/${filename}`, search);
}

// Delete an entire package
async function handleDeletePackage(
  storage: VerbunccioStorage,
  pkgName: string,
  rev: string,
): Promise<Response> {
  return storage.withLock(pkgName, async () => {
    const existing = storage.getPackument(pkgName);
    if (!existing) {
      return jsonResponse(404, { error: 'not_found' });
    }
    if (existing._rev !== rev) {
      return jsonResponse(409, { error: 'conflict', reason: 'revision mismatch' });
    }
    await storage.deletePackage(pkgName);
    return jsonResponse(200, { ok: true });
  });
}

// Update a packument (used by npm unpublish for individual versions)
async function handleUpdatePackument(
  req: Request,
  storage: VerbunccioStorage,
  pkgName: string,
  rev: string,
  port: number,
): Promise<Response> {
  return storage.withLock(pkgName, async () => {
    const existing = storage.getPackument(pkgName);
    if (!existing) {
      return jsonResponse(404, { error: 'not_found' });
    }
    if (existing._rev !== rev) {
      return jsonResponse(409, { error: 'conflict', reason: 'revision mismatch' });
    }

    let newDoc: Record<string, any>;
    try {
      newDoc = (await req.json()) as Record<string, any>;
    } catch {
      return jsonResponse(400, { error: 'bad_request', reason: 'invalid JSON body' });
    }

    // Determine removed versions
    const oldVersions = new Set(Object.keys(existing.versions));
    const newVersions = new Set(Object.keys(newDoc.versions ?? {}));
    const removedVersions: string[] = [];
    for (const v of oldVersions) {
      if (!newVersions.has(v)) {
        removedVersions.push(v);
      }
    }

    // Bump revision
    const newRev = bumpRev(existing._rev);
    newDoc._rev = newRev;

    // Rewrite all dist.tarball URLs to canonical form
    for (const [version, versionData] of Object.entries(newDoc.versions ?? {})) {
      const vData = versionData as Record<string, any>;
      if (vData.dist) {
        const tarballFilename = `${pkgName.split('/').pop()}-${version}.tgz`;
        vData.dist = {
          ...vData.dist,
          tarball: `http://127.0.0.1:${port}/${pkgName}/-/${tarballFilename}`,
        };
      }
    }

    await storage.savePackument(pkgName, newDoc as any);

    // Delete orphaned tarballs for removed versions
    for (const version of removedVersions) {
      const tarballFilename = `${pkgName.split('/').pop()}-${version}.tgz`;
      await storage.deleteTarball(pkgName, tarballFilename);
    }

    return jsonResponse(201, { ok: true, id: pkgName, rev: newRev });
  });
}

// Set a dist-tag on a package
async function handleSetDistTag(
  req: Request,
  storage: VerbunccioStorage,
  pkgName: string,
  tag: string,
): Promise<Response> {
  return storage.withLock(pkgName, async () => {
    const existing = storage.getPackument(pkgName);
    if (!existing) {
      return jsonResponse(404, { error: 'not_found' });
    }

    // Body is a JSON string (the version), e.g. "0.0.0-pkglab.1234567890"
    let version: string;
    try {
      version = (await req.json()) as string;
    } catch {
      return jsonResponse(400, { error: 'bad_request', reason: 'invalid JSON body' });
    }

    if (existing.versions[version] === undefined) {
      return jsonResponse(404, { error: 'not_found', reason: 'version not found' });
    }

    const doc = { ...existing };
    doc['dist-tags'] = { ...doc['dist-tags'] };
    doc['dist-tags'][tag] = version;

    const newRev = bumpRev(doc._rev);
    doc._rev = newRev;

    await storage.savePackument(pkgName, doc);

    return jsonResponse(201, { ok: true });
  });
}

// Handle POST /-/pkglab/publish
async function handlePublishQueue(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: 'bad_request', reason: 'invalid JSON body' });
  }

  const workspaceRoot = body.workspaceRoot;
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    return jsonResponse(400, { error: 'bad_request', reason: 'workspaceRoot is required' });
  }

  if (!existsSync(workspaceRoot)) {
    return jsonResponse(400, { error: 'bad_request', reason: 'workspaceRoot directory does not exist' });
  }

  const targets = body.targets;
  if (!Array.isArray(targets) || !targets.every(t => typeof t === 'string')) {
    return jsonResponse(400, { error: 'bad_request', reason: 'targets must be an array of strings' });
  }

  const req_: PublishRequest = {
    workspaceRoot,
    targets: targets as string[],
    tag: typeof body.tag === 'string' ? body.tag : undefined,
    force: body.force === true,
    shallow: body.shallow === true,
    single: body.single === true,
    root: body.root === true,
    dryRun: body.dryRun === true,
  };

  const result = enqueuePublish(req_);
  return jsonResponse(202, { jobId: result.jobId, status: result.status });
}

// Route system paths (/-/ prefix)
function routeSystemPath(
  req: Request,
  storage: VerbunccioStorage,
  pathname: string,
): Response | Promise<Response> | null {
  const method = req.method;

  if (method === 'GET' && pathname === '/-/ping') {
    return jsonResponse(200, {});
  }

  if (method === 'GET' && pathname === '/-/ready') {
    return jsonResponse(200, { ok: true });
  }

  if (method === 'GET' && pathname === '/-/pkglab/index') {
    return new Response(storage.getIndex(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (method === 'POST' && pathname === '/-/npm/v1/security/advisories/bulk') {
    return jsonResponse(200, {});
  }

  if (method === 'POST' && pathname === '/-/npm/v1/security/audits/quick') {
    return jsonResponse(200, {});
  }

  // PUT /-/package/:pkg/dist-tags/:tag
  if (method === 'PUT' && pathname.startsWith('/-/package/')) {
    const rest = pathname.slice('/-/package/'.length);
    const distTagsIdx = rest.indexOf('/dist-tags/');
    if (distTagsIdx !== -1) {
      const rawPkg = rest.slice(0, distTagsIdx);
      const rawTag = rest.slice(distTagsIdx + '/dist-tags/'.length);
      const decodedPkg = safeDecode(rawPkg);
      if (!decodedPkg.ok) {
        return jsonResponse(400, { error: 'bad_request', reason: 'invalid package name' });
      }
      const decodedTag = safeDecode(rawTag);
      if (!decodedTag.ok || decodedTag.value === '') {
        return jsonResponse(400, { error: 'bad_request', reason: 'invalid dist-tag' });
      }
      return handleSetDistTag(req, storage, decodedPkg.value, decodedTag.value);
    }
  }

  // POST /-/pkglab/publish -- enqueue a publish request
  if (method === 'POST' && pathname === '/-/pkglab/publish') {
    return handlePublishQueue(req);
  }

  // GET /-/pkglab/publish/status -- return current queue state
  if (method === 'GET' && pathname === '/-/pkglab/publish/status') {
    const status = getQueueStatus();
    return jsonResponse(200, { workspaces: status });
  }

  // Anything else under /-/
  return jsonResponse(404, { error: 'not_found' });
}

// Parse package paths and dispatch to handlers
function routePackagePath(
  req: Request,
  storage: VerbunccioStorage,
  port: number,
  pathname: string,
  search: string,
): Response | Promise<Response> {
  const method = req.method;

  // Strip leading slash
  const rawPath = pathname.slice(1);
  if (!rawPath) {
    return jsonResponse(404, { error: 'not_found' });
  }

  // Check for -rev routes first: split at /-rev/
  const revSplitIdx = rawPath.indexOf('/-rev/');
  if (revSplitIdx !== -1) {
    const rawPkg = rawPath.slice(0, revSplitIdx);
    const rev = rawPath.slice(revSplitIdx + '/-rev/'.length);
    const decodedPkg = safeDecode(rawPkg);
    if (!decodedPkg.ok) {
      return jsonResponse(400, { error: 'bad_request', reason: 'invalid package name' });
    }
    const pkgName = decodedPkg.value;

    // Reject double-encoded names
    if (pkgName.includes('%')) {
      return jsonResponse(400, { error: 'bad_request', reason: 'invalid package name' });
    }

    if (method === 'DELETE') {
      return handleDeletePackage(storage, pkgName, rev);
    }
    if (method === 'PUT') {
      return handleUpdatePackument(req, storage, pkgName, rev, port);
    }
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  // Split at first /-/ to separate package name from tarball path
  const tarballSplitIdx = rawPath.indexOf('/-/');
  if (tarballSplitIdx !== -1) {
    const rawPkg = rawPath.slice(0, tarballSplitIdx);
    const filename = rawPath.slice(tarballSplitIdx + '/-/'.length);
    const decodedPkg = safeDecode(rawPkg);
    if (!decodedPkg.ok) {
      return jsonResponse(400, { error: 'bad_request', reason: 'invalid package name' });
    }
    const pkgName = decodedPkg.value;

    // Reject double-encoded names
    if (pkgName.includes('%')) {
      return jsonResponse(400, { error: 'bad_request', reason: 'invalid package name' });
    }

    if (method === 'GET' || method === 'HEAD') {
      return handleGetTarball(req, storage, pkgName, filename, search);
    }
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  // Plain package path (no /-/)
  const decodedPkg = safeDecode(rawPath);
  if (!decodedPkg.ok) {
    return jsonResponse(400, { error: 'bad_request', reason: 'invalid package name' });
  }
  const pkgName = decodedPkg.value;

  // Reject double-encoded names
  if (pkgName.includes('%')) {
    return jsonResponse(400, { error: 'bad_request', reason: 'invalid package name' });
  }

  if (method === 'PUT') {
    return handlePublish(req, storage, port, pkgName);
  }
  if (method === 'GET' || method === 'HEAD') {
    return handleGetPackument(req, storage, pkgName, port, search);
  }
  return jsonResponse(405, { error: 'method_not_allowed' });
}

export async function handleRequest(
  req: Request,
  storage: VerbunccioStorage,
  port: number,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // System paths
  if (pathname.startsWith('/-/')) {
    const result = routeSystemPath(req, storage, pathname);
    if (result !== null) {
      return result;
    }
  }

  // Package paths
  if (pathname.length > 1) {
    return routePackagePath(req, storage, port, pathname, url.search);
  }

  return jsonResponse(404, { error: 'not_found' });
}
