/**
 * 打开对话页时的骨架屏（所有者 11-05：不要「正在打开对话…」一行字，要大平台那样的占位）。
 * - 静态，不闪不动（所有者「无动画」）。微光效果只在 SKELETON_SHIMMER 打开时加 .sk--shimmer，默认关。
 * - 读屏：外层 aria-busy="true"，里面一句看不见的「正在打开对话」；灰块全部 aria-hidden。
 * - index.html 的 #root 里有一份一模一样的静态 HTML（JS 还没下载完就先画出来，CSS 在 src/skeleton.css 随首屏样式一起到）。
 *   两份必须一致，test/skeleton.test.tsx 会逐字比对；改这里就同步改 index.html。
 * - 版式跟着对话页：≥48em 有窄栏，≥64em 有会话列表栏，手机只有顶栏 + 消息 + 输入卡（和 ChatPage 的 useLayout 同一断点）。
 */
import { SKELETON_SHIMMER } from '@/lib/flags';

const ROWS = [0, 1, 2, 3, 4, 5];
/** 每条消息正文几行、各多宽（sk-w* 类名，静态 HTML 里不能写 style） */
const MSGS: string[][] = [['w40'], ['w90', 'w75', 'w55'], ['w30'], ['w85', 'w60']];

export function AppSkeleton({ shimmer = SKELETON_SHIMMER }: { shimmer?: boolean }) {
  return (
    <div className={shimmer ? 'sk sk--shimmer' : 'sk'} data-skeleton="" aria-busy="true">
      <p className="sk-sr" role="status" aria-live="polite">正在打开对话</p>
      <div className="sk-rail" aria-hidden="true">
        <span className="sk-logo"></span>
        <span className="sk-b sk-icon"></span>
        <span className="sk-b sk-icon"></span>
        <span className="sk-b sk-icon"></span>
        <span className="sk-b sk-icon"></span>
      </div>
      <div className="sk-side" aria-hidden="true">
        <div className="sk-side-head"><span className="sk-b sk-title"></span></div>
        <span className="sk-b sk-search"></span>
        {ROWS.map((i) => (
          <div className="sk-row" key={i}>
            <span className="sk-b sk-avatar"></span>
            <span className="sk-lines"><span className="sk-b sk-line sk-w50"></span><span className="sk-b sk-line sk-w80"></span></span>
          </div>
        ))}
      </div>
      <div className="sk-main" aria-hidden="true">
        <div className="sk-head">
          <span className="sk-b sk-avatar sk-avatar-sm"></span>
          <span className="sk-b sk-line sk-head-title"></span>
        </div>
        <div className="sk-col sk-msgs">
          {MSGS.map((lines, i) => (
            <div className="sk-msg" key={i}>
              <span className="sk-b sk-avatar sk-avatar-sm"></span>
              <span className="sk-lines">
                <span className="sk-b sk-line sk-name"></span>
                {lines.map((w, j) => (
                  <span className={`sk-b sk-line sk-${w}`} key={j}></span>
                ))}
              </span>
            </div>
          ))}
        </div>
        <div className="sk-col sk-composer"><span className="sk-send"></span></div>
      </div>
    </div>
  );
}
