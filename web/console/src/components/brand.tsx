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

export type AvatarStatus = 'available' | 'sleeping' | 'waiting' | 'warning' | 'cooldown' | 'credit' | 'paused';
const STATUS_ICON: Record<AvatarStatus, { icon: string; text: string }> = {
  available: { icon: '', text: '可用' },
  sleeping: { icon: '🌙', text: '休眠' },
  waiting: { icon: '⏳', text: '等待中' },
  warning: { icon: '⚠', text: '异常' },
  cooldown: { icon: '⌛', text: '限流冷却' },
  credit: { icon: '🪙', text: '余额不足' },
  paused: { icon: '⏸', text: '已暂停' },
};

/** Core 卡片的状态一句话 → 图标状态（未知文字当可用） */
export function statusFromText(s?: string): AvatarStatus {
  if (s === '休眠') return 'sleeping';
  if (s === '候选') return 'waiting';
  if (s === '限流') return 'cooldown';
  return 'available';
}

/**
 * 成员头像（D217，全控制台共用）：Logo/首字母；圆环 = 余量（未知画淡空环，不编数字）；
 * 永久免费实线、试用虚线；不可用降饱和 + 状态图标；干活时流动高光；只用一个强调色。
 */
export function MemberAvatar({
  name,
  online,
  src,
  size = 40,
  used,
  limit,
  free,
  status,
  working,
}: {
  name: string;
  online: boolean;
  src?: string;
  size?: number;
  used?: number | null;
  limit?: number | null;
  free?: 'permanent' | 'trial';
  status?: AvatarStatus;
  working?: boolean;
}) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  const st = status ?? (online ? 'available' : 'sleeping');
  const unavailable = !online || st !== 'available';
  const f = quotaFraction(used, limit);
  const ring = size + 8;
  const r = (ring - 3) / 2;
  const c = 2 * Math.PI * r;
  const dash = free === 'trial' ? '4 3' : undefined;
  const label = [
    name,
    online ? '在线' : '离线',
    STATUS_ICON[st].text,
    f == null ? '余量未知' : `额度已用 ${Math.round(f * 100)}%`,
    free === 'permanent' ? '永久免费' : free === 'trial' ? '试用' : '',
    working ? '正在工作' : '',
  ]
    .filter(Boolean)
    .join('，');
  return (
    <span
      role="img"
      aria-label={label}
      data-online={online ? 'true' : 'false'}
      data-working={working ? 'true' : 'false'}
      className={cn('relative inline-flex shrink-0 items-center justify-center', unavailable && 'grayscale opacity-70')}
      style={{ width: ring, height: ring }}
    >
      <svg width={ring} height={ring} className="absolute inset-0" aria-hidden="true">
        <circle cx={ring / 2} cy={ring / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" strokeDasharray={dash} opacity={f == null ? 0.5 : 1} />
        {f != null && (
          <circle
            data-testid="avatar-arc"
            cx={ring / 2}
            cy={ring / 2}
            r={r}
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={free === 'trial' ? `${c * f} ${c}` : `${c * f} ${c}`}
            transform={`rotate(-90 ${ring / 2} ${ring / 2})`}
          />
        )}
      </svg>
      <span
        className={cn('relative inline-flex items-center justify-center overflow-hidden rounded-full bg-brand font-semibold text-brand-ink', working && 'avatar-working')}
        style={{ width: size, height: size }}
      >
        {src ? <img src={src} alt="" width={size} height={size} /> : <span aria-hidden="true">{initial}</span>}
      </span>
      {STATUS_ICON[st].icon && (
        <span aria-hidden="true" data-testid="avatar-status" className="absolute -bottom-1 -right-1 rounded-full bg-[var(--card)] text-[12px] leading-none">
          {STATUS_ICON[st].icon}
        </span>
      )}
    </span>
  );
}
