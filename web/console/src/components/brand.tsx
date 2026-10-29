/** D7 品牌要素：Aroomo Logo、名称、额度圆环、在线彩色 / 离线黑白头像。 */
import logoSvg from '@/logo-mark.svg?raw';
import { cn } from '@/lib/utils';

export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-block shrink-0', className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
      // 主人自己的 Logo（单色，currentColor）；内容来自仓库内文件，不含用户输入
      dangerouslySetInnerHTML={{ __html: logoSvg.replace('<svg ', `<svg width="${size}" height="${size}" `) }}
    />
  );
}

export function Brand() {
  return (
    <span className="flex items-center gap-2 font-semibold">
      <Logo />
      <span className="text-[16px]">Aroomo</span>
    </span>
  );
}

/** 0–1 之间；未知时返回 null（圆环显示为空，不编造数字） */
export function quotaFraction(used: number | null | undefined, limit: number | null | undefined): number | null {
  if (used == null || limit == null || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.min(1, Math.max(0, used / limit));
}

export function QuotaRing({ used, limit, size = 28 }: { used?: number | null; limit?: number | null; size?: number }) {
  const f = quotaFraction(used, limit);
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const label = f == null ? '额度：暂无数据' : `额度已用 ${Math.round(f * 100)}%`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
      {f != null && (
        <circle
          data-testid="quota-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={f >= 0.9 ? '#d70015' : 'var(--color-brand)'}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${c * f} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

/** 成员头像：在线彩色、离线黑白（D7）。头像图是 Core 生成的地址；没有时用名字首字。 */
export function MemberAvatar({ name, online, src, size = 40 }: { name: string; online: boolean; src?: string; size?: number }) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <span
      data-online={online ? 'true' : 'false'}
      title={online ? `${name}（在线）` : `${name}（离线）`}
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand font-semibold text-brand-ink',
        !online && 'grayscale opacity-70',
      )}
      style={{ width: size, height: size }}
    >
      {src ? <img src={src} alt="" width={size} height={size} /> : <span aria-hidden="true">{initial}</span>}
    </span>
  );
}
