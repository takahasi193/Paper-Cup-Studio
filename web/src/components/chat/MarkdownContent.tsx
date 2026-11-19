import * as React from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/components/ui/CopyButton.js';
import { cn } from '@/lib/utils.js';

const REMARK_PLUGINS = [remarkGfm];

function safeUrlTransform(url: string): string {
  const transformed = defaultUrlTransform(url);
  if (!transformed) return '';
  const trimmed = transformed.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) {
    return transformed;
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    return transformed;
  }
  const scheme = trimmed.slice(0, colonIdx).toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
    return transformed;
  }
  return '';
}

function extractLanguageFromChildren(children: React.ReactNode): string {
  const list = React.Children.toArray(children);
  for (const child of list) {
    if (React.isValidElement<{ className?: string }>(child)) {
      const cls = child.props?.className;
      if (typeof cls === 'string') {
        const match = cls.match(/language-([A-Za-z0-9_+-]+)/);
        if (match?.[1]) return match[1];
      }
    }
  }
  return '';
}

function MarkdownPreBlock({ children }: { children?: React.ReactNode }) {
  const preRef = React.useRef<HTMLPreElement>(null);
  const lang = extractLanguageFromChildren(children);

  return (
    <div className="pc-md-codeblock pc-copyable">
      <div className="pc-md-code-head">
        <span className="font-mono text-[11px] text-ink-3">{lang || 'code'}</span>
        <CopyButton
          getText={() => preRef.current?.innerText ?? ''}
          ariaLabel="复制代码"
        />
      </div>
      <pre ref={preRef} tabIndex={0} className="pc-scroller">
        {children}
      </pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, node: _node, ...rest }) => {
    const cleanHref = href ? safeUrlTransform(href) : '';
    if (!cleanHref) {
      return <span>{children}</span>;
    }
    const isExternal = /^https?:\/\//i.test(cleanHref);
    return (
      <a
        {...rest}
        href={cleanHref}
        {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </a>
    );
  },
  table: ({ children, node: _node, ...rest }) => (
    <div tabIndex={0} role="region" aria-label="数据表格" className="pc-md-table-wrap pc-scroller">
      <table {...rest}>{children}</table>
    </div>
  ),
  pre: ({ children }) => <MarkdownPreBlock>{children}</MarkdownPreBlock>,
};

const MemoMarkdownBlock = React.memo(function MemoMarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={safeUrlTransform}
      components={MARKDOWN_COMPONENTS}
    >
      {text}
    </Markdown>
  );
});

/**
 * 流式输出阶段按围栏外空行切分已完成块，避免长文本每次增量重解析整篇文档。
 */
function splitStableMarkdownBlocks(text: string): { stable: string[]; tail: string } {
  const lines = text.split('\n');
  const stable: string[] = [];
  let blockStart = 0;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        const trailing = line.slice(fenceMatch[0].length).trim();
        if (!trailing) {
          fenceChar = '';
          fenceLen = 0;
        }
      }
      continue;
    }

    if (!fenceChar && line.trim() === '' && i > blockStart && i < lines.length - 1) {
      const chunk = lines.slice(blockStart, i).join('\n').trim();
      if (chunk) {
        stable.push(chunk);
      }
      blockStart = i + 1;
    }
  }

  const tail = lines.slice(blockStart).join('\n');
  return { stable, tail };
}

interface MarkdownContentProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

export const MarkdownContent = React.memo(function MarkdownContent({
  content,
  isStreaming = false,
  className,
}: MarkdownContentProps) {
  const split = React.useMemo(
    () => (isStreaming ? splitStableMarkdownBlocks(content) : null),
    [content, isStreaming]
  );

  if (!content) return null;

  return (
    <div className={cn('pc-markdown', className)}>
      {split ? (
        <>
          {split.stable.map((block, idx) => (
            <MemoMarkdownBlock key={idx} text={block} />
          ))}
          {split.tail && <MemoMarkdownBlock text={split.tail} />}
        </>
      ) : (
        <MemoMarkdownBlock text={content} />
      )}
    </div>
  );
});
