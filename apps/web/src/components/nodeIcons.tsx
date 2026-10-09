import {
  Bot, Braces, CalendarClock, Cloud, Database, FileSearch, FilePlus2, FilePen, Flag, GitBranch, Globe, ListTodo,
  MessageSquare, Repeat, ScanText, ShieldCheck, Tags, Zap, type LucideIcon,
} from 'lucide-react';
import { CATEGORY_COLORS, NODE_DEF_BY_TYPE, type Category } from '@crmagents/shared';

export const NODE_ICONS: Record<string, LucideIcon> = {
  'trigger.manual': Zap,
  'trigger.salesforce': Cloud,
  'trigger.schedule': CalendarClock,
  'ai.agent': Bot,
  'ai.classify': Tags,
  'ai.extract': ScanText,
  'sf.query': Database,
  'sf.getRecord': FileSearch,
  'sf.createRecord': FilePlus2,
  'sf.updateRecord': FilePen,
  'sf.createTask': ListTodo,
  'logic.branch': GitBranch,
  'logic.loop': Repeat,
  'logic.approval': ShieldCheck,
  'http.request': Globe,
  'notify.slack': MessageSquare,
  'util.set': Braces,
  'util.output': Flag,
};

export function categoryOf(type: string): Category {
  return NODE_DEF_BY_TYPE[type]?.category ?? 'Utility';
}

/** Rounded colored square with the block's icon. */
export function NodeTile({ type, size = 'md' }: { type: string; size?: 'md' | 'lg' }) {
  const Icon = NODE_ICONS[type] ?? Braces;
  const color = CATEGORY_COLORS[categoryOf(type)];
  return (
    <span className={'tile' + (size === 'lg' ? ' lg' : '')} style={{ background: `${color}1f`, color }}>
      <Icon size={size === 'lg' ? 18 : 15} strokeWidth={2} />
    </span>
  );
}
