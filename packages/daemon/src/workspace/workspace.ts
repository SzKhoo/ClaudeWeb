/**
 * Workspace + WorkspaceManager (invariant #4). A Workspace is an allowlisted root the daemon may
 * operate in; it owns its execution Policy. WorkspaceManager owns the set of workspaces and the active
 * one (Phase 0: exactly one). switch_workspace is its own permission (handled at the Daemon level).
 */

import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { Workspace as ProtocolWorkspace } from "@wcc/shared";
import { Policy } from "../policy/Policy.js";

export interface WorkspaceConfig {
  workspaceId: string;
  name: string;
  /** Absolute allowlisted root on the daemon machine. */
  root: string;
  gitRepo?: boolean;
  defaultBranch?: string;
}

export class Workspace {
  readonly policy = new Policy();
  private readonly rootResolved: string;

  constructor(readonly config: WorkspaceConfig) {
    this.rootResolved = resolve(config.root);
  }

  get workspaceId(): string {
    return this.config.workspaceId;
  }

  get root(): string {
    return this.rootResolved;
  }

  /** True if `candidate` (relative or absolute) resolves to a path inside this workspace root. */
  isPathAllowed(candidate: string): boolean {
    const abs = isAbsolute(candidate)
      ? normalize(candidate)
      : normalize(resolve(this.rootResolved, candidate));
    const rel = relative(this.rootResolved, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  toProtocol(): ProtocolWorkspace {
    return {
      workspaceId: this.config.workspaceId,
      name: this.config.name,
      root: this.rootResolved,
      ...(this.config.gitRepo !== undefined ? { gitRepo: this.config.gitRepo } : {}),
      ...(this.config.defaultBranch !== undefined ? { defaultBranch: this.config.defaultBranch } : {}),
    };
  }
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private activeId: string;

  constructor(configs: WorkspaceConfig[]) {
    if (configs.length === 0) throw new Error("WorkspaceManager requires at least one workspace");
    for (const c of configs) this.workspaces.set(c.workspaceId, new Workspace(c));
    this.activeId = configs[0]!.workspaceId;
  }

  active(): Workspace {
    return this.workspaces.get(this.activeId)!;
  }

  get(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  /** Switch the active workspace. Returns false if unknown. */
  switch(workspaceId: string): boolean {
    if (!this.workspaces.has(workspaceId)) return false;
    this.activeId = workspaceId;
    return true;
  }

  list(): ProtocolWorkspace[] {
    return [...this.workspaces.values()].map((w) => w.toProtocol());
  }
}
