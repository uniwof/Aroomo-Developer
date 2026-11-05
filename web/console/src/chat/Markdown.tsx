/**
 * 回复的 Markdown 渲染（单独打包、按需加载：先出对话框和输入框，Markdown 引擎随后到）。
 * 防注入（负责人审查点 1 必改 3）：
 * - react-markdown 默认不渲染原始 HTML；skipHtml 再明确丢掉 HTML 片段；
 * - 链接和图片地址一律过 safeUrl：只放行 http、https、mailto，其余（javascript:、data:、vbscript:、file:、相对地址……）
 *   一律清空，不靠 react-markdown 默认的 urlTransform（它还放行 irc、xmpp 和相对地址）；
 * - 链接在新标签页打开，并带 rel="noopener noreferrer"。
 */
import { useState, type AnchorHTMLAttributes, type FC } from 'react';
import { MarkdownTextPrimitive, type CodeHeaderProps } from '@assistant-ui/react-markdown';
import { Check, Copy } from 'lucide-react';
import { useAnnounce } from './announce';
import { stripSignature } from './store';

const SAFE_PROTOCOL = /^(https?|mailto):/i;

/** 只放行 http / https / mailto；去掉首尾空白和控制字符后再判断（防「java\tscript:」这类绕过） */
export function safeUrl(url: string | null | undefined): string {
  const u = String(url ?? '')
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  return SAFE_PROTOCOL.test(u) ? u : '';
}

/** 外部链接：新标签页打开，不把来源页交给对方；地址不安全时只显示文字，不做成链接 */
export const SafeLink: FC<AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }> = ({ href, children, node: _node, ...rest }) => {
  const safe = safeUrl(href);
  if (!safe) return <span className="chat-md-badlink">{children}</span>;
  return (
    <a {...rest} href={safe} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};

/** 代码块标题栏：语言名 + 一键复制（复制成功会用读屏播报） */
const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const [done, setDone] = useState(false);
  const announce = useAnnounce();
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setDone(true);
      announce('已复制代码');
      setTimeout(() => setDone(false), 2000);
    });
  };
  return (
    <div className="chat-code-header">
      <span>{language && !/^(text|plain|plaintext|txt)$/i.test(language) ? language : '代码'}</span>
      <button type="button" className="msg-act" onClick={copy} aria-label={done ? '已复制代码' : '复制代码'}>
        {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>{done ? '已复制' : '复制'}</span>
      </button>
    </div>
  );
};

const MarkdownText: FC = () => <MarkdownTextPrimitive skipHtml preprocess={stripSignature} urlTransform={(url) => safeUrl(url)} className="chat-md" components={{ CodeHeader, a: SafeLink }} />;
export default MarkdownText;
