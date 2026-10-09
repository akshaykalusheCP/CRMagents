import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { CheckCircle2, PauseCircle, XCircle } from 'lucide-react';
import { NODE_DEF_BY_TYPE, outputHandles } from '@crmagents/shared';
import { NodeTile } from './nodeIcons';

export type NodeData = {
  type: string;
  label?: string;
  config: Record<string, any>;
  status?: 'ok' | 'error' | 'waiting' | 'skipped' | 'running';
} & Record<string, unknown>;
export type WFRFNode = Node<NodeData, 'card'>;

function summary(d: NodeData): string {
  const def = NODE_DEF_BY_TYPE[d.type];
  for (const f of def?.fields ?? []) {
    if (f.key === 'model' || f.key === 'effort') continue;
    const v = d.config[f.key];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 80);
    if (Array.isArray(v) && v.length) return v.join(', ');
  }
  return '';
}

const STATUS = {
  ok: <CheckCircle2 size={18} color="var(--ok)" fill="var(--surface)" />,
  error: <XCircle size={18} color="var(--danger)" fill="var(--surface)" />,
  waiting: <PauseCircle size={18} color="var(--warn)" fill="var(--surface)" />,
};

export function WorkflowNode({ data, selected }: NodeProps<WFRFNode>) {
  const def = NODE_DEF_BY_TYPE[data.type];
  if (!def) return <div className="wfnode"><div className="node-head">Unknown block {data.type}</div></div>;
  const handles = outputHandles(data.type);
  const multi = handles.length > 1;
  const sub = summary(data);
  const status = data.status && data.status in STATUS ? STATUS[data.status as keyof typeof STATUS] : null;
  return (
    <div className={`wfnode${selected ? ' sel' : ''}${data.status ? ' st-' + data.status : ''}`}>
      {status && <span className="node-status">{status}</span>}
      {def.category !== 'Trigger' && <Handle type="target" position={Position.Left} />}
      <div className="node-head">
        <NodeTile type={data.type} />
        <div style={{ minWidth: 0 }}>
          <div className="node-title">{data.label || def.label}</div>
          <div className="node-type">{data.label ? def.label : def.category}</div>
        </div>
      </div>
      {sub && <div className="node-sub" title={sub}>{sub}</div>}
      {handles.map((h, i) => {
        const top = multi ? `${((i + 1) * 100) / (handles.length + 1)}%` : '50%';
        return (
          <div key={h.id}>
            <Handle id={h.id} type="source" position={Position.Right} style={{ top }} />
            {multi && <span className="wf-hlabel" style={{ top }}>{h.label}</span>}
          </div>
        );
      })}
    </div>
  );
}
