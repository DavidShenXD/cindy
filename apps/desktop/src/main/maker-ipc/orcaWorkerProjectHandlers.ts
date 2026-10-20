import path from 'node:path';
import type { AgentKind } from '@cindy/maker-core';
import type {
  WorkerProjectContext,
  WorkerProjectInfo,
  WorkerWorktreeRequest,
} from '../../shared/orca-worker-project';
import { isOrcaWorkerPermissionMode } from '../../shared/orca-worker-permission-mode';
import { throwIpcError } from '../utils/ipcValidate';
import {
  normalizeOrcaWorkerLabel,
  pickWorkerAgentDeviceId,
  type OrcaWorkerCreateParams,
  type OrcaWorkerCreationResult,
} from './orcaWorkerCreationService';
import type { OrcaEnableTeamParams } from './orcaLifecycleService';
import type { OrcaWorkerEffort } from './orcaTeamService';
import { throwOrcaServiceFailure } from './orcaServiceFailure';

interface ProjectSession {
  id: string;
  workingDir: string | null;
  worktreePath?: string | null;
  workspaceKind?: string | null;
  remoteHostId?: string | null;
  orcaRole?: string | null;
}

interface WorkerProjectHandlerDeps<Event, Owner, EnableResult> {
  isDeviceLinkInvoke(): boolean;
  assertTrustedAppRendererEvent(event: Event): void;
  getOwner(): Owner | null;
  getSession(owner: Owner, id: string): Promise<ProjectSession | undefined>;
  getTeamByWorkerSession(id: string): Promise<{ leadSessionId: string } | null>;
  readContext(lead: ProjectSession): Promise<WorkerProjectContext>;
  probe(directory: string, details: boolean): Promise<WorkerProjectInfo>;
  remember(directory: string, ownerId: string): Promise<void>;
  assertLeadCollabProjectEnabled(id: string): Promise<void>;
  createWorker(params: OrcaWorkerCreateParams): Promise<OrcaWorkerCreationResult>;
  enableTeam(params: OrcaEnableTeamParams): Promise<EnableResult>;
  log: { warn(message: string, meta: Record<string, unknown>): void };
}

/** Local project IPC adapters. Legacy requests bypass local-only reads and retain their wire semantics. */
export function createOrcaWorkerProjectHandlers<
  Event,
  Owner extends { userId: string },
  EnableResult,
>(deps: WorkerProjectHandlerDeps<Event, Owner, EnableResult>) {
  // Local-only project reads. These channels intentionally do not enter device-link's allowlist.
  async function localWorkerProjectLead(event: Event, id: unknown) {
    if (deps.isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'Local project UI required');
    deps.assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !id || id.length > 128)
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    const owner = deps.getOwner();
    if (!owner) throwIpcError('INTERNAL', 'Task storage unavailable');
    const lead = await deps.getSession(owner, id);
    if (deps.getOwner() !== owner) throwIpcError('PERMISSION_DENIED', 'Account changed');
    if (!lead || lead.remoteHostId) throwIpcError('INVALID_PARAMS', 'Local project required');
    return { lead, owner };
  }

  async function context(event: Event, id: unknown, directory?: unknown) {
    const { lead, owner } = await localWorkerProjectLead(event, id);
    if (
      directory !== undefined &&
      (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 32768)
    ) {
      throwIpcError('INVALID_PARAMS', 'Absolute project directory required');
    }
    // A project change reads only its target; the renderer retains this opening's list.
    const context =
      typeof directory === 'string'
        ? await deps.probe(directory, true)
        : await deps.readContext(lead);
    if (deps.getOwner() !== owner) throwIpcError('PERMISSION_DENIED', 'Account changed');
    return context;
  }

  async function label(event: Event, workerSessionId: unknown) {
    const { lead: worker, owner } = await localWorkerProjectLead(event, workerSessionId);
    if (worker.orcaRole !== 'worker') return null;
    const team = await deps.getTeamByWorkerSession(worker.id);
    if (!team) return null;
    const { lead } = await localWorkerProjectLead(event, team.leadSessionId);
    if (!worker.workingDir || !lead.workingDir) return null;
    const [workerProject, leadProject] = await Promise.all([
      deps.probe(worker.workingDir, false),
      deps.probe(lead.workingDir, false),
    ]);
    if (deps.getOwner() !== owner) throwIpcError('PERMISSION_DENIED', 'Account changed');
    const workerBase = workerProject.baseRepo ?? worker.workingDir;
    const leadBase = leadProject.baseRepo ?? lead.workingDir;
    const sameProject =
      process.platform === 'win32'
        ? workerBase.toLowerCase() === leadBase.toLowerCase()
        : workerBase === leadBase;
    return sameProject ? null : { name: path.basename(workerBase), path: workerBase };
  }

  async function localWorkerProjectOptions(
    event: Event,
    id: string,
    body: Record<string, unknown>,
  ) {
    const requested =
      body.worktree !== undefined ||
      body.projectPath !== undefined ||
      (body.workingDir !== undefined && !body.executionDeviceId);
    if (!requested) return { fields: {}, remember: async () => {} };
    const { lead, owner } = await localWorkerProjectLead(event, id);
    if (body.executionDeviceId)
      throwIpcError('INVALID_PARAMS', 'Worker project options require local execution');
    if (
      body.workingDir !== undefined &&
      (typeof body.workingDir !== 'string' ||
        !path.isAbsolute(body.workingDir) ||
        body.workingDir.length > 32768)
    ) {
      throwIpcError('INVALID_PARAMS', 'Absolute workingDir required');
    }
    if (
      body.projectPath !== undefined &&
      (typeof body.projectPath !== 'string' ||
        !path.isAbsolute(body.projectPath) ||
        body.projectPath.length > 32768)
    ) {
      throwIpcError('INVALID_PARAMS', 'Absolute projectPath required');
    }
    let worktree: WorkerWorktreeRequest | undefined;
    if (body.worktree !== undefined) {
      const source = (body.worktree as WorkerWorktreeRequest | null)?.sourceBranch;
      if (
        typeof source !== 'string' ||
        !source ||
        source.length > 1024 ||
        source.startsWith('-') ||
        Array.from(source).some((character) => character.charCodeAt(0) < 32)
      ) {
        throwIpcError('INVALID_PARAMS', 'Worktree sourceBranch required');
      }
      if (lead.workspaceKind === 'dialogue' && body.workingDir === undefined)
        throwIpcError('INVALID_PARAMS', 'Worker worktree requires a project');
      worktree = { sourceBranch: source };
    }
    return {
      fields: {
        ...(typeof body.workingDir === 'string' ? { workingDir: body.workingDir } : {}),
        ...(worktree ? { worktree } : {}),
      },
      remember: async () => {
        if (typeof body.projectPath !== 'string' || deps.getOwner() !== owner) return;
        try {
          await deps.remember(body.projectPath, owner.userId);
        } catch (error) {
          deps.log.warn('Worker project history could not be saved', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };
  }

  async function enable(event: Event, leadSessionId: unknown, opts: unknown) {
    if (typeof leadSessionId !== 'string')
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    const body = (opts ?? {}) as {
      workerAgent?: unknown;
      delegateTask?: unknown;
      role?: unknown;
      label?: unknown;
      model?: unknown;
      effort?: unknown;
      fast?: unknown;
      providerId?: unknown;
      workerPermissionMode?: unknown;
      deferDelegateTask?: unknown;
      executionDeviceId?: unknown;
      workingDir?: unknown;
      worktree?: unknown;
      projectPath?: unknown;
      agentDeviceId?: unknown;
    };
    const workerAgent: AgentKind =
      body.workerAgent === 'codex' ? 'codex' : body.workerAgent === 'pi' ? 'pi' : 'claude-code';
    const delegateTask = typeof body.delegateTask === 'string' ? body.delegateTask : undefined;
    if (
      body.workerPermissionMode !== undefined &&
      !isOrcaWorkerPermissionMode(body.workerPermissionMode)
    ) {
      throwIpcError('INVALID_PARAMS', 'workerPermissionMode must be auto or bypassPermissions');
    }
    if (body.deferDelegateTask !== undefined && typeof body.deferDelegateTask !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'deferDelegateTask must be a boolean');
    }
    const project = await localWorkerProjectOptions(event, leadSessionId, body);
    const result = await deps.enableTeam({
      leadSessionId,
      ...project.fields,
      workerAgent,
      delegateTask,
      role: typeof body.role === 'string' ? body.role : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? (body.effort as OrcaWorkerEffort) : undefined,
      fast: typeof body.fast === 'boolean' ? body.fast : undefined,
      // 只认非空(trim 后)string 为显式来源;其余(null/空白/缺省/异型)一律按「未显式」处理。
      providerId:
        typeof body.providerId === 'string' && body.providerId.trim().length > 0
          ? body.providerId.trim()
          : undefined,
      workerPermissionMode: body.workerPermissionMode,
      deferDelegateTask: body.deferDelegateTask,
      // 运行设备与那台上的目录(可选)；旧控制端不带，行为不变。
      ...(typeof body.executionDeviceId === 'string' && body.executionDeviceId.trim()
        ? {
            executionDeviceId: body.executionDeviceId.trim(),
            ...(typeof body.workingDir === 'string' && body.workingDir.trim()
              ? { workingDir: body.workingDir.trim() }
              : {}),
          }
        : {}),
      // 首个 Worker 的 Agent 所在位置(远程供应商)；旧控制端不带 = 跟 Lead。
      ...pickWorkerAgentDeviceId(body.agentDeviceId),
    });
    await project.remember();
    return result;
  }
  async function create(event: Event, body: unknown) {
    const b = body as Record<string, unknown> | null | undefined;
    if (!b || typeof b.leadSessionId !== 'string')
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    if (typeof b.role !== 'string' || b.role.length < 1 || b.role.length > 32)
      throwIpcError('INVALID_PARAMS', 'role must be 1-32 chars');
    if (typeof b.label !== 'string') throwIpcError('INVALID_PARAMS', 'label required');
    const label = normalizeOrcaWorkerLabel(b.label);
    if (!label.ok) throwIpcError('INVALID_PARAMS', label.message);
    const agent =
      b.agent === 'codex'
        ? ('codex' as const)
        : b.agent === 'pi'
          ? ('pi' as const)
          : ('claude-code' as const);
    const model = typeof b.model === 'string' && b.model.length > 0 ? b.model : undefined;
    if (
      b.workerPermissionMode !== undefined &&
      !isOrcaWorkerPermissionMode(b.workerPermissionMode)
    ) {
      throwIpcError('INVALID_PARAMS', 'workerPermissionMode must be auto or bypassPermissions');
    }
    const project = await localWorkerProjectOptions(event, b.leadSessionId, b);
    await deps.assertLeadCollabProjectEnabled(b.leadSessionId);
    const result = await deps.createWorker({
      ...project.fields,
      leadSessionId: b.leadSessionId,
      role: b.role,
      agent,
      model,
      effort: typeof b.effort === 'string' ? (b.effort as OrcaWorkerEffort) : undefined,
      fast: typeof b.fast === 'boolean' ? b.fast : undefined,
      // 只认非空(trim 后)string 为显式来源;其余(null/空白/缺省/异型)一律按「未显式」处理。
      providerId:
        typeof b.providerId === 'string' && b.providerId.trim().length > 0
          ? b.providerId.trim()
          : undefined,
      workerPermissionMode: b.workerPermissionMode,
      label: label.value,
      initialTask:
        typeof b.initialTask === 'string' && b.initialTask.length > 0 ? b.initialTask : undefined,
      // 运行设备与那台上的目录(可选)；旧控制端不带，行为不变。
      ...(typeof b.executionDeviceId === 'string' && b.executionDeviceId.trim()
        ? {
            executionDeviceId: b.executionDeviceId.trim(),
            ...(typeof b.workingDir === 'string' && b.workingDir.trim()
              ? { workingDir: b.workingDir.trim() }
              : {}),
          }
        : {}),
      // Worker 的 Agent 所在位置(远程供应商)；旧控制端不带 = 跟 Lead。
      ...pickWorkerAgentDeviceId(b.agentDeviceId),
    });
    if (!result.ok) throwOrcaServiceFailure(result);
    await project.remember();
    return {
      ok: true,
      workerId: result.workerId,
      workerSessionId: result.workerSessionId,
      softLimitExceeded: result.softLimitExceeded,
      ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
      ...(result.dispatchOutcome ? { dispatchOutcome: result.dispatchOutcome } : {}),
    };
  }

  return { context, label, create, enable };
}
