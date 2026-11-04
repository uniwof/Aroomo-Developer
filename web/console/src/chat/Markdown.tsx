/**
 * 回复的 Markdown 渲染（单独打包、按需加载：先出对话框和输入框，Markdown 引擎随后到）。
 * react-markdown 默认不渲染原始 HTML；skipHtml 再明确丢掉 HTML 片段（防注入）。
 */
import { useState, type FC } from 'react';
import { MarkdownTextPrimitive, type CodeHeaderProps } from '@assistant-ui/react-markdown';
import { Check, Copy } from 'lucide-react';
import { useAnnounce } from './announce';

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
      <span>{language || '代码'}</span>
      <button type="button" className="chat-btn chat-btn-ghost" onClick={copy} aria-label={done ? '已复制代码' : '复制代码'}>
        {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>{done ? '已复制' : '复制'}</span>
      </button>
    </div>
  );
};

const MarkdownText: FC = () => <MarkdownTextPrimitive skipHtml className="chat-md" components={{ CodeHeader }} />;
export default MarkdownText;
