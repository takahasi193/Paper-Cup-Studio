import * as React from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/components/ui/CopyButton.js';
import { cn } from '@/lib/utils.js';

const REMARK_PLUGINS = [remarkGfm];

export function safeUrlTransform(url: string): string {
  const raw = String(url ?? '').trim();
  // Explicitly reject protocol-relative URLs (//evil.example) and backslash variants (/\evil, \\evil)
  if (!raw || /^\/[\\/]/.test(raw) || raw.startsWith('\\')) {
    return '';
  }
  const transformed = defaultUrlTransform(raw);
  if (!transformed) return '';
  const trimmed = transformed.trim();
  if (!trimmed || /^\/[\\/]/.test(trimmed) || trimmed.startsWith('\\')) {
    return '';
  }
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

export function isExternalUrl(url: string): boolean {
  return /^(?:https?:)?\/\//i.test(String(url ?? '').trim());
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, node: _node, ...rest }) => {
    const cleanHref = href ? safeUrlTransform(href) : '';
    if (!cleanHref) {
      return <span>{children}</span>;
    }
    const isExternal = isExternalUrl(cleanHref);
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

const LIST_ITEM_LINE_RE = /^\s{0,3}(?:\d+[.)]|[-*+])\s+/;
const BLOCKQUOTE_LINE_RE = /^\s{0,3}>/;
const INDENTED_CONTINUATION_RE = /^(?:\t| {2,})\S/;
const REFERENCE_LINK_OR_DEF_RE = /(?:^|\n)\s{0,3}\[[^\]]+\]:\s*\S|\]\[[^\]]*\]/;

/**
 * 流式输出阶段按围栏外安全空行切分已完成块，避免长文本每次增量重解析整篇文档。
 * 保留引用式链接文档完整解析，并避免在松散列表/引用块中间切分导致编号归零或块断裂。
 */
export function splitStableMarkdownBlocks(text: string): { stable: string[]; tail: string } {
  if (!text || REFERENCE_LINK_OR_DEF_RE.test(text)) {
    return { stable: [], tail: text };
  }

  const lines = text.split('\n');
  const stable: string[] = [];
  let blockStart = 0;
  let fenceChar = '';
  let fenceLen = 0;

  const findNextNonEmptyLine = (fromIndex: number): string | null => {
    for (let j = fromIndex; j < lines.length; j += 1) {
      if (lines[j].trim() !== '') return lines[j];
    }
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
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
      const nextNonEmpty = findNextNonEmptyLine(i + 1);
      if (nextNonEmpty === null) continue;

      const chunkLines = lines.slice(blockStart, i);
      const startsList = LIST_ITEM_LINE_RE.test(chunkLines[0] ?? '');
      const startsQuote = BLOCKQUOTE_LINE_RE.test(chunkLines[0] ?? '');
      const nextContinuesList =
        startsList &&
        (LIST_ITEM_LINE_RE.test(nextNonEmpty) || INDENTED_CONTINUATION_RE.test(nextNonEmpty));
      const nextContinuesQuote = startsQuote && BLOCKQUOTE_LINE_RE.test(nextNonEmpty);

      if (nextContinuesList || nextContinuesQuote) {
        continue;
      }

      const chunk = chunkLines.join('\n').trim();
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
