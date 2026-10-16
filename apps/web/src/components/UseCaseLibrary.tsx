import { ArrowRight, BookOpen, Box, MessageSquare, X } from 'lucide-react';
import { useState } from 'react';
import { USE_CASES, type UseCase, type UseCaseArea } from '@crmagents/shared';

// The use-case library: proven jobs for CRM agents. Picking one hands its request to the AI builder, which
// adapts it to this org's objects and fields.

const AREAS: ('All' | UseCaseArea)[] = ['All', 'Service', 'Sales', 'Operations', 'Leadership'];
const NEEDS: Record<NonNullable<UseCase['needs']>[number], { label: string; icon: JSX.Element }> = {
  knowledge: { label: 'Uses your guides', icon: <BookOpen size={12} /> },
  package: { label: 'Shows in Salesforce', icon: <Box size={12} /> },
  slack: { label: 'Posts to Slack', icon: <MessageSquare size={12} /> },
};

export function UseCaseLibrary({ onPick, onTemplates, onClose }: { onPick: (request: string) => void; onTemplates: () => void; onClose: () => void }) {
  const [area, setArea] = useState<(typeof AREAS)[number]>('All');
  const list = USE_CASES.filter((u) => area === 'All' || u.area === area);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card uc-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-labelledby="uc-title">
        <div className="modal-head">
          <div>
            <h3 id="uc-title" style={{ margin: 0 }}>Use cases</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>Jobs teams most often give to CRM agents. Pick one: the builder fits it to your fields, you check it, and nothing runs until you turn it on.</p>
          </div>
          <button className="ghost icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="seg uc-areas" role="tablist" aria-label="Area">
          {AREAS.map((a) => <button key={a} role="tab" aria-selected={area === a} className={area === a ? 'on' : ''} onClick={() => setArea(a)}>{a}</button>)}
        </div>
        <div className="uc-grid">
          {list.map((u) => (
            <button key={u.id} className="uc" onClick={() => onPick(u.request)}>
              <span className="uc-area">{u.area}</span>
              <b>{u.title}</b>
              <span className="uc-problem">{u.problem}</span>
              <span className="uc-foot">
                <span className="uc-cost" title="Typical AI cost per run">{u.cost} / run</span>
                {u.needs?.map((n) => <span key={n} className="uc-need" title={NEEDS[n].label}>{NEEDS[n].icon}{NEEDS[n].label}</span>)}
                <span className="uc-go">Build <ArrowRight size={13} /></span>
              </span>
            </button>
          ))}
        </div>
        <div className="uc-more"><button className="link-btn" onClick={onTemplates}>Or start from a blank canvas or a fixed template</button></div>
      </div>
    </div>
  );
}
