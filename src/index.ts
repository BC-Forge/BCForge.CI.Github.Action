/**
 * BCForge GitHub Action — src/index.ts
 *
 * Validates AL object ID ranges and BCForge governance rules for the current
 * repository, then reports the result to the BCForge CI runs API.
 *
 * All BCForge-specific logic lives here so the action never needs alc and
 * works on any runner OS (ubuntu-latest, windows-latest, macos-latest).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// GitHub Actions helpers (no dependency on @actions/core to keep bundle tiny)
// ---------------------------------------------------------------------------

function getInput(name: string): string {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '';
}

function setOutput(name: string, value: string | number): void {
  const filePath = process.env['GITHUB_OUTPUT'];
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}\n`);
  }
}

function info(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function warning(msg: string): void {
  process.stdout.write(`::warning::${msg}\n`);
}

function error(msg: string): void {
  process.stdout.write(`::error::${msg}\n`);
}

function notice(msg: string): void {
  process.stdout.write(`::notice::${msg}\n`);
}

/** Emit a GitHub file annotation */
function annotate(
  level: 'error' | 'warning' | 'notice',
  file: string,
  line: number,
  title: string,
  message: string,
): void {
  process.stdout.write(
    `::${level} file=${file},line=${line},title=${title}::${message}\n`,
  );
}

// ---------------------------------------------------------------------------
// BCForge API types (mirrors server-side schemas)
// ---------------------------------------------------------------------------

interface IdRange {
  from: number;
  to: number;
  name?: string;
}

interface OrgRangesResponse {
  pool: IdRange[];
  orgRanges: Array<{
    workspaceId: string;
    workspaceName: string;
    appId: string;
    appName: string;
    ranges: IdRange[];
  }>;
  logicalRanges: Array<{
    id: string;
    name: string;
    rangeFrom: number;
    rangeTo: number;
    objectTypes: string[] | null;
  }>;
}

interface ApiRule {
  id: string;
  name: string;
  category: string;
  severity: 'info' | 'warning' | 'error';
  ruleConfig: Record<string, unknown> | null;
}

interface RulesResponse {
  workspace: { id: string; name: string };
  rules: ApiRule[];
}

// ---------------------------------------------------------------------------
// app.json discovery
// ---------------------------------------------------------------------------

interface AppJson {
  id: string;
  name: string;
  publisher: string;
  version: string;
  idRanges: Array<{ from: number; to: number }>;
}

interface DiscoveredApp {
  appJson: AppJson;
  dir: string; // absolute directory of the app.json
}

function findAppJsonFiles(dir: string): DiscoveredApp[] {
  const results: DiscoveredApp[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      results.push(...findAppJsonFiles(full));
    } else if (entry.isFile() && entry.name === 'app.json') {
      try {
        const raw = JSON.parse(fs.readFileSync(full, 'utf-8')) as Partial<AppJson>;
        if (raw.id && raw.name && Array.isArray(raw.idRanges)) {
          results.push({
            appJson: {
              id: raw.id,
              name: raw.name,
              publisher: raw.publisher ?? '',
              version: raw.version ?? '0.0.0.0',
              idRanges: raw.idRanges,
            },
            dir: path.dirname(full),
          });
        }
      } catch {
        // Ignore malformed app.json files
      }
    }
  }
  return results;
}

/** Group AL objects by the app they belong to (nearest app.json above the file) */
function groupObjectsByApp(
  objects: AlObject[],
  apps: DiscoveredApp[],
): Map<string, AlObject[]> {
  const result = new Map<string, AlObject[]>(apps.map((a) => [a.appJson.id, []]));
  const ungrouped: AlObject[] = [];

  for (const obj of objects) {
    // Find the app whose dir is the longest matching prefix of obj.file
    let best: DiscoveredApp | null = null;
    for (const app of apps) {
      const isUnder =
        obj.file === path.join(app.dir, path.basename(obj.file)) ||
        obj.file.startsWith(app.dir + path.sep);
      if (isUnder && (!best || app.dir.length > best.dir.length)) {
        best = app;
      }
    }
    if (best) {
      result.get(best.appJson.id)!.push(obj);
    } else {
      ungrouped.push(obj);
    }
  }

  // Assign orphaned objects to the app with the most objects (closest logical owner),
  // or to the first app if all are empty. This handles flat repo layouts where the
  // app.json and .al files are siblings rather than parent/child.
  if (ungrouped.length > 0 && apps.length > 0) {
    let largestAppId = apps[0]!.appJson.id;
    let max = 0;
    for (const [id, objs] of result) {
      if (objs.length > max) { max = objs.length; largestAppId = id; }
    }
    result.get(largestAppId)!.push(...ungrouped);
  }

  return result;
}

// ---------------------------------------------------------------------------
// AL file scanning
// ---------------------------------------------------------------------------

interface AlObject {
  file: string;
  line: number;
  type: string;
  id: number;
  name: string;
}

/** Recursively find all .al files under a directory */
function findAlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      results.push(...findAlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.al')) {
      results.push(full);
    }
  }
  return results;
}

const OBJECT_PATTERN =
  /^\s*(table|page|codeunit|report|query|xmlport|enum|enumextension|tableextension|pageextension|reportextension|interface|controladdin|permissionset)\s+(\d+)\s+["']?([^"'\r\n{]+)/gim;

/** Parse all AL object declarations from the repo */
function scanAlObjects(alFiles: string[]): AlObject[] {
  const objects: AlObject[] = [];

  for (const file of alFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    // Build line-offset index for fast lookup
    const lineOffsets: number[] = [0];
    for (const line of lines) {
      lineOffsets.push(lineOffsets[lineOffsets.length - 1]! + line.length + 1);
    }

    OBJECT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OBJECT_PATTERN.exec(content)) !== null) {
      const charOffset = match.index;
      // Binary-search the line number
      let lo = 0;
      let hi = lineOffsets.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (lineOffsets[mid]! <= charOffset) lo = mid;
        else hi = mid;
      }
      objects.push({
        file,
        line: lo + 1,
        type: match[1]!.toLowerCase(),
        id: parseInt(match[2]!, 10),
        name: (match[3] ?? '').trim(),
      });
    }
  }

  return objects;
}

// ---------------------------------------------------------------------------
// Rule checks (BCForge-defined, runs locally against the AL source)
// ---------------------------------------------------------------------------

interface Annotation {
  path: string;
  line: number;
  level: 'failure' | 'warning' | 'notice';
  title: string;
  message: string;
}

function checkRules(
  rules: ApiRule[],
  alFiles: string[],
  workspaceRoot: string,
): Annotation[] {
  const annotations: Annotation[] = [];

  for (const file of alFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const relPath = path.relative(workspaceRoot, file);

    for (const rule of rules) {
      const level: Annotation['level'] =
        rule.severity === 'error' ? 'failure' : rule.severity === 'warning' ? 'warning' : 'notice';

      switch (rule.id) {
        // ── BCF001: TodoComment ────────────────────────────────────────────
        case 'BCF001': {
          for (let i = 0; i < lines.length; i++) {
            if (/\/\/\s*(TODO|FIXME|HACK|UNDONE)/i.test(lines[i]!)) {
              annotations.push({
                path: relPath,
                line: i + 1,
                level,
                title: rule.name,
                message: `${rule.name}: TODO/FIXME comment found. Remove or resolve before merging.`,
              });
            }
          }
          break;
        }

        // ── BCF002: ObsoleteTag ────────────────────────────────────────────
        case 'BCF002': {
          for (let i = 0; i < lines.length; i++) {
            if (/ObsoleteState\s*=\s*Pending/i.test(lines[i]!)) {
              annotations.push({
                path: relPath,
                line: i + 1,
                level,
                title: rule.name,
                message: `${rule.name}: Object or field is marked ObsoleteState = Pending.`,
              });
            }
          }
          break;
        }

        // ── BCF003: MissingCaptionML ───────────────────────────────────────
        case 'BCF003': {
          const cfg = rule.ruleConfig as { requireCaptionML?: boolean } | null;
          if (cfg?.requireCaptionML === false) break;
          for (let i = 0; i < lines.length; i++) {
            if (/^\s*field\s*\(/i.test(lines[i]!)) {
              // Check if 'Caption' or 'CaptionML' appears within the next 5 lines
              const block = lines.slice(i, i + 5).join(' ');
              if (!/caption\s*[=:]/i.test(block)) {
                annotations.push({
                  path: relPath,
                  line: i + 1,
                  level,
                  title: rule.name,
                  message: `${rule.name}: Table field is missing a Caption property.`,
                });
              }
            }
          }
          break;
        }

        // ── BCF010: LargeFunction ─────────────────────────────────────────
        case 'BCF010': {
          const max = (rule.ruleConfig as { maxLines?: number } | null)?.maxLines ?? 100;
          let inProc = false;
          let procStart = 0;
          let braceDepth = 0;
          for (let i = 0; i < lines.length; i++) {
            const ln = lines[i]!;
            if (!inProc && /^\s*(procedure|trigger)\s+/i.test(ln)) {
              inProc = true;
              procStart = i;
              braceDepth = 0;
            }
            if (inProc) {
              braceDepth += (ln.match(/\bbegin\b/gi) ?? []).length;
              braceDepth -= (ln.match(/\bend\b/gi) ?? []).length;
              if (braceDepth <= 0 && i > procStart) {
                const length = i - procStart;
                if (length > max) {
                  annotations.push({
                    path: relPath,
                    line: procStart + 1,
                    level,
                    title: rule.name,
                    message: `${rule.name}: Procedure/trigger is ${length} lines (max ${max}).`,
                  });
                }
                inProc = false;
              }
            }
          }
          break;
        }

        default:
          // Unknown / future rules are silently skipped — forward-compatible
          break;
      }
    }
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Range conflict detection
// ---------------------------------------------------------------------------

function checkRangeConflicts(
  objects: AlObject[],
  pool: IdRange[],
  orgRanges: OrgRangesResponse['orgRanges'],
  currentWorkspaceId: string | undefined,
  workspaceRoot: string,
): { annotations: Annotation[]; outOfPool: number; conflicts: number } {
  const annotations: Annotation[] = [];
  let outOfPool = 0;
  let conflicts = 0;

  // Build a set of IDs used by OTHER workspaces (for conflict detection)
  const foreignIds = new Map<number, string>(); // id -> workspaceName
  for (const entry of orgRanges) {
    if (entry.workspaceId === currentWorkspaceId) continue;
    for (const r of entry.ranges) {
      for (let id = r.from; id <= r.to; id++) {
        foreignIds.set(id, entry.workspaceName ?? entry.appName);
      }
    }
  }

  const inPool = (id: number): boolean =>
    pool.some((r) => id >= r.from && id <= r.to);

  for (const obj of objects) {
    const relPath = path.relative(workspaceRoot, obj.file);

    if (!inPool(obj.id)) {
      outOfPool++;
      annotations.push({
        path: relPath,
        line: obj.line,
        level: 'failure',
        title: 'ID out of pool',
        message: `Object ID ${obj.id} (${obj.type} "${obj.name}") is outside the organisation's configured ID pool.`,
      });
    } else {
      const owner = foreignIds.get(obj.id);
      if (owner) {
        conflicts++;
        annotations.push({
          path: relPath,
          line: obj.line,
          level: 'failure',
          title: 'ID range conflict',
          message: `Object ID ${obj.id} (${obj.type} "${obj.name}") is already used by workspace "${owner}".`,
        });
      }
    }
  }

  return { annotations, outOfPool, conflicts };
}

// ---------------------------------------------------------------------------
// Git context helpers
// ---------------------------------------------------------------------------

function gitValue(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// .bcforge.json loader
// ---------------------------------------------------------------------------

interface BCForgeConfig {
  org?: string;
  workspace?: string;
  serverUrl?: string;
}

function loadBCForgeConfig(workspaceRoot: string): BCForgeConfig {
  const filePath = path.join(workspaceRoot, '.bcforge.json');
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BCForgeConfig;
  } catch {
    warning('BCForge: .bcforge.json is invalid JSON and will be ignored.');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const workspaceRoot = process.env['GITHUB_WORKSPACE'] ?? process.cwd();
  const fileConfig = loadBCForgeConfig(workspaceRoot);

  const apiKey = getInput('api-key');
  const orgId = getInput('org') || fileConfig.org || '';
  const wsId = getInput('workspace') || fileConfig.workspace || '';
  const serverUrl =
    (getInput('server-url') || fileConfig.serverUrl || 'https://bcforge.net').replace(/\/$/, '');
  const failOnViolations = getInput('fail-on-violations') !== 'false';

  if (!apiKey || !orgId || !wsId) {
    error(
      'BCForge: api-key is required, and org + workspace must be provided either via ' +
        '.bcforge.json in the repo root or as action inputs.',
    );
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const startMs = Date.now();

  // ── Fetch rules and ranges in parallel ──────────────────────────────────
  info('BCForge: fetching rules and ranges…');

  let rulesData: RulesResponse;
  let rangesData: OrgRangesResponse;

  try {
    const [rulesRes, rangesRes] = await Promise.all([
      fetch(
        `${serverUrl}/api/v1/rules?org=${encodeURIComponent(orgId)}&workspace=${encodeURIComponent(wsId)}`,
        { headers },
      ),
      fetch(`${serverUrl}/api/v1/ranges?org=${encodeURIComponent(orgId)}`, { headers }),
    ]);

    if (!rulesRes.ok) {
      const body = await rulesRes.text().catch(() => '');
      throw new Error(`Rules API ${rulesRes.status}: ${body}`);
    }
    if (!rangesRes.ok) {
      const body = await rangesRes.text().catch(() => '');
      throw new Error(`Ranges API ${rangesRes.status}: ${body}`);
    }

    rulesData = (await rulesRes.json()) as RulesResponse;
    rangesData = (await rangesRes.json()) as OrgRangesResponse;
  } catch (err) {
    error(`BCForge: failed to fetch configuration — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  info(`BCForge: ${rulesData.rules.length} rule(s) loaded, pool has ${rangesData.pool.length} segment(s).`);

  // ── Scan AL files ────────────────────────────────────────────────────────
  info(`BCForge: scanning AL files in ${workspaceRoot}…`);

  const alFiles = findAlFiles(workspaceRoot);
  info(`BCForge: found ${alFiles.length} AL file(s).`);

  if (alFiles.length === 0) {
    notice('BCForge: no AL files found — skipping checks.');
    setOutput('status', 'skipped');
    setOutput('rule-violations', 0);
    setOutput('range-conflicts', 0);
    process.exit(0);
  }

  const alObjects = scanAlObjects(alFiles);
  info(`BCForge: parsed ${alObjects.length} AL object declaration(s).`);

  // Discover app.json files
  const discoveredApps = findAppJsonFiles(workspaceRoot);
  info(`BCForge: found ${discoveredApps.length} app.json file(s).`);
  const objectsByApp = groupObjectsByApp(alObjects, discoveredApps);

  // ── Run checks ───────────────────────────────────────────────────────────
  const ruleAnnotations = checkRules(rulesData.rules, alFiles, workspaceRoot);

  const currentWsEntry = rangesData.orgRanges.find((e) => e.workspaceId === wsId);
  const currentWorkspaceId = currentWsEntry?.workspaceId;

  const { annotations: rangeAnnotations, outOfPool, conflicts } =
    checkRangeConflicts(alObjects, rangesData.pool, rangesData.orgRanges, currentWorkspaceId, workspaceRoot);

  const allAnnotations = [...ruleAnnotations, ...rangeAnnotations];

  // ── Emit GitHub annotations ───────────────────────────────────────────────
  for (const ann of allAnnotations) {
    annotate(
      ann.level === 'failure' ? 'error' : ann.level === 'warning' ? 'warning' : 'notice',
      ann.path,
      ann.line,
      ann.title,
      ann.message,
    );
  }

  // ── Determine overall status ─────────────────────────────────────────────
  const hasFailures = allAnnotations.some((a) => a.level === 'failure');
  const hasWarnings = allAnnotations.some((a) => a.level === 'warning');
  const status = hasFailures ? 'failure' : hasWarnings ? 'warning' : 'success';

  // ── Post CI run to BCForge ────────────────────────────────────────────────
  const repoOwner = (process.env['GITHUB_REPOSITORY'] ?? '/').split('/')[0] ?? '';
  const repoName = (process.env['GITHUB_REPOSITORY'] ?? '/').split('/')[1] ?? '';
  const ref = process.env['GITHUB_REF'] ?? '';
  const headSha = process.env['GITHUB_SHA'] ?? gitValue('git rev-parse HEAD');
  const prNumber = process.env['GITHUB_REF']?.match(/refs\/pull\/(\d+)\//)
    ? parseInt(process.env['GITHUB_REF'].match(/refs\/pull\/(\d+)\//)![1]!, 10)
    : undefined;
  const triggeredBy = process.env['GITHUB_ACTOR'] ?? undefined;
  const durationMs = Date.now() - startMs;

  try {
    const postRes = await fetch(`${serverUrl}/api/v1/ci-runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        org: orgId,
        workspace: wsId,
        source: 'github_action',
        repoOwner,
        repoName,
        ref,
        headSha,
        prNumber,
        triggeredBy,
        status,
        ruleViolations: ruleAnnotations.filter((a) => a.level === 'failure').length,
        rangeConflicts: conflicts,
        outOfPoolCount: outOfPool,
        annotations: allAnnotations,
        durationMs,
      }),
    });

    if (!postRes.ok) {
      const body = await postRes.text().catch(() => '');
      warning(`BCForge: failed to record CI run — ${postRes.status}: ${body}`);
    } else {
      const { id } = (await postRes.json()) as { id: string };
      info(`BCForge: CI run recorded (${id}).`);
    }
  } catch (err) {
    warning(`BCForge: could not post CI run — ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Push app ranges + object IDs to BCForge ──────────────────────────────
  // This keeps the web UI's range pool and Assignment Explorer in sync with
  // the actual repo state — CI is more reliable than waiting for a dev to open VS Code.
  if (discoveredApps.length > 0 && orgId && wsId) {
    const appsPayload = discoveredApps.map((a) => ({
      id: a.appJson.id,
      name: a.appJson.name,
      publisher: a.appJson.publisher,
      version: a.appJson.version,
      idRanges: a.appJson.idRanges,
      objectIds: (objectsByApp.get(a.appJson.id) ?? []).map((o) => ({
        id: o.id,
        type: o.type,
        name: o.name,
      })),
    }));

    try {
      const pushRes = await fetch(`${serverUrl}/api/v1/ranges`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ org: orgId, workspace: wsId, apps: appsPayload }),
      });
      if (!pushRes.ok) {
        const body = await pushRes.text().catch(() => '');
        warning(`BCForge: failed to push app ranges — ${pushRes.status}: ${body}`);
      } else {
        info(`BCForge: pushed ${appsPayload.length} app(s) with ${alObjects.length} object(s) to workspace.`);
      }
    } catch (err) {
      warning(`BCForge: could not push app ranges — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Set outputs ───────────────────────────────────────────────────────────
  setOutput('status', status);
  setOutput('rule-violations', ruleAnnotations.filter((a) => a.level === 'failure').length);
  setOutput('range-conflicts', conflicts + outOfPool);

  if (status === 'success') {
    info(`BCForge: ✓ all checks passed.`);
  } else {
    info(
      `BCForge: ${ruleAnnotations.length} rule annotation(s), ${conflicts} conflict(s), ${outOfPool} out-of-pool ID(s).`,
    );
  }

  if (failOnViolations && status === 'failure') {
    process.exit(1);
  }
}

run().catch((err) => {
  error(`BCForge: unexpected error — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
