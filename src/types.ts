export interface pkglabConfig {
  version?: number;
  port: number;
  prune_keep: number;
}

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: Record<string, unknown>;
  workspaces?: string[] | { packages: string[] };
  bundledDependencies?: string[];
  [key: string]: unknown;
}

export interface RepoState {
  path: string;
  active: boolean;
  lastUsed?: number;
  packages: Record<string, PackageLink>;
  /** Set before consumer install, cleared after success. Allows crash recovery. */
  pendingUpdate?: PendingUpdate;
}

export interface PendingUpdate {
  /** Packages being updated: name -> previous version entries */
  packages: Record<string, Array<{ dir: string; original: string }>>;
  /** Catalog entries being updated: name -> previous version */
  catalogs?: Record<string, { catalogName: string; catalogFormat?: 'package-json' | 'pnpm-workspace'; original: string }>;
  timestamp: number;
}

export interface PackageLink {
  current: string;
  tag?: string;
  catalogName?: string; // "default" for catalog field, other string for catalogs[name]
  catalogFormat?: 'package-json' | 'pnpm-workspace';
  targets: Array<{ dir: string; original: string }>;
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  packageJson: PackageJson;
  publishable: boolean;
}

export interface PublishPlan {
  timestamp: number;
  packages: PublishEntry[];
  catalogs: Record<string, Record<string, string>>;
}

export interface PublishEntry {
  name: string;
  dir: string;
  version: string;
  rewrittenDeps: Record<string, string>;
}

export interface RepoEntry {
  displayName: string;
  state: RepoState;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  running: boolean;
}
