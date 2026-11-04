/** 统一确认服务（D63）的测试工具。 */
import type { FastifyInstance } from 'fastify';
import type { ChallengeJson } from '../../src/confirm/confirm.js';
import { HttpError } from '../../src/http/errors.js';

/** 期望 p 抛出 428 CONFIRM_REQUIRED，返回其中的 challenge。 */
export async function challengeOf(p: Promise<unknown>): Promise<ChallengeJson> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError && err.code === 'CONFIRM_REQUIRED') return (err.extra as { confirm: ChallengeJson }).confirm;
    throw err;
  }
  throw new Error('期望 428 CONFIRM_REQUIRED，实际成功了');
}

type Inject = Awaited<ReturnType<FastifyInstance['inject']>>;

/**
 * HTTP 层走完整的重要确认：发请求 → 428 → 第一次点击 → 拨快 3 秒 → 第二次点击 → 带令牌重发。
 * send(token) 负责发原请求（token 为空表示第一次）。
 */
export async function confirmOverHttp(
  app: FastifyInstance,
  clock: { advance(ms: number): void },
  headers: Record<string, string>,
  send: (confirmToken?: string) => Promise<Inject>,
  opts: { accessJwt?: string } = {},
): Promise<Inject> {
  const first = await send();
  if (first.statusCode !== 428) throw new Error(`期望 428，实际 ${first.statusCode} ${first.body}`);
  const ch = first.json().error.confirm as ChallengeJson;
  const s1 = await app.inject({ method: 'POST', url: ch.stepUrl, headers, payload: { step: 1 } });
  if (s1.statusCode !== 200) throw new Error(`第一步失败 ${s1.statusCode} ${s1.body}`);
  clock.advance(3000);
  const s2 = await app.inject({
    method: 'POST',
    url: ch.stepUrl,
    headers: { ...headers, ...(opts.accessJwt ? { 'cf-access-jwt-assertion': opts.accessJwt } : {}) },
    payload: { step: 2 },
  });
  if (s2.statusCode !== 200) throw new Error(`第二步失败 ${s2.statusCode} ${s2.body}`);
  return send(s2.json().confirmToken as string);
}
