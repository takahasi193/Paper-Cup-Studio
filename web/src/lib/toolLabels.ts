import type { ToolCallItem } from '@/hooks/useAgentStream.js';
import type { TranslatorMode } from '@/lib/api.js';

const TOOL_LABELS: Record<string, string> = {
  bash: '终端命令',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  ls: '列出目录',
  find: '查找文件',
  grep: '搜索文本',
  vn_detect: '识别引擎',
  vn_status: '本地化状态',
  vn_unpack: '解包',
  vn_classify: '脚本分轨',
  vn_extract_roster: '提取角色名册',
  vn_request_character_confirmation: '发送角色译名确认表单',
  vn_qa: '确定性 QA',
  vn_apply: '写回译文',
  vn_repack: '重新封包',
  vn_accept: '验收门禁',
  vn_release: '发布说明',
  vn_learn_skill: '学习引擎技能',
  vn_promote_skill: '推广引擎技能',
  vn_plan: '规划批次',
  vn_checkpoint: 'Git 检查点',
  vn_merge: '合并批次并 QA',
  vn_writeback: '生成汉化补丁',
  vn_smoke_test: '补丁冒烟测试',
  vn_translate_batches: '批量翻译',
  vn_post_qa_parallel: '并行 QA 与角色审校',
  delegate_task: '委派子代理',
  create_subagent: '创建子代理',
};

export function getToolDisplayLabel(tool: string, args?: unknown): string {
  if (tool === 'delegate_task' && args && typeof args === 'object') {
    const role = (args as Record<string, unknown>).role;
    if (typeof role === 'string' && role.trim()) {
      return `委派子代理 · ${role.trim()}`;
    }
  }
  return TOOL_LABELS[tool] ?? tool;
}

export interface ActiveSubagentRolesOptions {
  translatorMode?: TranslatorMode;
}

export function getActiveSubagentRoles(
  tools: ToolCallItem[],
  options?: ActiveSubagentRolesOptions
): Set<string> {
  const active = new Set<string>();
  for (const t of tools) {
    const isRunning = t.result === undefined || t.result === null;
    if (!isRunning) continue;
    const argsObj =
      t.args && typeof t.args === 'object' ? (t.args as Record<string, unknown>) : null;
    if (t.tool === 'delegate_task' && argsObj) {
      const role = argsObj.role;
      if (typeof role === 'string' && role.trim()) {
        active.add(role.trim());
      }
    } else if (t.tool === 'vn_translate_batches') {
      if (options?.translatorMode !== 'local_mt') {
        active.add('translator');
      }
    } else if (t.tool === 'vn_post_qa_parallel') {
      const skipRoleChecker =
        argsObj?.skipRoleChecker === true || argsObj?.skip_role_checker === true;
      if (!skipRoleChecker) {
        active.add('role-checker');
      }
    }
  }
  return active;
}
