import * as vscode from 'vscode';

export interface TaskSummary {
  name: string;
  source: string;
  type?: string;
  group?: string;
  isBackground?: boolean;
  scope?: string;
  detail?: string;
}

function describeScope(scope: vscode.TaskScope | vscode.WorkspaceFolder | undefined): string {
  if (scope === undefined) return 'unknown';
  if (scope === vscode.TaskScope.Global) return 'global';
  if (scope === vscode.TaskScope.Workspace) return 'workspace';
  return (scope as vscode.WorkspaceFolder).name;
}

export async function listTasks(): Promise<TaskSummary[]> {
  const tasks = await vscode.tasks.fetchTasks();
  return tasks.map((t) => ({
    name: t.name,
    source: t.source,
    type: t.definition?.type,
    group: t.group?.id,
    isBackground: t.isBackground,
    scope: describeScope(t.scope),
    detail: t.detail
  }));
}

async function findTask(name: string, source?: string): Promise<vscode.Task> {
  const tasks = await vscode.tasks.fetchTasks();
  let candidates = tasks.filter((t) => t.name === name);
  if (source) candidates = candidates.filter((t) => t.source === source);
  if (!candidates.length) throw new Error(`No task found with name "${name}"${source ? ` and source "${source}"` : ''}`);
  if (candidates.length > 1 && !source) {
    const sources = candidates.map((t) => t.source).join(', ');
    throw new Error(`Multiple tasks match "${name}". Disambiguate with source: ${sources}`);
  }
  return candidates[0];
}

export async function runTask(name: string, source?: string): Promise<{ taskName: string; source: string }> {
  const task = await findTask(name, source);
  await vscode.tasks.executeTask(task);
  return { taskName: task.name, source: task.source };
}

export interface RunningTaskInfo {
  name: string;
  source: string;
  type?: string;
}

export function listRunningTasks(): RunningTaskInfo[] {
  return vscode.tasks.taskExecutions.map((e) => ({
    name: e.task.name,
    source: e.task.source,
    type: e.task.definition?.type
  }));
}

export async function stopTask(name: string, source?: string): Promise<{ stopped: number }> {
  let stopped = 0;
  for (const exec of vscode.tasks.taskExecutions) {
    if (exec.task.name === name && (!source || exec.task.source === source)) {
      exec.terminate();
      stopped++;
    }
  }
  return { stopped };
}
