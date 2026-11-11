/**
 * The server-driven UI screen document (docs/SDUI.md). The mobile apps fetch
 * a Screen per key and render its node tree; node `type` names are NOT
 * validated here — an app ignores a type it doesn't know, by design, so a
 * layout can use a widget only the newest build has (gated by minBuild).
 */
import { z } from 'zod';

export const SDUI_SCHEMA_VERSION = 1;
/** Deepest node / condition nesting a document may have. */
export const SDUI_MAX_DEPTH = 32;
/** Largest document body, in bytes of its JSON. */
export const SDUI_MAX_BODY_BYTES = 256 * 1024;
/** Platforms a `platform` condition or a minBuild map may name ('*' = any). */
export const SDUI_PLATFORMS = ['ios', 'android'] as const;
export type SduiPlatform = (typeof SDUI_PLATFORMS)[number];

export interface Condition {
  flag?: string | undefined;
  signedIn?: boolean | undefined;
  platform?: SduiPlatform | undefined;
  minBuild?: number | undefined;
  maxBuild?: number | undefined;
  after?: string | undefined;
  before?: string | undefined;
  eq?: [unknown, unknown] | undefined;
  nonEmpty?: unknown | undefined;
  truthy?: unknown | undefined;
  not?: Condition | undefined;
  all?: Condition[] | undefined;
  any?: Condition[] | undefined;
}

export interface Action {
  type: string;
  [k: string]: unknown;
}

export interface Node {
  type: string;
  id?: string | undefined;
  props?: Record<string, unknown> | undefined;
  children?: Node[] | undefined;
  visible?: Condition | undefined;
  onTap?: Action | undefined;
}

export interface Screen {
  schemaVersion: typeof SDUI_SCHEMA_VERSION;
  /** `${app}.${key}`. */
  screen: string;
  /** Server-assigned on read; whatever a client sends is ignored. */
  version?: number | undefined;
  minBuild?: Record<string, number> | undefined;
  meta?: Record<string, unknown> | undefined;
  root: Node;
}

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Expected an ISO date');
const build = z.number().int().nonnegative();

/** Keys are allowed-listed: a typo in a condition must fail validation, not silently hide a node. */
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z
    .object({
      flag: z.string().min(1),
      signedIn: z.boolean(),
      platform: z.enum(SDUI_PLATFORMS),
      minBuild: build,
      maxBuild: build,
      after: isoDate,
      before: isoDate,
      eq: z.tuple([z.unknown(), z.unknown()]),
      nonEmpty: z.unknown(),
      truthy: z.unknown(),
      not: conditionSchema,
      all: z.array(conditionSchema),
      any: z.array(conditionSchema),
    })
    .partial()
    .strict(),
);

export const actionSchema: z.ZodType<Action> = z
  .object({ type: z.string().min(1) })
  .catchall(z.unknown());

export const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z
    .object({
      type: z.string().min(1),
      id: z.string().min(1).optional(),
      props: z.record(z.unknown()).optional(),
      children: z.array(nodeSchema).optional(),
      visible: conditionSchema.optional(),
      onTap: actionSchema.optional(),
    })
    .strict(),
);

export const minBuildSchema = z.record(z.enum([...SDUI_PLATFORMS, '*']), build);

/** The document as an admin submits it (`screen` is checked against the route by parseScreen). */
export const screenSchema: z.ZodType<Screen> = z
  .object({
    schemaVersion: z.literal(SDUI_SCHEMA_VERSION),
    screen: z.string().min(1),
    version: z.number().int().optional(),
    minBuild: minBuildSchema.optional(),
    meta: z.record(z.unknown()).optional(),
    root: nodeSchema,
  })
  .strict();

function nodeDepth(node: Node, depth: number, limit: number): number {
  if (depth > limit) return depth;
  let max = depth;
  for (const child of node.children ?? []) {
    max = Math.max(max, nodeDepth(child, depth + 1, limit));
    if (max > limit) return max;
  }
  if (node.visible) max = Math.max(max, conditionDepth(node.visible, depth + 1, limit));
  return max;
}

function conditionDepth(cond: Condition, depth: number, limit: number): number {
  if (depth > limit) return depth;
  let max = depth;
  if (cond.not) max = Math.max(max, conditionDepth(cond.not, depth + 1, limit));
  for (const c of [...(cond.all ?? []), ...(cond.any ?? [])]) {
    max = Math.max(max, conditionDepth(c, depth + 1, limit));
    if (max > limit) return max;
  }
  return max;
}

export type ScreenIssue = { path: (string | number)[]; message: string };
export type ParseScreenResult = { ok: true; screen: Screen } | { ok: false; issues: ScreenIssue[] };

/**
 * Validate a submitted document for the screen `${app}.${key}`: shape, the
 * `screen` name, depth and size. On success the returned document has no
 * `version` (the row assigns it) and `screen` normalised.
 */
export function parseScreen(input: unknown, where: { app: string; key: string }): ParseScreenResult {
  const parsed = screenSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) };
  }
  const issues: ScreenIssue[] = [];
  const expected = `${where.app}.${where.key}`;
  if (parsed.data.screen !== expected) {
    issues.push({ path: ['screen'], message: `Expected "${expected}"` });
  }
  if (nodeDepth(parsed.data.root, 1, SDUI_MAX_DEPTH) > SDUI_MAX_DEPTH) {
    issues.push({ path: ['root'], message: `Nesting deeper than ${SDUI_MAX_DEPTH} levels` });
  }
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
  if (bytes > SDUI_MAX_BODY_BYTES) {
    issues.push({ path: [], message: `Body is ${bytes} bytes; the limit is ${SDUI_MAX_BODY_BYTES}` });
  }
  if (issues.length > 0) return { ok: false, issues };
  const { version: _ignored, ...screen } = parsed.data;
  return { ok: true, screen };
}
