import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * True if `cmd` resolves on PATH. Uses the platform's lookup tool rather than
 * spawning the binary (which could hang or have side effects). We pass the bare
 * command name (no shell metacharacters) so this is safe to interpolate.
 */
export async function commandOnPath(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    const { stdout } = await execAsync(probe, { timeout: 4000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
