/**
 * 统一错误响应：{ error: { code, message } }。message 一律是给用户看的中文短句，
 * 不透传底层错误原文（底层原文可能含密钥，PRODUCT 0.4）。
 */
import type { FastifyError, FastifyInstance } from 'fastify';

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST') => new HttpError(400, code, message);
export const notFound = (message = '找不到该对象') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (message: string, code = 'CONFLICT', extra?: Record<string, unknown>) =>
  new HttpError(409, code, message, extra);

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, ...(err.extra ?? {}) } });
    }
    const fe = err as FastifyError;
    if (fe.validation) {
      // 只返回字段路径，不返回字段值（请求体里可能有 Key）
      const fields = fe.validation.map((v) => v.instancePath || (v.params as { missingProperty?: string }).missingProperty || '');
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: '请求参数不合法', fields } });
    }
    if (typeof fe.statusCode === 'number' && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'BAD_REQUEST', message: '请求不合法' } });
    }
    req.log.error({ errName: fe.name, errCode: fe.code }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误，请稍后再试' } });
  });
}
