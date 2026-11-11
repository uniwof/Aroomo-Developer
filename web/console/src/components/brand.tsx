/** D7 品牌要素：Aroomo Logo、名称、额度圆环、在线彩色 / 离线黑白头像。 */
import logoSvg from '@/logo-mark.svg?raw';
import type { ReactNode } from 'react';
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
      <span >Aroomo</span>
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

/** 试用：把剩余弧长切成虚线段 */
function trialDash(len: number): string {
  const seg = 4 + 3;
  const n = Math.max(1, Math.round(len / seg));
  return Array.from({ length: n }, () => '4 3').join(' ') + ' 0 9999';
}

export type AvatarStatus = 'available' | 'sleeping' | 'cooldown' | 'warning' | 'trial' | 'credit' | 'paused';
const STATUS_ICON: Record<AvatarStatus, { icon: string; text: string }> = {
  available: { icon: '', text: '可用' },
  sleeping: { icon: '🌙', text: '今天已用完' },
  cooldown: { icon: '⏳', text: '限流' },
  warning: { icon: '⚠', text: 'Key 失效' },
  trial: { icon: '⌛', text: '试用剩 3 天内' },
  credit: { icon: '🪙', text: '超额计费' },
  paused: { icon: '⏸', text: '已停用' },
};

/** Core 卡片的状态一句话 → 图标状态（未知文字当可用） */
export function statusFromText(s?: string): AvatarStatus {
  if (!s) return 'available';
  if (s === '休眠' || s.includes('用完')) return 'sleeping';
  if (s.includes('限流')) return 'cooldown';
  if (s.includes('失效') || s.includes('异常')) return 'warning';
  if (s.includes('试用')) return 'trial';
  if (s.includes('超额')) return 'credit';
  if (s.includes('停用') || s.includes('暂停')) return 'paused';
  return 'available';
}

/**
 * 成员头像（D217，全控制台共用）：Logo/首字母，或传进来的头像（children，如对话页的 Aroomo 头像）；
 * 外圈圆环 = 余量（未知画灰色虚线整圈，不编数字）；永久免费实线、试用虚线；不可用降饱和 + 状态图标；只用一个强调色。
 * 圆环用 viewBox 画，跟着里面头像的大小走（头像随字号放大时圆环一起放大）。
 * 不做「干活时流动高光」：所有者不要动画（负责人 #214 审查也建议删）。
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
  statusLabel,
  children,
}: {
  name: string;
  online: boolean;
  src?: string;
  size?: number;
  used?: number | null;
  limit?: number | null;
  free?: 'permanent' | 'trial';
  status?: AvatarStatus;
  /** 读屏的状态字，给了就用它（和行内状态同一个来源，#389），不再从 online/status 推 */
  statusLabel?: string;
  children?: ReactNode;
}) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  const st = status ?? (online ? 'available' : 'sleeping');
  const unavailable = !online || st !== 'available';
  const f = quotaFraction(used, limit);
  const V = 48;
  const r = (V - 3) / 2;
  const c = 2 * Math.PI * r;
  const dash = free === 'trial' ? '4 3' : undefined;
  const label = [
    name,
    ...(statusLabel ? [statusLabel] : [online ? '在线' : '离线', online || st !== 'available' ? STATUS_ICON[st].text : '']),
    f == null ? '余量未知' : `额度剩余 ${Math.round((1 - f) * 100)}%`,
    free === 'permanent' ? '永久免费' : free === 'trial' ? '试用' : '',
  ]
    .filter(Boolean)
    .join('，');
  return (
    <span
      role="img"
      aria-label={label}
      data-online={online ? 'true' : 'false'}
      // 传进来的是圆角方头像：留宽一点，圆环不压到方块的角
      className={cn('relative inline-flex shrink-0 items-center justify-center', children ? 'p-2' : 'p-1', unavailable && 'grayscale opacity-70')}
    >
      <svg viewBox={`0 0 ${V} ${V}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
        {/* #383 余量未知：灰色细虚线整圈，和 0%（整圈强调色）、100%（只剩浅底环）分得开 */}
        <circle cx={V / 2} cy={V / 2} r={r} fill="none" {...(f == null ? { stroke: 'var(--muted)', strokeWidth: 1.5, strokeDasharray: '2 4', 'data-testid': 'avatar-ring-unknown' } : { stroke: 'var(--border)', strokeWidth: 2.5, strokeDasharray: dash })} />
        {f != null && (
          <circle
            data-testid="avatar-arc"
            cx={V / 2}
            cy={V / 2}
            r={r}
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={free === 'trial' ? trialDash(c * (1 - f)) : `${c * (1 - f)} ${c}`}
            transform={`rotate(-90 ${V / 2} ${V / 2})`}
          />
        )}
      </svg>
      {children ?? (
        <span className="relative inline-flex items-center justify-center overflow-hidden rounded-full bg-brand font-semibold text-brand-ink" style={{ width: size, height: size }}>
          {src ? <img src={src} alt="" width={size} height={size} /> : <span aria-hidden="true">{initial}</span>}
        </span>
      )}
      {STATUS_ICON[st].icon && (
        <span aria-hidden="true" data-testid="avatar-status" className="absolute -bottom-1 -right-1 rounded-full bg-[var(--card)] leading-none">
          {STATUS_ICON[st].icon}
        </span>
      )}
    </span>
  );
}
