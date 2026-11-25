import * as React from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type {
  CharacterAlias,
  CharacterGender,
  ChatFormExcludedItem,
  ChatFormRecord,
  SubmitChatFormItemPayload,
} from '@/lib/api.js';
import { cn } from '@/lib/utils.js';

interface EditableCharacterRow {
  id: string;
  sourceName: string;
  defaultTarget: string;
  targetName: string;
  speakerIds: string[];
  aliases: CharacterAlias[];
  gender: CharacterGender;
  note: string;
  occurrences: number;
  samples: string[];
  isCustom?: boolean;
}

export interface CharacterRosterFormCardProps {
  form: ChatFormRecord;
  isTurnBusy?: boolean;
  onSubmitForm: (
    formId: string,
    payload: { items: SubmitChatFormItemPayload[]; dismissedNames?: string[]; autoContinue: boolean }
  ) => Promise<void>;
  onCancelForm?: (formId: string) => Promise<void>;
}

const GENDER_OPTIONS: Array<{ value: CharacterGender; label: string }> = [
  { value: 'female', label: '女' },
  { value: 'male', label: '男' },
  { value: 'unknown', label: '未知' },
  { value: 'other', label: '其他' },
];

const GENDER_LABEL_MAP: Record<CharacterGender, string> = {
  female: '女',
  male: '男',
  unknown: '未知',
  other: '其他',
};

function toEditableRows(form: ChatFormRecord): EditableCharacterRow[] {
  return form.items.map((it) => ({
    id: it.id,
    sourceName: it.sourceName,
    defaultTarget: it.defaultTarget,
    targetName: it.targetName || it.defaultTarget,
    speakerIds: [...(it.speakerIds || [])],
    aliases: (it.aliases || []).map((a) => ({ ...a })),
    gender: it.gender || 'unknown',
    note: it.note || '',
    occurrences: it.occurrences || 0,
    samples: [...(it.samples || [])],
  }));
}

function validateRow(
  row: EditableCharacterRow,
  allRows: readonly EditableCharacterRow[]
): { sourceError?: string; targetError?: string } {
  const src = row.sourceName.trim();
  const tgt = row.targetName.trim();
  let sourceError: string | undefined;
  let targetError: string | undefined;

  if (!src) {
    sourceError = '请输入角色原名。';
  } else if (/[\r\n]/.test(src)) {
    sourceError = '角色原名不能包含换行符。';
  } else if (allRows.filter((r) => r.sourceName.trim() === src).length > 1) {
    sourceError = `角色原名「${src}」重复，请合并或修改。`;
  }

  if (!tgt) {
    targetError = '请输入固定中文译名。';
  } else if (/[\r\n]/.test(tgt)) {
    targetError = '角色译名不能包含换行符。';
  }

  return { sourceError, targetError };
}

export function CharacterRosterFormCard({
  form,
  isTurnBusy = false,
  onSubmitForm,
  onCancelForm,
}: CharacterRosterFormCardProps) {
  const baseId = React.useId();
  const headingId = `${baseId}-heading`;
  const searchInputId = `${baseId}-search`;

  const [rows, setRows] = React.useState<EditableCharacterRow[]>(() => toEditableRows(form));
  const [excludedRows, setExcludedRows] = React.useState<ChatFormExcludedItem[]>(() => [
    ...(form.excludedItems || []),
  ]);
  const [showExcluded, setShowExcluded] = React.useState(false);
  const [isReediting, setIsReediting] = React.useState(false);
  const [filterQuery, setFilterQuery] = React.useState('');
  const [expandedRowIds, setExpandedRowIds] = React.useState<Set<string>>(() => new Set());
  const [touchedFields, setTouchedFields] = React.useState<Set<string>>(() => new Set());
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isCancelling, setIsCancelling] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = React.useState('');
  const [showAllLocked, setShowAllLocked] = React.useState(false);

  const inputRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());
  const customSeqRef = React.useRef(0);
  const lastFormVersionRef = React.useRef(`${form.formId}:${form.updatedAt}:${form.status}`);

  React.useEffect(() => {
    const ver = `${form.formId}:${form.updatedAt}:${form.status}`;
    if (ver !== lastFormVersionRef.current) {
      lastFormVersionRef.current = ver;
      setRows(toEditableRows(form));
      setExcludedRows([...(form.excludedItems || [])]);
      setTouchedFields(new Set());
      setHasAttemptedSubmit(false);
      setSubmitError(null);
      if (form.status !== 'pending') {
        setIsReediting(false);
      }
    }
  }, [form]);

  const isEditable = form.status === 'pending' || (form.status === 'submitted' && isReediting);

  const editedCount = React.useMemo(
    () =>
      rows.filter(
        (r) =>
          r.isCustom ||
          r.targetName.trim() !== r.defaultTarget.trim()
      ).length,
    [rows]
  );

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const visibleRows = React.useMemo(() => {
    if (!normalizedFilter) return rows;
    return rows.filter(
      (r) =>
        r.sourceName.toLowerCase().includes(normalizedFilter) ||
        r.targetName.toLowerCase().includes(normalizedFilter) ||
        r.note.toLowerCase().includes(normalizedFilter) ||
        r.speakerIds.some((s) => s.toLowerCase().includes(normalizedFilter))
    );
  }, [rows, normalizedFilter]);

  const markFieldTouched = (fieldKey: string) => {
    setTouchedFields((prev) => {
      if (prev.has(fieldKey)) return prev;
      const next = new Set(prev);
      next.add(fieldKey);
      return next;
    });
  };

  const updateRow = (rowId: string, patch: Partial<EditableCharacterRow>) => {
    setSubmitError(null);
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  };

  const handleAddCustomRow = () => {
    const newId = `custom_${Date.now().toString(36)}_${++customSeqRef.current}`;
    setRows((prev) => [
      ...prev,
      {
        id: newId,
        sourceName: '',
        defaultTarget: '',
        targetName: '',
        speakerIds: [],
        aliases: [],
        gender: 'unknown',
        note: '',
        occurrences: 0,
        samples: [],
        isCustom: true,
      },
    ]);
    setFilterQuery('');
    requestAnimationFrame(() => {
      inputRefs.current.get(`src:${newId}`)?.focus();
    });
  };

  const handleDismissOrRemoveRow = (row: EditableCharacterRow) => {
    setSubmitError(null);
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    setExpandedRowIds((prev) => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    const src = row.sourceName.trim();
    if (!row.isCustom && src) {
      setExcludedRows((prev) => {
        if (prev.some((e) => e.sourceName === src)) return prev;
        return [
          ...prev,
          {
            sourceName: src,
            reason: '手动标为非角色项',
            occurrences: row.occurrences,
            samples: row.samples,
          },
        ];
      });
      setLiveAnnouncement(`已将「${src}」移入非角色排除列表。`);
    }
  };

  const handleRestoreExcluded = (item: ChatFormExcludedItem) => {
    setSubmitError(null);
    setExcludedRows((prev) => prev.filter((e) => e.sourceName !== item.sourceName));
    const orig = form.items.find((it) => it.sourceName === item.sourceName);
    const restoredId = orig?.id || `restored_${Date.now().toString(36)}_${++customSeqRef.current}`;
    setRows((prev) => {
      if (prev.some((r) => r.sourceName.trim() === item.sourceName)) return prev;
      return [
        ...prev,
        {
          id: restoredId,
          sourceName: item.sourceName,
          defaultTarget: orig?.defaultTarget || '',
          targetName: orig?.targetName || orig?.defaultTarget || '',
          speakerIds: orig ? [...orig.speakerIds] : [],
          aliases: orig ? orig.aliases.map((a) => ({ ...a })) : [],
          gender: orig?.gender || 'unknown',
          note: orig?.note || '',
          occurrences: item.occurrences,
          samples: [...item.samples],
        },
      ];
    });
    setLiveAnnouncement(`已将「${item.sourceName}」恢复为出场角色。`);
    requestAnimationFrame(() => {
      inputRefs.current.get(`tgt:${restoredId}`)?.focus();
    });
  };

  const handleResetDefaults = () => {
    setRows(toEditableRows(form));
    setExcludedRows([...(form.excludedItems || [])]);
    setTouchedFields(new Set());
    setHasAttemptedSubmit(false);
    setSubmitError(null);
    setLiveAnnouncement('已恢复为默认建议译名。');
  };

  const toggleExpandRow = (rowId: string) => {
    setExpandedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const handleAddAlias = (rowId: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId ? { ...r, aliases: [...r.aliases, { source: '', target: '' }] } : r
      )
    );
  };

  const handleUpdateAlias = (
    rowId: string,
    aliasIndex: number,
    field: 'source' | 'target',
    value: string
  ) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r;
        const nextAliases = r.aliases.map((a, idx) =>
          idx === aliasIndex ? { ...a, [field]: value } : a
        );
        return { ...r, aliases: nextAliases };
      })
    );
  };

  const handleRemoveAlias = (rowId: string, aliasIndex: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === rowId ? { ...r, aliases: r.aliases.filter((_, idx) => idx !== aliasIndex) } : r
      )
    );
  };

  const executeSubmit = async (autoContinue: boolean) => {
    if (isSubmitting) return;
    setHasAttemptedSubmit(true);
    setSubmitError(null);

    if (rows.length === 0 && excludedRows.length === 0) {
      const msg = '至少需要保留一位角色或确认已排除的非角色项才能提交。';
      setSubmitError(msg);
      setLiveAnnouncement(msg);
      return;
    }

    let firstInvalidKey: string | null = null;
    let firstInvalidMessage = '';
    for (const row of rows) {
      const v = validateRow(row, rows);
      if (v.sourceError && !firstInvalidKey) {
        firstInvalidKey = `src:${row.id}`;
        firstInvalidMessage = v.sourceError;
      } else if (v.targetError && !firstInvalidKey) {
        firstInvalidKey = `tgt:${row.id}`;
        firstInvalidMessage = `${row.sourceName || '角色'}：${v.targetError}`;
      }
    }

    if (firstInvalidKey) {
      setFilterQuery('');
      setSubmitError(firstInvalidMessage);
      setLiveAnnouncement(firstInvalidMessage);
      requestAnimationFrame(() => {
        inputRefs.current.get(firstInvalidKey!)?.focus();
      });
      return;
    }

    const itemsPayload: SubmitChatFormItemPayload[] = rows.map((r) => ({
      id: r.id,
      sourceName: r.sourceName.trim(),
      targetName: r.targetName.trim(),
      speakerIds: r.speakerIds,
      aliases: r.aliases
        .map((a) => ({ source: a.source.trim(), target: a.target.trim() }))
        .filter((a) => a.source && a.target),
      gender: r.gender,
      ...(r.note.trim() ? { note: r.note.trim() } : {}),
    }));
    const dismissedNames = excludedRows.map((e) => e.sourceName.trim()).filter(Boolean);

    setIsSubmitting(true);
    try {
      await onSubmitForm(form.formId, {
        items: itemsPayload,
        ...(dismissedNames.length ? { dismissedNames } : {}),
        autoContinue,
      });
      setIsReediting(false);
      setLiveAnnouncement(
        autoContinue
          ? itemsPayload.length > 0
            ? `已锁定 ${itemsPayload.length} 位角色译名并通知 Paper Cup 开始翻译。`
            : `已确认无出场角色（排除 ${dismissedNames.length} 项非角色条目）并通知 Paper Cup 开始翻译。`
          : `已保存并锁定 ${itemsPayload.length} 位角色译名。`
      );
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : '提交角色译名表单失败';
      setSubmitError(msg);
      setLiveAnnouncement(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const shouldAutoContinue = form.status === 'pending' && !isTurnBusy;
    void executeSubmit(shouldAutoContinue);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.keyCode === 229)) {
      e.preventDefault();
    }
  };

  const handleCancel = async () => {
    if (!onCancelForm || isCancelling || isSubmitting) return;
    setIsCancelling(true);
    setSubmitError(null);
    try {
      await onCancelForm(form.formId);
      setLiveAnnouncement('已取消该角色确认表单。');
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : '取消表单失败';
      setSubmitError(msg);
      setLiveAnnouncement(msg);
    } finally {
      setIsCancelling(false);
    }
  };

  const statusBadge =
    form.status === 'submitted' ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-ok/35 bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok">
        <Lock className="size-3" aria-hidden="true" />
        <span>已锁定</span>
      </span>
    ) : form.status === 'superseded' ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-well px-2 py-0.5 text-[11px] font-medium text-ink-3">
        <span>已被新表单替代</span>
      </span>
    ) : form.status === 'cancelled' ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-well px-2 py-0.5 text-[11px] font-medium text-ink-3">
        <span>已取消</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-full border border-string/35 bg-string-soft px-2 py-0.5 text-[11px] font-medium text-string-ink">
        <Sparkles className="size-3" aria-hidden="true" />
        <span>待确认</span>
      </span>
    );

  // Compact read-only view for submitted / superseded / cancelled cards
  if (!isEditable) {
    const lockedItems = form.items;
    const previewLimit = 12;
    const displayed = showAllLocked ? lockedItems : lockedItems.slice(0, previewLimit);

    return (
      <section
        aria-labelledby={headingId}
        className="mt-3 overflow-hidden rounded-2xl border border-line-strong bg-surface-raised shadow-[var(--shadow-card)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Users className="size-4 shrink-0 text-string-ink" aria-hidden="true" />
            <h3 id={headingId} className="truncate text-sm font-semibold text-ink">
              {form.title || '角色译名确认表'}
            </h3>
            {statusBadge}
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <span>共 {lockedItems.length} 位</span>
            {form.status === 'submitted' && form.summary && form.summary.editedCount > 0 && (
              <span>· 修改 {form.summary.editedCount} 项</span>
            )}
            {form.status === 'submitted' && (
              <button
                type="button"
                onClick={() => setIsReediting(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-sheet px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:border-string hover:text-string-ink cursor-pointer"
              >
                <Pencil className="size-3" aria-hidden="true" />
                <span>重新编辑</span>
              </button>
            )}
          </div>
        </div>

        {form.status === 'submitted' && lockedItems.length > 0 && (
          <div className="px-4 py-3">
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {displayed.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-line bg-sheet/80 px-2.5 py-1.5 text-xs"
                >
                  <span
                    className="min-w-0 truncate text-ink-2"
                    style={{ fontFamily: 'var(--font-editorial-jp)' }}
                    title={it.sourceName}
                  >
                    {it.sourceName}
                  </span>
                  <span className="shrink-0 text-ink-3" aria-hidden="true">
                    →
                  </span>
                  <span className="min-w-0 truncate font-medium text-ink" title={it.targetName}>
                    {it.targetName}
                    {it.gender !== 'unknown' && (
                      <span className="ml-1 text-[10px] font-normal text-ink-3">
                        ({GENDER_LABEL_MAP[it.gender]})
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {lockedItems.length > previewLimit && (
              <button
                type="button"
                onClick={() => setShowAllLocked((v) => !v)}
                className="mt-2.5 text-xs font-medium text-string-ink hover:underline cursor-pointer"
              >
                {showAllLocked
                  ? '收起部分角色'
                  : `展开全部 ${lockedItems.length} 位已锁定角色`}
              </button>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="mt-3 overflow-hidden rounded-2xl border border-string/40 bg-surface-raised shadow-[var(--shadow-card)]"
    >
      <div className="visually-hidden" aria-live="polite" role="status">
        {liveAnnouncement}
      </div>

      {/* Card Header */}
      <div className="border-b border-line bg-sheet/70 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Users className="size-4 shrink-0 text-string-ink" aria-hidden="true" />
            <h3 id={headingId} className="truncate text-sm font-semibold text-ink">
              {form.title || '角色译名确认表'}
            </h3>
            {statusBadge}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span>共 {rows.length} 位角色</span>
            {editedCount > 0 && (
              <span className="rounded-full bg-string-soft px-2 py-0.5 font-medium text-string-ink">
                已修改 {editedCount} 项
              </span>
            )}
            {editedCount > 0 && (
              <button
                type="button"
                onClick={handleResetDefaults}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-well hover:text-ink cursor-pointer"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                <span>恢复默认</span>
              </button>
            )}
          </div>
        </div>
        {form.description && (
          <p className="mt-1.5 text-xs leading-5 text-ink-2">{form.description}</p>
        )}

        {/* Filter toolbar in semantic <search> landmark (outside <form> so Enter never submits) */}
        {rows.length >= 6 && (
          <search className="mt-2.5">
            <label htmlFor={searchInputId} className="visually-hidden">
              按角色原名、译名或备注筛选
            </label>
            <div className="relative flex items-center">
              <Search
                className="pointer-events-none absolute left-2.5 size-3.5 text-ink-3"
                aria-hidden="true"
              />
              <input
                id={searchInputId}
                type="search"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="筛选角色原名、译名或备注…"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
                className="w-full rounded-xl border border-line-strong bg-surface-raised py-1.5 pr-3 pl-8 text-xs text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string"
              />
            </div>
          </search>
        )}
      </div>

      {/* Main Editable Form */}
      <form
        method="POST"
        action={`/api/vn/forms/${encodeURIComponent(form.formId)}/submit`}
        aria-labelledby={headingId}
        onSubmit={handleFormSubmit}
        noValidate
      >
        <div className="pc-scroller max-h-[26rem] divide-y divide-line overflow-y-auto px-4 py-1">
          {visibleRows.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-3">
              没有匹配「{filterQuery}」的角色。
            </div>
          ) : (
            visibleRows.map((row) => {
              const validation = validateRow(row, rows);
              const srcKey = `src:${row.id}`;
              const tgtKey = `tgt:${row.id}`;
              const showSrcError = Boolean(
                validation.sourceError && (hasAttemptedSubmit || touchedFields.has(srcKey))
              );
              const showTgtError = Boolean(
                validation.targetError && (hasAttemptedSubmit || touchedFields.has(tgtKey))
              );
              const srcErrorId = `${baseId}-err-src-${row.id}`;
              const tgtErrorId = `${baseId}-err-tgt-${row.id}`;
              const srcInputId = `${baseId}-in-src-${row.id}`;
              const tgtInputId = `${baseId}-in-tgt-${row.id}`;
              const genderSelectId = `${baseId}-gender-${row.id}`;
              const noteInputId = `${baseId}-note-${row.id}`;
              const isExpanded = expandedRowIds.has(row.id);
              const isEdited = !row.isCustom && row.targetName.trim() !== row.defaultTarget.trim();
              const hasExtraDetails =
                row.samples.length > 0 || row.aliases.length > 0 || Boolean(row.note);

              return (
                <div key={row.id} className="py-2.5">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_auto] sm:items-start">
                    {/* Source Name Column */}
                    <div className="min-w-0">
                      {row.isCustom ? (
                        <div>
                          <label
                            htmlFor={srcInputId}
                            className="mb-1 block text-[11px] font-medium text-ink-2"
                          >
                            角色原名 <span aria-hidden="true">*</span>
                          </label>
                          <input
                            ref={(el) => {
                              if (el) inputRefs.current.set(srcKey, el);
                              else inputRefs.current.delete(srcKey);
                            }}
                            id={srcInputId}
                            name={`source_${row.id}`}
                            type="text"
                            required
                            value={row.sourceName}
                            onChange={(e) => updateRow(row.id, { sourceName: e.target.value })}
                            onBlur={() => markFieldTouched(srcKey)}
                            onKeyDown={handleInputKeyDown}
                            placeholder="例如：天野 雪乃"
                            spellCheck={false}
                            autoCorrect="off"
                            autoCapitalize="none"
                            aria-invalid={showSrcError ? 'true' : 'false'}
                            aria-describedby={showSrcError ? srcErrorId : undefined}
                            className={cn(
                              'w-full rounded-xl border bg-sheet px-2.5 py-1.5 text-sm text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string',
                              showSrcError
                                ? 'border-danger bg-danger-soft/45'
                                : 'border-line-strong hover:border-field'
                            )}
                          />
                          {showSrcError && (
                            <p
                              id={srcErrorId}
                              className="mt-1 flex items-center gap-1 text-[11px] text-danger"
                            >
                              <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
                              <span>{validation.sourceError}</span>
                            </p>
                          )}
                        </div>
                      ) : (
                        <div className="pt-0.5">
                          <label
                            htmlFor={tgtInputId}
                            className="block text-sm font-medium text-ink"
                            style={{ fontFamily: 'var(--font-editorial-jp)' }}
                          >
                            {row.sourceName}
                          </label>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                            {row.occurrences > 0 && <span>出场 {row.occurrences} 次</span>}
                            {row.speakerIds
                              .filter((id) => id !== row.sourceName)
                              .slice(0, 2)
                              .map((id) => (
                                <span
                                  key={id}
                                  className="rounded bg-well px-1.5 py-0.2 font-mono text-[10px] text-ink-2"
                                >
                                  {id}
                                </span>
                              ))}
                            {row.aliases.length > 0 && (
                              <span className="text-ink-3">· {row.aliases.length} 个别名</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Editable Target Name Column */}
                    <div className="min-w-0">
                      <label
                        htmlFor={tgtInputId}
                        className={cn(
                          'mb-1 block text-[11px] font-medium text-ink-2',
                          !row.isCustom && 'sm:sr-only'
                        )}
                      >
                        {row.sourceName ? `${row.sourceName} 的中文译名` : '中文译名'}{' '}
                        <span aria-hidden="true">*</span>
                      </label>
                      <div className="relative flex items-center">
                        <input
                          ref={(el) => {
                            if (el) inputRefs.current.set(tgtKey, el);
                            else inputRefs.current.delete(tgtKey);
                          }}
                          id={tgtInputId}
                          name={`target_${row.id}`}
                          type="text"
                          required
                          value={row.targetName}
                          onChange={(e) => updateRow(row.id, { targetName: e.target.value })}
                          onBlur={() => markFieldTouched(tgtKey)}
                          onKeyDown={handleInputKeyDown}
                          placeholder="输入固定中文译名"
                          spellCheck={false}
                          autoCorrect="off"
                          autoCapitalize="none"
                          enterKeyHint="next"
                          aria-invalid={showTgtError ? 'true' : 'false'}
                          aria-describedby={showTgtError ? tgtErrorId : undefined}
                          className={cn(
                            'w-full rounded-xl border bg-sheet px-2.5 py-1.5 text-sm text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string',
                            isEdited && 'pr-11',
                            showTgtError
                              ? 'border-danger bg-danger-soft/45'
                              : isEdited
                                ? 'border-string/55'
                                : 'border-line-strong hover:border-field'
                          )}
                        />
                        {isEdited && (
                          <span className="pointer-events-none absolute right-2 rounded bg-string-soft px-1.5 py-0.5 text-[10px] font-medium text-string-ink">
                            已改
                          </span>
                        )}
                      </div>
                      {showTgtError && (
                        <p
                          id={tgtErrorId}
                          className="mt-1 flex items-center gap-1 text-[11px] text-danger"
                        >
                          <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
                          <span>{validation.targetError}</span>
                        </p>
                      )}
                    </div>

                    {/* Gender + Details Toggle */}
                    <div className="flex items-center gap-1.5 sm:pt-0.5">
                      <label htmlFor={genderSelectId} className="visually-hidden">
                        {row.sourceName || '角色'} 性别
                      </label>
                      <select
                        id={genderSelectId}
                        name={`gender_${row.id}`}
                        value={row.gender}
                        onChange={(e) =>
                          updateRow(row.id, { gender: e.target.value as CharacterGender })
                        }
                        className="rounded-xl border border-line-strong bg-sheet px-2 py-1.5 text-xs text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string cursor-pointer"
                      >
                        {GENDER_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        onClick={() => toggleExpandRow(row.id)}
                        aria-expanded={isExpanded}
                        title="别名、备注与台词样本"
                        className={cn(
                          'inline-flex items-center gap-0.5 rounded-xl border px-2 py-1.5 text-xs transition-colors cursor-pointer',
                          isExpanded || hasExtraDetails
                            ? 'border-line-strong bg-well/80 text-ink-2 hover:text-ink'
                            : 'border-transparent text-ink-3 hover:bg-well hover:text-ink-2'
                        )}
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="size-3.5" aria-hidden="true" />
                        )}
                        <span className="hidden sm:inline">详情</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDismissOrRemoveRow(row)}
                        title={row.isCustom ? '移除新增角色' : '标为非角色并排除（不写入术语表）'}
                        aria-label={
                          row.isCustom
                            ? `移除新增角色 ${row.sourceName || ''}`
                            : `排除非角色项 ${row.sourceName || ''}`
                        }
                        className="rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger cursor-pointer"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {/* Expanded Row Details: Note, Aliases, Sample Dialogue */}
                  {isExpanded && (
                    <div className="mt-2.5 space-y-2.5 rounded-xl border border-line bg-sheet/75 p-3 text-xs">
                      <div>
                        <label
                          htmlFor={noteInputId}
                          className="mb-1 block text-[11px] font-medium text-ink-2"
                        >
                          人设 / 称呼备注（可选）
                        </label>
                        <input
                          id={noteInputId}
                          name={`note_${row.id}`}
                          type="text"
                          value={row.note}
                          onChange={(e) => updateRow(row.id, { note: e.target.value })}
                          onKeyDown={handleInputKeyDown}
                          placeholder="例如：女主角，青梅竹马，称主角为「前辈」"
                          className="w-full rounded-lg border border-line-strong bg-surface-raised px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-string"
                        />
                      </div>

                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[11px] font-medium text-ink-2">
                            姓 / 名 / 昵称固定映射（自动同步术语表）
                          </span>
                          <button
                            type="button"
                            onClick={() => handleAddAlias(row.id)}
                            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-string-ink hover:underline cursor-pointer"
                          >
                            <Plus className="size-3" aria-hidden="true" />
                            <span>添加别名</span>
                          </button>
                        </div>
                        {row.aliases.length === 0 ? (
                          <p className="text-[11px] text-ink-3">
                            暂无别名；如需同时锁定单姓、单名或外号，可点击「添加别名」。
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            {row.aliases.map((alias, aIdx) => (
                              <div key={aIdx} className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  aria-label="别名原文"
                                  value={alias.source}
                                  onChange={(e) =>
                                    handleUpdateAlias(row.id, aIdx, 'source', e.target.value)
                                  }
                                  onKeyDown={handleInputKeyDown}
                                  placeholder="原文简称"
                                  spellCheck={false}
                                  className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-raised px-2 py-1 text-xs text-ink"
                                />
                                <span className="text-ink-3" aria-hidden="true">
                                  →
                                </span>
                                <input
                                  type="text"
                                  aria-label="别名译文"
                                  value={alias.target}
                                  onChange={(e) =>
                                    handleUpdateAlias(row.id, aIdx, 'target', e.target.value)
                                  }
                                  onKeyDown={handleInputKeyDown}
                                  placeholder="固定译文"
                                  spellCheck={false}
                                  className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-raised px-2 py-1 text-xs text-ink"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleRemoveAlias(row.id, aIdx)}
                                  aria-label="删除别名"
                                  className="rounded p-1 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                                >
                                  <X className="size-3" aria-hidden="true" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {row.samples.length > 0 && (
                        <div>
                          <div className="mb-1 text-[11px] font-medium text-ink-2">原文台词样本</div>
                          <ul className="space-y-1 text-[11px] text-ink-3">
                            {row.samples.map((s, sIdx) => (
                              <li
                                key={sIdx}
                                className="rounded-lg bg-well/70 px-2 py-1 text-ink-2"
                                style={{ fontFamily: 'var(--font-editorial-jp)' }}
                              >
                                {s}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Excluded Non-Character Candidates */}
        {excludedRows.length > 0 && (
          <div className="border-t border-line bg-sheet/45 px-4 py-2.5 text-xs">
            <button
              type="button"
              onClick={() => setShowExcluded((v) => !v)}
              aria-expanded={showExcluded}
              className="flex w-full items-center justify-between text-left text-ink-2 hover:text-ink cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5 font-medium">
                {showExcluded ? (
                  <ChevronDown className="size-3.5 text-ink-3" aria-hidden="true" />
                ) : (
                  <ChevronRight className="size-3.5 text-ink-3" aria-hidden="true" />
                )}
                <span>已排除的非角色候选（{excludedRows.length} 项，不写入角色名册与术语表）</span>
              </span>
              <span className="text-[11px] text-ink-3">{showExcluded ? '收起' : '查看/恢复'}</span>
            </button>
            {showExcluded && (
              <div className="mt-2 max-h-[180px] space-y-1.5 overflow-y-auto pr-1">
                {excludedRows.map((ex) => (
                  <div
                    key={ex.sourceName}
                    className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-raised/80 px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <span
                        className="font-medium text-ink"
                        style={{ fontFamily: 'var(--font-editorial-jp)' }}
                      >
                        {ex.sourceName}
                      </span>
                      {ex.reason && (
                        <span className="ml-2 text-[11px] text-ink-3">（{ex.reason}）</span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRestoreExcluded(ex)}
                      className="shrink-0 rounded-lg border border-line-strong bg-sheet px-2 py-0.5 text-[11px] font-medium text-ink-2 transition-colors hover:border-string hover:text-ink cursor-pointer"
                    >
                      恢复为角色
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="border-t border-line bg-sheet/70 px-4 py-3">
          {submitError && (
            <div
              role="alert"
              className="mb-2.5 flex items-start gap-2 rounded-xl border border-danger/35 bg-danger-soft px-3 py-2 text-xs text-danger"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleAddCustomRow}
                className="inline-flex items-center gap-1 rounded-xl border border-line-strong bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-field hover:text-ink cursor-pointer"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                <span>新增角色</span>
              </button>
              {form.status === 'pending' && onCancelForm && (
                <button
                  type="button"
                  disabled={isCancelling || isSubmitting}
                  onClick={() => void handleCancel()}
                  className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-medium text-ink-3 transition-colors hover:bg-well hover:text-ink-2 disabled:opacity-50 cursor-pointer"
                >
                  <span>取消</span>
                </button>
              )}
              {isReediting && (
                <button
                  type="button"
                  onClick={() => {
                    setRows(toEditableRows(form));
                    setIsReediting(false);
                    setSubmitError(null);
                  }}
                  className="inline-flex items-center gap-1 rounded-xl px-2.5 py-1.5 text-xs font-medium text-ink-3 transition-colors hover:bg-well hover:text-ink-2 cursor-pointer"
                >
                  <span>放弃修改</span>
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {form.status === 'pending' && (
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => void executeSubmit(false)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-string hover:text-ink disabled:opacity-50 cursor-pointer"
                >
                  <Lock className="size-3.5" aria-hidden="true" />
                  <span>仅保存锁定</span>
                </button>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-1.5 rounded-xl bg-string px-3.5 py-1.5 text-xs font-semibold text-on-string shadow-sm transition-opacity hover:opacity-92 disabled:opacity-55 cursor-pointer"
              >
                <Check className="size-3.5" aria-hidden="true" />
                <span>
                  {isSubmitting
                    ? '提交锁定中…'
                    : isReediting
                      ? '更新已锁定译名'
                      : rows.length === 0
                        ? isTurnBusy
                          ? '确认无出场角色并保存'
                          : '确认无出场角色并开始翻译'
                        : isTurnBusy
                          ? '保存并锁定译名'
                          : '确认译名并开始翻译'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
