import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 版本号 + git 短提交（如 0.1.0+0254f8f），让控制台/Core 看得出执行员跑的是哪一版代码。取不到提交（压缩包、没有 git）就只返回版本号。 */
export function versionWithCommit(base: string, cwd: string = dirname(fileURLToPath(import.meta.url)), run: (cwd: string) => string = gitShortSha): string {
  try {
    const sha = run(cwd).trim();
    return /^[0-9a-f]{7,12}$/.test(sha) ? `${base}+${sha}` : base;
  } catch {
    return base;
  }
}

function gitShortSha(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}
